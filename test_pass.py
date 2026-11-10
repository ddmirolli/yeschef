"""Behavior tests for the pass. Run: python3 -m unittest test_pass.py"""
import http.client
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("pass_board", os.path.join(os.path.dirname(__file__), "pass.py"))
pb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pb)
pb.ORIGIN = "https://pass.example:8494"  # the service sets it in its env file; tests use a stand-in


def _no_t3(thread_id):
    raise RuntimeError("tests never call the real T3")


pb.fetch_thread = _no_t3  # a test that needs thread records patches fetch_thread itself

GREEN_RUN = {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"}
PENDING_RUN = {"__typename": "CheckRun", "status": "IN_PROGRESS", "conclusion": ""}
FAILED_RUN = {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "FAILURE"}


def pr(state="OPEN", base="staging", checks=(GREEN_RUN,), draft=False):
    return {"number": 1, "title": "t", "url": "https://x/1", "state": state, "isDraft": draft,
            "baseRefName": base, "mergeCommit": {"oid": "abc"} if state == "MERGED" else None,
            "statusCheckRollup": list(checks)}


class Gates(unittest.TestCase):
    """The stages of docs/pass-definitions-v1_0.md (Dan, 2026-11-06)."""

    def test_no_pr_is_backlog_or_planned(self):
        # The board file keeps its "prep" field (data); only the stage's label changed (Dan, 2026-11-10).
        self.assertEqual(pb.component_gate({}, None)[0], "Backlog")
        self.assertEqual(pb.component_gate({"prep": "docs/ops/projects/reviewwheel-agent-brigade-spec-v1_0.md"}, None)[0], "Planned")

    def test_open_pr_moves_from_in_progress_to_in_review_only_when_all_checks_green(self):
        c = {"pr": 1}
        self.assertEqual(pb.component_gate(c, pr(checks=[GREEN_RUN, PENDING_RUN]))[0], "In progress")
        self.assertEqual(pb.component_gate(c, pr(checks=[GREEN_RUN, FAILED_RUN]))[0], "In progress")
        self.assertEqual(pb.component_gate(c, pr(checks=[]))[0], "In progress")
        self.assertEqual(pb.component_gate(c, pr(draft=True))[0], "In progress")
        self.assertEqual(pb.component_gate(c, pr())[0], "In review")

    def test_a_merge_into_the_base_branch_is_merged(self):
        # Merged is staging, "the floor". A project with no staging merges to main, and that is Merged too.
        self.assertEqual(pb.component_gate({"pr": 1}, pr("MERGED")), ("Merged", "merged to staging"))
        self.assertEqual(pb.component_gate({"pr": 1}, pr("MERGED", base="main")), ("Merged", "merged to main"))

    def test_board_file_never_overrides_a_github_fact(self):
        # Invariant 1: a "prep" path on the board does not hold back a merged PR.
        self.assertEqual(pb.component_gate({"pr": 1, "prep": "docs/ops/projects/reviewwheel-agent-brigade-spec-v1_0.md"}, pr("MERGED", base="main"))[0], "Merged")

    def test_unread_pr_is_not_checked(self):
        self.assertEqual(pb.component_gate({"pr": 1}, None)[0], "not checked")

    def test_dish_sits_at_least_advanced_component(self):
        self.assertEqual(pb.dish_gate({}, ["Merged", "In progress", "In review"]), "In progress")
        self.assertEqual(pb.dish_gate({}, ["Merged", "not checked"]), "not checked")

    def test_ready_to_merge_needs_the_board_mark_and_every_pr_in_review(self):
        # GitHub cannot show the chef's look, so the board marks it (its "plating" field, kept as data). Requested
        # changes (a PR back in progress) win over the mark.
        mark = {"plating": {"at": "2026-11-06T06:00"}}
        self.assertEqual(pb.dish_gate({}, ["In review"]), "In review")
        self.assertEqual(pb.dish_gate(mark, ["In review", "Merged"]), "Ready to merge")
        self.assertEqual(pb.dish_gate(mark, ["In progress", "In review"]), "In progress")
        self.assertEqual(pb.dish_gate(mark, ["Merged"]), "Merged")


class DevWords(unittest.TestCase):
    """Dan, 2026-11-10: developer words inside the product. The board file keeps its old field names and values."""

    def test_a_board_with_every_legacy_field_renders_only_the_new_words(self):
        # fixtures/board.json carries prep, plating, plated, and close "86", "carry" and "blocked": an older board.
        fx = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
        with open(os.path.join(fx, "sources.json")) as f:
            src = json.load(f)

        def look(table, key):
            val = src[table].get(key, "fail")
            if val == "fail":
                raise RuntimeError("demo outage")
            return dict(val)

        pb._cache.clear()
        with patch.object(pb, "fetch_pr", lambda n, repo=None: look("prs", "%s#%s" % (repo, n))), \
             patch.object(pb, "fetch_linear", lambda i: look("linear", i)), \
             patch.object(pb, "fetch_thread", lambda t: look("threads", t)):
            html = pb.render(os.path.join(fx, "board.json"))
        pb._cache.clear()
        body = html.split("<main", 1)[1].split("<script>", 1)[0]
        for label in ("Ready to merge", "In review", "Planned", "Backlog", "Merged", "On hold", "Canceled", "Areas"):
            self.assertIn(label, body)
        text = re.sub(r"<[^>]+>", " ", body)
        for old in ("Order", "Prep", "Fire", "Tasting", "Plating", "Held", "Killed", "Stations"):
            self.assertIsNone(re.search(r"\b%s\b" % old, text), old)
        self.assertIsNone(re.search(r"\bSent\b(?! \")", text))  # "Sent" stays only in send results ('Sent "a" to ...')


class Render(unittest.TestCase):
    def setUp(self):
        pb._cache.clear()
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "board.json")

    def write(self, board):
        with open(self.path, "w") as f:
            json.dump(board, f)

    def test_missing_board_is_a_clean_kitchen(self):
        html = pb.render(self.path)
        self.assertIn("Nothing needs you.", html)
        self.assertIn('<li class="stat">Active <b>0</b></li>', html)
        self.assertNotIn("expo", html.split("<script>")[0].lower().split("</style>")[1])  # the Pass is the expo: no expo line

    def test_invalid_board_renders_not_checked(self):
        with open(self.path, "w") as f:
            f.write("{nope")
        self.assertIn("board file invalid", pb.render(self.path))

    def test_failed_github_read_renders_not_checked_not_an_old_value(self):
        # Invariant 2: a success, then a failure after the TTL, must not show the old success.
        self.write({"repo": "acme/app", "dishes": [{"id": "REV-1", "outcome": "o", "components": [{"station": "website", "pr": 7}]}]})
        with patch.object(pb, "fetch_linear", side_effect=RuntimeError("no key")), \
             patch.object(pb, "fetch_pr", return_value=pr("MERGED", base="main")):
            self.assertIn("c-merged\">Merged", pb.render(self.path))
        for k in list(pb._cache):
            t, v, err = pb._cache[k]
            pb._cache[k] = (t - pb.TTL - 1, v, err)
        with patch.object(pb, "fetch_linear", side_effect=RuntimeError("no key")), \
             patch.object(pb, "fetch_pr", side_effect=RuntimeError("gh down")):
            html = pb.render(self.path)
        self.assertNotIn("c-merged\">Merged", html)
        self.assertIn("not checked at", html)
        self.assertIn("gh down", html)

    def test_calls_and_held_groups(self):
        self.write({"service": {"opened": "2026-11-05T09:00", "expoThread": "mcp:abc", "closed": None},
                    "dishes": [
                        {"id": "REV-2", "outcome": "o", "close": "blocked", "components": [],
                         "calls": [{"question": "Pick one?", "options": ["a. yes", "b. no"], "recommend": "a", "thread": "mcp:abc"}]},
                        {"id": "REV-3", "outcome": "o", "close": "86", "components": []},
                        {"id": "REV-5", "outcome": "o", "close": "carry", "components": []}]})
        with patch.object(pb, "fetch_linear", side_effect=RuntimeError("no key")), \
             patch.object(pb, "T3_WEB", "https://t3.example"), patch.object(pb, "T3_ENV", "env"):
            html = pb.render(self.path)
        self.assertIn("Pick one?", html)
        self.assertIn('call-tile" data-dish="REV-2"', html)  # an open call shows at the pass, even on a held ticket
        self.assertIn('class="tile quiet at" data-dish="REV-2"', html)  # and the ticket stays in its On hold group
        self.assertIn('On hold<span class="muted">2</span>', html)
        self.assertIn('<h3 class="">Blocked <span class="muted">1</span>', html)
        # The board's "86" stays valid data and shows as Canceled (Dan, 2026-11-10), never as 86 or Killed.
        self.assertIn('<h3 class="t-closed">Canceled <span class="muted">1</span>', html)
        self.assertNotIn(">86", html)
        self.assertNotIn("Killed", html)
        self.assertIn('aria-label="Backlog: 1"', html)  # a carried ticket keeps its stage
        self.assertNotIn("Carried", html)
        self.assertIn("https://t3.example/env/mcp%3Aabc", html)

    def test_thread_links_need_a_t3_address(self):
        # No T3 address in the env file: no link to a guessed host. The page still renders.
        self.write({"service": {"opened": "2026-11-05T09:00", "expoThread": "mcp:abc", "closed": None},
                    "dishes": [{"id": "REV-2", "outcome": "o", "components": [],
                                "calls": [{"question": "Pick one?", "options": ["a. yes", "b. no"], "recommend": "a", "thread": "mcp:abc"}]}]})
        with patch.object(pb, "fetch_linear", side_effect=RuntimeError("no key")), \
             patch.object(pb, "T3_WEB", ""), patch.object(pb, "T3_ENV", ""):
            html = pb.render(self.path)
        self.assertIn("Pick one?", html)
        self.assertNotIn("mcp%3Aabc", html)
        self.assertEqual(pb.link("", "Thread", out=True), "Thread")

    def test_a_call_leaves_the_ticket_in_its_column(self):
        # Dan, 2026-11-06: REV-175 sat at the head of the pass while Prep (now Planned) read 0.
        self.write({"dishes": [{"id": "REV-6", "outcome": "o", "components": [{"station": "website", "prep": "a/b"}],
                                "calls": [{"question": "Hold?", "options": ["a. hold", "b. go"]}]}]})
        with patch.object(pb, "fetch_linear", side_effect=RuntimeError("no key")):
            html = pb.render(self.path)
        self.assertIn('aria-label="Planned: 1"', html)
        self.assertIn('class="tile at" data-dish="REV-6"', html)
        self.assertIn('call-tile" data-dish="REV-6"', html)
        self.assertIn("<title>Yes Chef (1)</title>", html)

    def test_a_plating_ticket_waits_at_the_pass_without_a_call(self):
        self.write({"repo": "acme/app", "dishes": [{"id": "REV-7", "outcome": "o", "plating": {"at": "2026-11-06T06:00"},
                                "components": [{"station": "words", "pr": 7}]}]})
        with patch.object(pb, "fetch_linear", side_effect=RuntimeError("no key")), patch.object(pb, "fetch_pr", return_value=pr()):
            html = pb.render(self.path)
        self.assertIn('aria-label="Ready to merge: 1"', html)
        self.assertIn('call-tile" data-dish="REV-7"', html)
        self.assertIn("Ready for your look", html)

    def test_a_plating_ticket_with_a_call_keeps_waiting_after_the_answer(self):
        # PR-Agent r1 on #3: the page marked it answered instead of ready for the chef's look.
        call = {"question": "Ship?", "options": ["a. yes", "b. no"]}
        self.write({"repo": "acme/app", "dishes": [{"id": "REV-12", "outcome": "Alerts", "plating": {"at": "2026-11-06T06:00"},
                                "components": [{"station": "words", "pr": 7}], "calls": [call]},
                               {"id": "REV-13", "outcome": "o", "components": [], "calls": [call]}]})
        with patch.object(pb, "fetch_linear", side_effect=RuntimeError("no key")), patch.object(pb, "fetch_pr", return_value=pr()):
            html = pb.render(self.path)
        self.assertIn('call-tile" data-dish="REV-12" data-plate="p0" data-plating="Alerts"', html)
        self.assertIn('call-tile" data-dish="REV-13" data-plate="p1" aria-haspopup', html)
        self.assertIn("if (t && t.dataset.plating)", html)

    def test_a_filed_receipt_goes_on_the_spike_and_counts_today(self):
        today = pb.datetime.datetime.now().strftime("%Y-%m-%dT%H:%M")
        self.write({"dishes": [{"id": "REV-8", "outcome": "o", "plated": {"receipt": "https://x", "at": today}, "components": []},
                               {"id": "REV-9", "outcome": "o", "plated": {"receipt": "https://x", "at": "2026-01-02T10:00"}, "components": []}]})
        with patch.object(pb, "fetch_linear", side_effect=RuntimeError("no key")):
            html = pb.render(self.path)
        self.assertIn('<b>Verified</b><span class="n">2</span>', html)
        self.assertIn('<li class="stat">Verified today <b>1</b></li>', html)
        self.assertIn('<li class="stat">Active <b>0</b></li>', html)

    def test_a_pr_with_no_repo_is_not_checked_and_says_why(self):
        # No project is built in (Dan, 2026-11-06): the service's env file or the board names the repo.
        self.write({"dishes": [{"id": "REV-14", "outcome": "o", "components": [{"station": "words", "pr": 9}]}]})
        with patch.object(pb, "REPO", None), patch.object(pb, "fetch_linear", side_effect=RuntimeError("no key")), \
             patch.object(pb, "fetch_pr", side_effect=AssertionError("no repo: GitHub is never asked")):
            html = pb.render(self.path)
        self.assertIn("PR #9 on REV-14 names no repo", html)
        self.assertIn('<li class="bad"><i></i>Board', html)
        self.assertIn('<h3 class="t-red">Not checked <span class="muted">1</span>', html)
        self.assertIn("no repo</span>", html)

    def test_the_project_menu_filters_the_board(self):
        self.write({"dishes": [{"id": "REV-10", "outcome": "o", "repo": "acme/alpha", "components": []},
                               {"id": "REV-11", "outcome": "o", "repo": "acme/beta", "components": []}]})
        with patch.object(pb, "fetch_linear", side_effect=RuntimeError("no key")):
            full = pb.render(self.path)
            beta = pb.render(self.path, "beta")
            unknown = pb.render(self.path, "gamma")
        self.assertIn('data-dish="REV-10"', full)
        self.assertIn('data-dish="REV-11"', full)
        self.assertNotIn('data-dish="REV-10"', beta)
        self.assertIn('data-dish="REV-11"', beta)
        self.assertIn('<a href="/?p=beta" aria-current="page">', beta)
        self.assertIn('<span>alpha</span><span class="n">1</span>', beta)  # the menu still counts every project
        self.assertIn('<a href="/" aria-current="page">', unknown)  # a project with nothing on the board: All projects
        self.assertIn('data-dish="REV-10"', unknown)

    def test_an_answered_call_leaves_the_head_of_the_pass(self):
        dish = {"id": "REV-4", "outcome": "o", "components": [], "calls": [{"question": "Ship?", "options": ["a. yes"]}]}
        self.write({"dishes": [dish]})
        answers = os.path.join(self.dir, "answers.jsonl")
        with patch.object(pb, "fetch_linear", side_effect=RuntimeError("no key")), patch.object(pb, "ANSWERS", answers):
            self.assertIn('call-tile" data-dish="REV-4"', pb.render(self.path))
            with open(answers, "w") as f:
                f.write(json.dumps({"key": pb.call_key(dish, dish["calls"][0]), "option": "a. yes", "at": "t"}) + "\n")
            html = pb.render(self.path)
        self.assertNotIn('call-tile" data-dish="REV-4"', html)
        self.assertIn('class="tile" data-dish="REV-4"', html)
        self.assertIn("Nothing needs you.", html)
        self.assertIn("You answered <b>a. yes</b>", html)


