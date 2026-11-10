"""Tests for the board writer. Run: python3 -m unittest test_board.py"""
import glob
import importlib.util
import io
import json
import os
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("board_writer", os.path.join(os.path.dirname(__file__), "board.py"))
bw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bw)
HERE = os.path.dirname(os.path.abspath(__file__))


def text(path):
    with open(path) as f:
        return f.read()


def call(**kw):
    c = {"question": "Ship it?", "options": ["a. Send it out", "b. Refire"], "recommend": "a", "thread": "owner-1",
         "asked": "2026-11-05T13:40", "context": "The build is green."}
    c.update(kw)
    return c


def dish(did="REV-1", **kw):
    d = {"id": did, "outcome": "o", "close": None, "components": [{"station": "backend", "thread": "t1", "pr": 7}], "calls": []}
    d.update(kw)
    return d


class Validate(unittest.TestCase):
    def errors(self, board):
        return bw.validate(board)[0]

    def test_live_and_fixture_shapes_pass(self):
        with patch.object(bw._pass, "ART_ROOT", os.path.realpath(os.path.join(HERE, "fixtures", "art"))):
            with open(os.path.join(HERE, "fixtures", "board.json")) as f:
                self.assertEqual(self.errors(json.load(f)), [])
        self.assertEqual(self.errors({"service": None, "dishes": []}), [])

    def test_call_rules_from_the_spec_and_rulings(self):
        cases = {"context is required": call(context=""), "thread is required": call(thread=None),
                 "asked is required": call(asked=None), "matches no option": call(recommend="c"),
                 "at least two choices": call(options=["a. Only"]), "question is required": call(question=" ")}
        for want, c in cases.items():
            errs = self.errors({"dishes": [dish(calls=[c])]})
            self.assertTrue(any(want in x for x in errs), (want, errs))

    def test_dish_and_component_rules(self):
        cases = {"id is on the board twice": [dish(), dish()], "id is required": [dish(did="")],
                 "station must be one of": [dish(components=[{"station": "sauces"}])],
                 "pr must be a PR number": [dish(components=[{"station": "data", "pr": "12"}])],
                 "close must be": [dish(close="later")], "plated needs a receipt": [dish(plated={"at": "2026-11-05T10:00"})],
                 "same question twice": [dish(calls=[call(), call()])]}
        for want, dishes in cases.items():
            errs = self.errors({"dishes": dishes})
            self.assertTrue(any(want in x for x in errs), (want, errs))

    def test_a_time_the_pass_cannot_read_is_an_error(self):
        for bad in ("2026-11-05T13:40junk", "tomorrow"):
            errs = self.errors({"dishes": [dish(calls=[call(asked=bad)])]})
            self.assertTrue(any("must be a time" in x for x in errs), (bad, errs))
        self.assertEqual(self.errors({"dishes": [dish(calls=[call(asked="2026-11-05T22:02:09+0000")])]}), [])

    def test_malformed_ids_and_questions_are_errors_not_crashes(self):
        errs = self.errors({"dishes": [dish(did=["REV-1"]), dish(did={}), dish(did="REV-2", calls=[call(question=["q"])])]})
        self.assertTrue(any("id is required" in x for x in errs), errs)
        self.assertTrue(any("question is required" in x for x in errs), errs)

    def test_visual_field_must_be_a_boolean_and_silences_the_warning(self):
        web = [{"station": "website"}]
        errs, warns = bw.validate({"dishes": [dish(components=web, calls=[call(visual=False)])]})
        self.assertEqual(errs, [])
        self.assertFalse(any("flags it red" in w for w in warns), warns)
        errs = self.errors({"dishes": [dish(components=web, calls=[call(visual="no")])]})
        self.assertTrue(any("visual must be true or false" in x for x in errs), errs)
        _, warns = bw.validate({"dishes": [dish(calls=[call(visual=True)])]})  # a backend dish, a visual call
        self.assertTrue(any("flags it red" in w for w in warns), warns)

    def test_image_the_pass_cannot_show_is_an_error(self):
        errs = self.errors({"dishes": [dish(calls=[call(images=[{"path": "/etc/passwd"}])])]})
        self.assertTrue(any("cannot show image" in x for x in errs), errs)

    def test_typo_and_visual_without_images_are_warnings(self):
        errs, warns = bw.validate({"dishes": [dish(components=[{"station": "website", "thred": "x"}], calls=[call()])]})
        self.assertEqual(errs, [])
        self.assertTrue(any("unknown key 'thred'" in w for w in warns), warns)
        self.assertTrue(any("flags it red" in w for w in warns), warns)