class CallContext(unittest.TestCase):
    def setUp(self):
        pb._cache.clear()
        parent = os.path.realpath(tempfile.mkdtemp())
        self.art = os.path.join(parent, "rw-artifacts")
        os.makedirs(os.path.join(self.art, "2026-11-05", "topic"))
        self.shot = os.path.join(self.art, "2026-11-05", "topic", "after-dark-390.png")
        with open(self.shot, "wb") as f:
            f.write(b"png")
        # A real image right next to the root: the target of a "../" escape.
        self.outside = os.path.join(parent, "x.png")
        with open(self.outside, "wb") as f:
            f.write(b"png")
        self.patch = patch.object(pb, "ART_ROOT", self.art)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.path = os.path.join(tempfile.mkdtemp(), "board.json")

    def render(self, board):
        with open(self.path, "w") as f:
            json.dump(board, f)
        with patch.object(pb, "fetch_linear", side_effect=RuntimeError("no key")):
            return pb.render(self.path)

    def test_call_expands_to_context_options_and_images(self):
        html = self.render({"dishes": [{"id": "REV-9", "components": [{"station": "app-ui"}], "calls": [{
            "question": "Ship the dark checkout?", "options": ["a. send it out", "b. refire"], "recommend": "a",
            "context": "Council passed it.\n\n- Opus 9.2\n- Sol 9.0",
            "images": [{"path": self.shot, "caption": "after, dark, 390"}, {"path": self.outside, "caption": "stray"}]}]}]})
        # The tile opens its plate; the plate holds the call with its context, options, and images.
        self.assertIn('data-dish="REV-9" data-plate="p0"', html)
        self.assertIn('<dialog class="plate" id="p0"', html)
        self.assertIn('<section class="call">', html)
        self.assertIn('data-label="a. send it out"', html)
        self.assertIn("<li>Opus 9.2</li>", html)
        self.assertIn('src="/img/2026-11-05/topic/after-dark-390.png"', html)
        self.assertIn("image not shown", html)
        self.assertNotIn("no visuals attached", html)

    def test_visual_call_without_images_is_flagged(self):
        html = self.render({"dishes": [{"id": "REV-9", "components": [{"station": "design"}],
                                        "calls": [{"question": "Pick?", "options": [], "recommend": "a"}]}]})
        self.assertIn("no visuals attached", html)
        self.assertIn("No context written.", html)

    def test_non_visual_call_without_images_is_not_flagged(self):
        html = self.render({"dishes": [{"id": "REV-9", "components": [{"station": "backend"}],
                                        "calls": [{"question": "Pick?", "options": [], "recommend": "a"}]}]})
        self.assertNotIn("no visuals attached", html)

    def test_call_visual_field_overrides_the_dish_rule(self):
        # The expo's ask (2026-11-05): REV-175's product decisions have nothing to show, yet sit on an app-ui dish.
        ask = {"question": "Pick?", "options": ["a. x", "b. y"], "recommend": "a"}
        off = self.render({"dishes": [{"id": "REV-9", "components": [{"station": "app-ui"}], "calls": [dict(ask, visual=False)]}]})
        self.assertNotIn("no visuals attached", off)
        on = self.render({"dishes": [{"id": "REV-9", "components": [{"station": "backend"}], "calls": [dict(ask, visual=True)]}]})
        self.assertIn("no visuals attached", on)
        typo = self.render({"dishes": [{"id": "REV-9", "components": [{"station": "app-ui"}], "calls": [dict(ask, visual="no")]}]})
        self.assertIn("no visuals attached", typo)  # only a real false turns the flag off

    def test_image_route_refuses_traversal_and_non_images(self):
        self.assertEqual(pb.art_file("/img/2026-11-05/topic/after-dark-390.png"), self.shot)
        self.assertIsNone(pb.art_file("/img/../" + os.path.basename(self.outside)))
        self.assertIsNone(pb.art_file("/img/%2E%2E/etc/passwd"))
        notes = os.path.join(self.art, "notes.txt")
        with open(notes, "w") as f:
            f.write("x")
        self.assertIsNone(pb.art_file("/img/notes.txt"))

    def test_page_does_not_reload_while_a_call_is_open(self):
        html = self.render({"dishes": []})
        self.assertNotIn('http-equiv="refresh"', html)
        self.assertNotIn("location.reload", html)
        self.assertIn('if (document.hidden || $("dialog[open]") || $("details.pmenu[open]")) return;', html)  # nor while the project menu is open


class Answers(unittest.TestCase):
    def setUp(self):
        pb._cache.clear()
        d = tempfile.mkdtemp()
        self.board = os.path.join(d, "board.json")
        self.answers = os.path.join(d, "answers.jsonl")
        self.allow = os.path.join(d, "pass.allow")
        with open(self.allow, "w") as f:
            f.write("login dan@example.com\ndevice 100.1.1.1\n")
        self.dish = {"id": "REV-1", "components": [], "calls": [
            {"question": "Revoke the key?", "options": ["a. Revoke it", "b. Leave it"], "recommend": "a", "thread": "owner-1"}]}
        with open(self.board, "w") as f:
            json.dump({"service": {"expoThread": "expo-1"}, "dishes": [self.dish]}, f)
        self.key = pb.call_key(self.dish, self.dish["calls"][0])
        self.sent = []
        self.headers = {"Tailscale-User-Login": "dan@example.com", "Origin": pb.ORIGIN, "X-Forwarded-For": "100.1.1.1"}

    def post(self, option="0", headers=None, sender=None, key=None, note="", local=False):
        form = {"key": [key or self.key], "option": [option], "note": [note]}
        return pb.answer(form, headers or self.headers, board_path=self.board, answers_path=self.answers,
                         allow_path=self.allow, sender=sender or (lambda t, m: self.sent.append((t, m))),
                         peer_port=1, peer_check=lambda port: local)

    def test_click_reaches_owner_and_expo_once_and_is_logged(self):
        status, _ = self.post(option="0", note="go")
        self.assertEqual(status, 200)
        self.assertEqual([t for t, _ in self.sent], ["owner-1", "expo-1"])
        self.assertIn('"a. Revoke it"', self.sent[0][1])
        self.assertIn("Dan's note: go", self.sent[0][1])
        self.assertIn("grep %s %s." % (self.key, self.answers), self.sent[0][1])  # the log this pass really writes
        self.assertEqual(pb.load_answers(self.answers)[self.key]["login"], "dan@example.com")
        status, text = self.post(option="1")
        self.assertEqual(status, 409)
        self.assertEqual(len(self.sent), 2)

    def test_unknown_login_or_missing_identity_is_refused(self):
        for h in ({"Origin": pb.ORIGIN, "X-Forwarded-For": "100.1.1.1"},
                  {"Tailscale-User-Login": "else@example.com", "Origin": pb.ORIGIN, "X-Forwarded-For": "100.1.1.1"}):
            self.assertEqual(self.post(headers=h)[0], 403)
        self.assertEqual(self.sent, [])

    def test_local_process_is_refused_even_with_perfect_headers(self):
        # The ATC finding on #2297: any agent on this Mac could POST to 127.0.0.1 with Dan's headers.
        self.assertEqual(self.post(local=True)[0], 403)
        self.assertEqual(self.sent, [])

    def test_peer_check_failure_fails_closed(self):
        def broken(port):
            raise OSError("no lsof")
        form = {"key": [self.key], "option": ["0"], "note": [""]}
        status, _ = pb.answer(form, self.headers, board_path=self.board, answers_path=self.answers, allow_path=self.allow,
                              sender=lambda t, m: self.sent.append(t), peer_port=1, peer_check=broken)
        self.assertEqual(status, 403)
        self.assertEqual(self.sent, [])

    def test_dan_on_a_device_not_allowed_is_refused(self):
        # This Mac's own tailnet IP: an agent here can reach the pass through the tailnet as Dan.
        h = dict(self.headers, **{"X-Forwarded-For": "100.9.9.9"})
        self.assertEqual(self.post(headers=h)[0], 403)
        self.assertEqual(self.sent, [])

    def test_missing_allow_file_refuses_everyone(self):
        os.remove(self.allow)
        self.assertEqual(self.post()[0], 403)
        self.assertEqual(self.sent, [])

    def test_cross_site_post_is_refused(self):
        with patch.object(pb, "ORIGIN", ""):  # no page address set: even an empty Origin is refused
            status, text = self.post(headers=dict(self.headers, Origin=""))
            self.assertEqual((status, text), (403, "Answers must come from the pass page."))
        h = dict(self.headers, Origin="https://evil.example")
        self.assertEqual(self.post(headers=h)[0], 403)
        self.assertEqual(self.sent, [])

    def test_stale_call_and_bad_option_are_refused(self):
        self.assertEqual(self.post(key="0000deadbeef")[0], 409)
        self.assertEqual(self.post(option="7")[0], 400)
        self.assertEqual(self.post(option="x")[0], 400)
        self.assertEqual(self.sent, [])

    def test_answer_is_in_the_log_before_the_receiver_is_told(self):
        seen = []
        self.post(sender=lambda t, m: seen.append(self.key in pb.load_answers(self.answers)))
        self.assertEqual(seen, [True, True])

    def test_failed_send_is_not_logged_so_it_can_retry(self):
        def boom(t, m):
            raise RuntimeError("server down")
        status, text = self.post(sender=boom)
        self.assertEqual(status, 502)
        self.assertNotIn(self.key, pb.load_answers(self.answers))
        self.assertEqual(self.post()[0], 200)

    def test_send_that_misses_one_thread_is_207_not_a_plain_success(self):
        # CodeRabbit r4486340653 on ReviewWheel #2297: a part-sent answer used to look fully sent.
        def expo_down(t, m):
            if t == "expo-1":
                raise RuntimeError("expo offline")
            self.sent.append(t)
        status, text = self.post(sender=expo_down)
        self.assertEqual(status, 207)
        self.assertIn("1 of 2", text)
        self.assertIn("expo offline", text)
        self.assertEqual(self.sent, ["owner-1"])
        self.assertIn(self.key, pb.load_answers(self.answers))  # logged: the owner has it, so no second send

    def test_answered_call_shows_its_answer_instead_of_buttons(self):
        self.post(option="1")
        with patch.object(pb, "ANSWERS", self.answers):
            html = pb.render_answer(self.dish, self.dish["calls"][0], pb.load_answers(self.answers))
        self.assertIn("answered", html)
        self.assertIn("b. Leave it", html)
        self.assertNotIn("<button", html)