class Write(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "board.json")
        with open(self.path, "w") as f:
            json.dump({"service": {"opened": "2026-11-05T09:00", "expoThread": "expo", "closed": None},
                       "dishes": [dish(calls=[call()])]}, f)

    def run_cli(self, *args, stdin=""):
        out = io.StringIO()
        code = bw.main(["--board", self.path] + list(args), stdin=io.StringIO(stdin), out=out)
        return code, out.getvalue()

    def board(self):
        with open(self.path) as f:
            return json.load(f)

    def test_invalid_change_writes_nothing_and_keeps_no_backup(self):
        before = text(self.path)
        code, out = self.run_cli("put", stdin=json.dumps(dish("REV-2", calls=[call(context="")])))
        self.assertEqual(code, 1)
        self.assertIn("not written", out)
        self.assertEqual(text(self.path), before)
        self.assertEqual(glob.glob(self.path + ".bak-*"), [])

    def test_put_appends_or_replaces_in_place_and_backs_up_the_old_file(self):
        before = text(self.path)
        self.assertEqual(self.run_cli("put", stdin=json.dumps(dish("REV-2")))[0], 0)
        self.assertEqual([d["id"] for d in self.board()["dishes"]], ["REV-1", "REV-2"])
        self.assertEqual(self.run_cli("put", stdin=json.dumps(dish("REV-1", outcome="new")))[0], 0)
        self.assertEqual([(d["id"], d["outcome"]) for d in self.board()["dishes"]], [("REV-1", "new"), ("REV-2", "o")])
        backups = sorted(glob.glob(self.path + ".bak-*"))
        self.assertEqual(len(backups), 2)  # one per write, even within one second
        self.assertIn(before, [text(b) for b in backups])
        self.assertEqual(glob.glob(os.path.join(self.dir, ".board-*")), [])  # no temp file left behind
        for b in backups:
            self.assertEqual(os.stat(b).st_mode & 0o777, 0o600, b)  # owner-only, like the saved board

    def test_drop_call_takes_the_answer_id_from_the_pass(self):
        d = self.board()["dishes"][0]
        key = bw._pass.call_key(d, d["calls"][0])
        self.assertEqual(self.run_cli("drop-call", "REV-1", "000000000000")[0], 1)
        self.assertEqual(self.run_cli("drop-call", "REV-1", key)[0], 0)
        self.assertEqual(self.board()["dishes"][0]["calls"], [])

    def test_plate_refuses_while_a_call_waits_then_records_receipt_and_time(self):
        code, out = self.run_cli("plate", "REV-1", "https://example.com/receipt")
        self.assertEqual(code, 1)
        self.assertIn("still has calls", out)
        d = self.board()["dishes"][0]
        self.run_cli("drop-call", "REV-1", bw._pass.call_key(d, d["calls"][0]))
        self.assertEqual(self.run_cli("plate", "REV-1", "https://example.com/receipt")[0], 0)
        self.assertEqual(self.board()["dishes"][0]["plated"]["receipt"], "https://example.com/receipt")

    def test_plating_marks_the_chefs_look_and_the_receipt_clears_it(self):
        self.assertEqual(self.run_cli("plating", "REV-9")[0], 1)  # no such dish
        self.assertEqual(self.run_cli("plating", "REV-1")[0], 0)
        self.assertIn("at", self.board()["dishes"][0]["plating"])
        self.assertEqual(self.run_cli("plating", "REV-1", "off")[0], 0)
        self.assertNotIn("plating", self.board()["dishes"][0])
        self.run_cli("plating", "REV-1")
        d = self.board()["dishes"][0]
        self.run_cli("drop-call", "REV-1", bw._pass.call_key(d, d["calls"][0]))
        self.run_cli("plate", "REV-1", "https://example.com/receipt")
        self.assertNotIn("plating", self.board()["dishes"][0])
        code, out = self.run_cli("plating", "REV-1")
        self.assertEqual(code, 1)
        self.assertIn("already has its receipt", out)

    def test_plating_must_carry_a_time(self):
        code, out = self.run_cli("put", stdin=json.dumps(dish("REV-2", plating={"when": "x"})))
        self.assertEqual(code, 1)
        self.assertIn("plating", out)

    def test_put_cannot_plate_a_dish_with_a_waiting_call(self):
        plated = dish("REV-1", calls=[call()], plated={"receipt": "https://example.com/r", "at": "2026-11-05T10:00"})
        code, out = self.run_cli("put", stdin=json.dumps(plated))
        self.assertEqual(code, 1)
        self.assertIn("plated dish cannot have calls", out)
        self.assertNotIn("plated", self.board()["dishes"][0])

    def test_service_close_needs_every_open_dish_resolved(self):
        code, out = self.run_cli("service", "close")
        self.assertEqual(code, 1)
        self.assertIn("REV-1", out)
        b = self.board()
        b["dishes"][0]["close"] = "carry"
        self.run_cli("put", stdin=json.dumps(b["dishes"][0]))
        self.assertEqual(self.run_cli("service", "open", "expo-x")[0], 1)  # reopening would skip invariant 4
        self.assertEqual(self.run_cli("service", "expo", "expo-b")[0], 0)  # an ATC handoff keeps the service
        self.assertEqual(self.board()["service"]["expoThread"], "expo-b")
        self.assertEqual(self.run_cli("service", "close")[0], 0)
        self.assertTrue(self.board()["service"]["closed"])
        self.assertEqual(self.run_cli("service", "expo", "expo-c")[0], 1)
        code, out = self.run_cli("service", "close")  # already closed: say so, not "dishes need a close"
        self.assertEqual(code, 1)
        self.assertIn("no open service", out)
        self.assertEqual(self.run_cli("service", "open", "expo-2")[0], 0)
        self.assertEqual(self.board()["service"]["expoThread"], "expo-2")

    def test_unknown_dish_and_bad_json_are_refused(self):
        self.assertEqual(self.run_cli("drop", "REV-404")[0], 1)
        self.assertEqual(self.run_cli("put", stdin="{nope")[0], 1)
        self.assertEqual(self.run_cli("bogus")[0], 2)

    def test_a_mistyped_board_path_is_refused_and_nothing_is_created(self):
        wrong = os.path.join(self.dir, "bord.json")
        out = io.StringIO()
        self.assertEqual(bw.main(["--board", wrong, "put"], stdin=io.StringIO(json.dumps(dish("REV-2"))), out=out), 1)
        self.assertIn("no board at", out.getvalue())
        self.assertFalse(os.path.exists(wrong))
        self.assertFalse(os.path.exists(wrong + ".lock"))
        self.assertEqual(bw.main(["--board", wrong, "check"], out=io.StringIO()), 1)
        nowhere = os.path.join(self.dir, "no-such-folder", "board.json")
        out = io.StringIO()
        self.assertEqual(bw.main(["--board", nowhere, "service", "open", "expo"], out=out), 1)
        self.assertIn("not written", out.getvalue())
        self.assertEqual(bw.main(["--board", wrong, "service", "open", "expo"], out=io.StringIO()), 0)  # the one way to start a board
        self.assertTrue(os.path.exists(wrong))

    def test_a_hand_broken_board_is_an_error_not_a_crash(self):
        with open(self.path, "w") as f:
            json.dump({"service": {"opened": "2026-11-05T09:00"}, "dishes": ["x", dish("REV-1", calls="x")]}, f)
        for args in (["service", "close"], ["plate", "REV-1", "r"], ["check"],
                     ["put"]):
            code, out = self.run_cli(*args, stdin=json.dumps(dish("REV-3", components=["x"])))
            self.assertEqual(code, 1, (args, out))
            self.assertNotIn("Traceback", out)

    def test_check_reports_and_exits_nonzero_on_a_broken_board(self):
        self.assertEqual(self.run_cli("check")[0], 0)
        with open(self.path, "w") as f:
            json.dump({"dishes": [dish(close="later")]}, f)
        code, out = self.run_cli("check")
        self.assertEqual(code, 1)
        self.assertIn("invalid", out)

    def test_concurrent_writers_lose_no_update(self):
        def add(n):
            self.run_cli("put", stdin=json.dumps(dish("REV-%d" % (100 + n))))
        threads = [threading.Thread(target=add, args=(n,)) for n in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        ids = {d["id"] for d in self.board()["dishes"]}
        self.assertEqual(ids, {"REV-1"} | {"REV-%d" % (100 + n) for n in range(8)})


if __name__ == "__main__":
    unittest.main()