class AnswerRoute(unittest.TestCase):
    """The page's own script gets the result as text, shown in place. A plain form post still redirects."""

    def post(self, headers, result):
        server = pb.ThreadingHTTPServer(("127.0.0.1", 0), pb.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with patch.object(pb, "DEMO", True), patch.object(pb, "demo_answer", return_value=result):
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            conn.request("POST", "/answer", body="key=k&option=0&note=",
                         headers=dict(headers, **{"Content-Type": "application/x-www-form-urlencoded"}))
            r = conn.getresponse()
            out = r.status, r.getheader("Content-Type"), r.getheader("Location"), r.read().decode()
            conn.close()
        return out

    def test_script_post_gets_the_result_in_place(self):
        status, ctype, location, body = self.post({"X-Pass-Fetch": "1"}, (409, "Already answered at the pass."))
        self.assertEqual((status, location, body), (409, None, "Already answered at the pass."))
        self.assertTrue(ctype.startswith("text/plain"))
        status, _, location, body = self.post({"X-Pass-Fetch": "1"}, (200, 'Sent "a" to 2 thread(s).'))
        self.assertEqual((status, location, body), (200, None, 'Sent "a" to 2 thread(s).'))

    def test_plain_form_post_still_redirects(self):
        status, _, location, _ = self.post({}, (200, "Sent."))
        self.assertEqual((status, location), (303, "/"))


class RefusalLog(unittest.TestCase):
    """A refused tap writes one line to pass.log with time, status, reason, login, and device (ReviewWheel #2297 d4b809c)."""

    def test_refused_tap_writes_a_line_and_a_sent_one_does_not(self):
        server = pb.ThreadingHTTPServer(("127.0.0.1", 0), pb.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        lines = []
        headers = {"Content-Type": "application/x-www-form-urlencoded", "Tailscale-User-Login": "chef@demo.local",
                   "X-Forwarded-For": "100.64.0.1", "X-Pass-Fetch": "1"}

        def post():
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=10)
            conn.request("POST", "/answer", body="key=k&option=0&note=", headers=headers)
            status = conn.getresponse().status
            conn.close()
            return status

        # The real checks: this test is a process on this Mac, so answer() refuses it as local.
        with patch.object(pb, "DEMO", False), patch.object(pb, "log", side_effect=lines.append):
            self.assertEqual(post(), 403)
        self.assertEqual(len(lines), 1)
        self.assertRegex(lines[0], r"^\d\d:\d\d:\d\d answer refused 403: .+ \(login=chef@demo.local device=100.64.0.1\)$")
        with patch.object(pb, "DEMO", True), patch.object(pb, "demo_answer", return_value=(200, "Sent.")), \
             patch.object(pb, "log", side_effect=lines.append):
            self.assertEqual(post(), 200)
        self.assertEqual(len(lines), 1)

    def test_partly_sent_tap_is_logged_as_partly_sent_and_shows_a_page(self):
        server = pb.ThreadingHTTPServer(("127.0.0.1", 0), pb.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        lines = []
        with patch.object(pb, "DEMO", True), patch.object(pb, "demo_answer", return_value=(207, "Sent to 1 of 2.")), \
             patch.object(pb, "log", side_effect=lines.append):
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=10)
            conn.request("POST", "/answer", body="key=k&option=0&note=",
                         headers={"Content-Type": "application/x-www-form-urlencoded"})
            r = conn.getresponse()
            status, location, body = r.status, r.getheader("Location"), r.read().decode()
            conn.close()
        self.assertEqual((status, location), (207, None))
        self.assertIn("Sent to 1 of 2.", body)
        self.assertEqual(len(lines), 1)
        self.assertIn("answer not fully sent 207", lines[0])
        self.assertNotIn("refused", lines[0])


def rec(status="completed", mins=0, **kw):
    import datetime
    r = {"title": "T " + status, "status": status, "activeRunId": "run" if status == "running" else None,
         "model": "claude-opus-5-5", "pendingRequestCount": 0, "settled": False, "archived": False,
         "updatedAt": (datetime.datetime.utcnow() - datetime.timedelta(minutes=mins)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}
    r.update(kw)
    return r


class Times(unittest.TestCase):
    def test_utc_and_offset_stamps_show_in_local_time(self):
        import datetime
        utc = datetime.datetime(2026, 11, 5, 22, 2, 9, tzinfo=datetime.timezone.utc)
        local = utc.astimezone().replace(tzinfo=None)
        self.assertEqual(pb.when("2026-11-05T22:02:09Z"), local)
        self.assertEqual(pb.when("2026-11-05T22:02:09.057Z").replace(microsecond=0), local)
        self.assertEqual(pb.when(utc.astimezone().isoformat(timespec="seconds")), local)
        self.assertEqual(pb.when("2026-11-05T13:40"), datetime.datetime(2026, 11, 5, 13, 40))
        self.assertEqual(pb.when("2026-11-05T22:02:09+0000"), local)       # compact offset (strftime %z)
        self.assertEqual(pb.when("2026-11-05T17:02:09-05:00"), local)
        self.assertEqual(pb.when("2026-11-05T22:02:09.12Z"), local)        # a fraction Python 3.9 rejects
        self.assertIsNone(pb.when("2026-11-05T13:40junk"))
        self.assertIsNone(pb.when("0001-01-01T00:00+01:00"))     # the edge of the calendar on any host: None, not OverflowError
        self.assertIsNone(pb.when("2026-11-05T13:40+99:99"))     # no such offset
        self.assertIsNone(pb.when("2026-11-05T13:40+24:00"))
        self.assertIsNone(pb.when("9999-12-31T23:59-05:00"))
        self.assertIsNone(pb.when("soon"))
        self.assertIsNone(pb.when("2026-13-45T99:99Z"))


class ThreadState(unittest.TestCase):
    """Live T3 thread state on every dish (Dan's 2a, 2026-11-05)."""

    def setUp(self):
        pb._cache.clear()
        self.path = os.path.join(tempfile.mkdtemp(), "board.json")
        with open(self.path, "w") as f:
            json.dump({"service": {"opened": "2026-11-05T09:00", "expoThread": "expo", "closed": None}, "dishes": [
                {"id": "REV-1", "outcome": "Two threads", "components": [
                    {"station": "backend", "thread": "t-idle"}, {"station": "words", "thread": "t-run"},
                    {"station": "website", "thread": "t-idle"}]},
                {"id": "REV-2", "outcome": "Asks", "components": [{"station": "app-ui", "thread": "t-ask"}]},
                {"id": "REV-3", "outcome": "Plated", "plated": {"at": "2026-11-05T10:00"},
                 "components": [{"station": "data", "thread": "t-settled"}]}]}, f)
        self.records = {"expo": rec("running"), "t-idle": rec("completed", 14, title="Backend build"),
                        "t-run": rec("running", 1, title="Words pass"), "t-ask": rec("waiting", 3, pendingRequestCount=2),
                        "t-settled": rec("completed", 90, settled=True)}
        self.calls = []

    def fetch(self, thread_id):
        self.calls.append(thread_id)
        r = self.records[thread_id]
        if isinstance(r, Exception):
            raise r
        return r

    def render(self):
        with patch.object(pb, "fetch_thread", side_effect=self.fetch), \
             patch.object(pb, "fetch_linear", side_effect=RuntimeError("no key")):
            return pb.render(self.path)

    def test_states(self):
        s = pb.thread_state
        self.assertEqual(s(None), "Thread not checked")
        self.assertEqual(s(rec("running")), "Working")
        self.assertEqual(s(rec("queued", activeRunId=None)), "Working")
        self.assertEqual(s(rec("waiting", pendingRequestCount=1)), "Asks you in T3")
        self.assertEqual(s(rec("failed")), "Failed")
        self.assertEqual(s(rec("interrupted")), "Interrupted")
        self.assertEqual(s(rec("completed")), "Idle")
        self.assertEqual(s(rec("completed", settled=True)), "Settled")
        self.assertEqual(s(rec("completed", archived=True)), "Archived")

    def test_each_thread_is_read_once_per_render(self):
        self.render()
        self.assertEqual(sorted(self.calls), ["t-ask", "t-idle", "t-run", "t-settled"])  # the Pass is the expo: no expo read

    def test_tiles_show_the_most_urgent_state(self):
        html = self.render()
        self.assertIn('<span class="th k-green"><i></i>Working</span>', html)       # REV-1: working beats idle
        self.assertIn('<span class="th k-red"><i></i>Asks you in T3</span>', html)  # REV-2
        self.assertNotIn(">Settled</span></span></button>", html)                    # REV-3 is plated: only an alert would show

    def test_plate_lists_each_thread_with_title_stations_and_age(self):
        html = self.render()
        self.assertIn("<h3>Threads</h3>", html)
        self.assertIn("Backend build", html)
        self.assertIn("backend, website · claude-opus-5-5 · updated 14 min ago", html)
        self.assertIn('<span class="chip c-gray">Idle 14 min</span>', html)

    def test_failed_read_is_not_checked_and_lights_the_t3_lamp(self):
        self.records["t-run"] = RuntimeError("t3 server down")
        html = self.render()
        self.assertIn('<span class="th k-red"><i></i>Thread not checked</span>', html)
        self.assertIn('<li class="bad"><i></i>T3', html)
        self.assertIn("t3 server down", html)

    def test_failed_read_never_shows_the_older_record(self):
        self.render()
        for k in list(pb._cache):
            t, v, err = pb._cache[k]
            pb._cache[k] = (t - pb.TTL - 1, v, err)
        self.records["t-run"] = RuntimeError("gone")
        self.records["t-idle"] = RuntimeError("gone")
        html = self.render()
        self.assertNotIn("Words pass", html)
        self.assertNotIn("Idle 14 min", html)

    def test_quiet_tile_still_shows_an_alert(self):
        self.records["t-settled"] = rec("failed", 5)
        self.assertIn('<span class="th k-red"><i></i>Failed</span>', self.render())


# Rows copied from `netstat -anv -p tcp` on this Mac (2026-11-05): a pass copy on 8650 and its clients.
NETSTAT = """\
tcp4       0      0  127.0.0.1.8650         127.0.0.1.54135        CLOSE_WAIT           216            0  408300  146988           Python:26237  00022 00000004 0000000003aa6cd2 00000080 01000800      2      0 000000
tcp4       0      0  127.0.0.1.54135        127.0.0.1.8650         FIN_WAIT_2             0           56  408300  146988           Python:26370  02031 00000000 0000000003aa6cd1 00000080 04000900      1      0 000000
tcp4       0      0  127.0.0.1.54140        127.0.0.1.8650         ESTABLISHED            0          585  408300  146988 io.tailscale.ipn:96714  00182 00000008 0000000003aa6fc7 00000080 04000900      2      0 000000
tcp4       0      0  127.0.0.1.54150        127.0.0.1.8650         ESTABLISHED            0          585  408300  146988 Google Chrome He:1349  00102 00000008 0000000003aa6fc7 00000080 04000900      2      0 000000
tcp4       0      0  127.0.0.1.54160        127.0.0.1.8650         FIN_WAIT_2             0           56  408300  146988            kernel:0  02031 00000000 0000000003aa6cd1 00000080 04000900      1      0 000000
"""


class PeerCheck(unittest.TestCase):
    """CodeRabbit r4486340640 on ReviewWheel #2297: a client that half-closes after its POST left lsof's
    ESTABLISHED view and passed as Tailscale. Only netstat's proof of another user's socket counts now."""

    UIDS = {96714: 0, 26370: os.getuid(), 1349: os.getuid()}

    def local(self, peer_port, uids=None):
        return pb.peer_is_local_process(peer_port, 8650, table=NETSTAT, uid_of=(self.UIDS if uids is None else uids).get)

    def test_tailscale_root_socket_is_the_only_pass(self):
        self.assertFalse(self.local(54140))

    def test_this_users_socket_is_local_even_after_it_closed(self):
        self.assertTrue(self.local(54135))   # FIN_WAIT_2: the client half-closed or closed
        self.assertTrue(self.local(54150))   # a process name with spaces still parses

    def test_no_row_exited_process_and_pid_zero_fail_closed(self):
        self.assertTrue(self.local(59999))
        self.assertTrue(self.local(54140, uids={}))  # ps cannot read the PID: it exited
        self.assertTrue(self.local(54160))

    def test_netstat_failure_fails_closed(self):
        with patch.object(pb.subprocess, "run", return_value=pb.subprocess.CompletedProcess([], 1, "", "boom")):
            self.assertTrue(pb.peer_is_local_process(54140, 8650))


class ForgedLocalTap(unittest.TestCase):
    """The real check on real sockets: a local POST with perfect headers is refused however the client ends."""

    def setUp(self):
        d = tempfile.mkdtemp()
        dish = {"id": "REV-1", "components": [], "calls": [{"question": "Q?", "options": ["a. Yes"], "thread": "owner-1"}]}
        board, allow = os.path.join(d, "board.json"), os.path.join(d, "pass.allow")
        with open(board, "w") as f:
            json.dump({"service": {"expoThread": "expo-1"}, "dishes": [dish]}, f)
        with open(allow, "w") as f:
            f.write("login dan@example.com\ndevice 100.1.1.1\n")
        self.answers = os.path.join(d, "answers.jsonl")
        self.body = "key=%s&option=0&note=" % pb.call_key(dish, dish["calls"][0])
        self.sent, self.lines = [], []
        for name, value in (("BOARD", board), ("ALLOW", allow), ("ANSWERS", self.answers), ("DEMO", False),
                            ("send_to_thread", lambda t, m: self.sent.append(t)), ("log", self.lines.append)):
            p = patch.object(pb, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.server = pb.ThreadingHTTPServer(("127.0.0.1", 0), pb.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    # The forger is its own process, as an agent would be: the pass must not mistake it for itself.
    CLIENT = ("import socket, sys, time\n"
              "s = socket.create_connection(('127.0.0.1', int(sys.argv[1])))\n"
              "s.sendall(sys.argv[3].encode())\n"
              "if sys.argv[2] == 'half': s.shutdown(socket.SHUT_WR)\n"
              "if sys.argv[2] == 'close': s.close(); sys.exit()\n"
              "time.sleep(5)\n")

    def forge(self, end):
        import subprocess
        import sys
        import time
        request = ("POST /answer HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\n"
                   "Tailscale-User-Login: dan@example.com\r\nX-Forwarded-For: 100.1.1.1\r\nOrigin: %s\r\n"
                   "X-Pass-Fetch: 1\r\nContent-Length: %d\r\n\r\n%s" % (pb.ORIGIN, len(self.body), self.body))
        child = subprocess.Popen([sys.executable, "-c", self.CLIENT, str(self.server.server_port), end, request])
        self.addCleanup(child.wait)
        self.addCleanup(child.kill)
        deadline = time.time() + 10
        while not (self.lines or self.sent) and time.time() < deadline:
            time.sleep(0.05)
        time.sleep(0.2)  # let a send that slipped through finish before the asserts read it
        return self.lines

    def check_refused(self, end):
        lines = self.forge(end)
        self.assertEqual(len(lines), 1, end)
        self.assertIn("answer refused 403", lines[0])
        self.assertEqual(self.sent, [])
        self.assertFalse(os.path.exists(self.answers))

    def test_open_client_is_refused(self):
        self.check_refused("open")

    def test_half_closed_client_is_refused(self):
        self.check_refused("half")

    def test_client_that_closed_after_sending_is_refused(self):
        self.check_refused("close")



class Startup(unittest.TestCase):
    def test_the_live_pass_needs_its_origin(self):
        # No built-in address (the repo goes public): without BRIGADE_ORIGIN the service names it and stops.
        env = {k: v for k, v in os.environ.items() if not k.startswith("BRIGADE_")}
        env.update(BRIGADE_HOME=tempfile.mkdtemp(), BRIGADE_PORT="1")
        r = subprocess.run([sys.executable, "-I", os.path.join(os.path.dirname(os.path.abspath(__file__)), "pass.py")],
                           env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(r.returncode, 2)
        self.assertIn("BRIGADE_ORIGIN is not set", r.stderr)


if __name__ == "__main__":
    unittest.main()
