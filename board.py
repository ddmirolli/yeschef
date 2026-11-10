"""The board writer: the one safe way for the expo to change a board file. Python 3.9 standard library only.

Usage (the board defaults to $BRIGADE_BOARD, else ~/yeschef/board.json):
  python3 board.py [--board PATH] check            validate; exit 1 on an error
  python3 board.py [--board PATH] show [DISH]      print the board, or one dish
  python3 board.py [--board PATH] put < dish.json  add a dish, or replace the dish with the same id
  python3 board.py [--board PATH] drop DISH        take a dish off the board
  python3 board.py [--board PATH] drop-call DISH ANSWER_ID   take an answered call off (the id in "Dan ruled at the pass")
  python3 board.py [--board PATH] plating DISH               send a dish in review to the chef's look (Ready to merge)
  python3 board.py [--board PATH] plating DISH off           take it back from Ready to merge, as a change request does
  python3 board.py [--board PATH] plate DISH RECEIPT         record the receipt (the spike): the URL or path, and the time
  python3 board.py [--board PATH] service open EXPO_THREAD   open service with this expo thread
  python3 board.py [--board PATH] service expo EXPO_THREAD   hand the open service to a new expo thread
  python3 board.py [--board PATH] service close              close service; every open dish needs carry, 86, or blocked

Every write takes a lock, applies the change, validates the whole new board, saves the old file as
board.json.bak-YYYYmmddHHMMSS, and swaps the new file in atomically. An invalid board is never written.
The format is the brigade spec, section 8. Only the expo runs the writing commands (spec D1).
"""
import datetime
import fcntl
import importlib.util
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("brigade_pass", os.path.join(HERE, "pass.py"))
_pass = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_pass)
call_key, VISUAL_STATIONS = _pass.call_key, _pass.VISUAL_STATIONS

STATIONS = {"website", "funnels", "app-ui", "backend", "data", "words", "design"}
CLOSES = {None, "carry", "86", "blocked"}
REPO_RE = re.compile(r"^[\w.-]+/[\w.-]+$")
KEYS = {
    "board": {"service", "dishes", "repo"},
    "service": {"opened", "expoThread", "closed"},
    "dish": {"id", "outcome", "close", "components", "calls", "plating", "plated", "repo", "context", "images", "links"},
    "component": {"station", "thread", "pr", "base", "prep", "repo"},
    "call": {"question", "options", "recommend", "thread", "asked", "context", "images", "links", "visual"},
    "plating": {"at"},
    "plated": {"receipt", "at"},
}


class BoardError(Exception):
    pass


def now():
    """Local time with its offset, for example 2026-11-05T17:06:00-05:00: never misread as UTC."""
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def validate(board):
    """(errors, warnings) for a whole board. Errors block a write; warnings are printed."""
    errors, warnings = [], []

    def extra(where, obj, kind):
        for k in sorted(set(obj) - KEYS[kind]):
            warnings.append("%s: unknown key %r" % (where, k))

    def opt_str(where, obj, key):
        if obj.get(key) is not None and not isinstance(obj[key], str):
            errors.append("%s: %s must be text" % (where, key))

    def stamp(where, obj, key, required=False):
        val = obj.get(key)
        if val is None:
            if required:
                errors.append("%s: %s is required" % (where, key))
        elif not isinstance(val, str) or _pass.when(val) is None:  # the pass's own parser, so the two agree
            errors.append("%s: %s must be a time like 2026-11-05T13:40 or 2026-11-05T18:40:00Z" % (where, key))

    def media(where, obj):
        imgs, links = obj.get("images"), obj.get("links")
        if imgs is not None:
            if not isinstance(imgs, list) or not all(isinstance(i, dict) and isinstance(i.get("path"), str) for i in imgs):
                errors.append("%s: images must be a list of {path, caption}" % where)
            else:
                for i in imgs:
                    src = _pass.image_src(i["path"])  # the pass's own rule: https, or an image file under ART_ROOT
                    if src is None:
                        errors.append("%s: the pass cannot show image %s: it must be an image under %s"
                                      % (where, i["path"], _pass.ART_ROOT))
                    elif src.startswith("/img/") and not _pass.art_file(src):
                        warnings.append("%s: image %s does not exist yet" % (where, i["path"]))
        if links is not None:
            if not isinstance(links, list) or not all(
                    isinstance(l, dict) and isinstance(l.get("label"), str) and str(l.get("url", "")).startswith(("https://", "http://"))
                    for l in links):
                errors.append("%s: links must be a list of {label, url} with an http(s) url" % where)

    if not isinstance(board, dict):
        return ["the board must be a JSON object"], []
    extra("board", board, "board")
    if board.get("repo") is not None and not REPO_RE.match(str(board["repo"])):
        errors.append("board: repo must look like owner/name")
    svc = board.get("service")
    if svc is not None:
        if not isinstance(svc, dict):
            errors.append("service must be an object or null")
        else:
            extra("service", svc, "service")
            stamp("service", svc, "opened")
            stamp("service", svc, "closed")
            opt_str("service", svc, "expoThread")
    dishes = board.get("dishes")
    if not isinstance(dishes, list):
        return errors + ["dishes must be a list"], warnings
    seen = set()
    for n, d in enumerate(dishes):
        if not isinstance(d, dict):
            errors.append("dish %d: must be an object" % n)
            continue
        did = d.get("id")
        where = "dish %s" % (did or n)
        if not isinstance(did, str) or not did.strip():
            errors.append("%s: id is required (the Linear issue, for example REV-123)" % where)
        elif did in seen:
            errors.append("%s: id is on the board twice" % where)
        else:
            seen.add(did)
        extra(where, d, "dish")
        opt_str(where, d, "outcome")
        opt_str(where, d, "context")
        if d.get("close") not in CLOSES:
            errors.append("%s: close must be carry, 86, blocked, or null" % where)
        if d.get("repo") is not None and not REPO_RE.match(str(d["repo"])):
            errors.append("%s: repo must look like owner/name" % where)
        media(where, d)
        comps = d.get("components", [])
        if not isinstance(comps, list):
            errors.append("%s: components must be a list" % where)
            comps = []
        for i, c in enumerate(comps):
            cw = "%s component %d" % (where, i)
            if not isinstance(c, dict):
                errors.append("%s: must be an object" % cw)
                continue
            extra(cw, c, "component")
            if c.get("station") not in STATIONS:
                errors.append("%s: station must be one of %s" % (cw, ", ".join(sorted(STATIONS))))
            pr = c.get("pr")
            if pr is not None and (isinstance(pr, bool) or not isinstance(pr, int) or pr <= 0):
                errors.append("%s: pr must be a PR number or null" % cw)
            for k in ("thread", "base", "prep"):
                opt_str(cw, c, k)
            if c.get("repo") is not None and not REPO_RE.match(str(c["repo"])):
                errors.append("%s: repo must look like owner/name" % cw)
        calls = d.get("calls", [])
        if not isinstance(calls, list):
            errors.append("%s: calls must be a list" % where)
            calls = []
        questions = set()
        for i, c in enumerate(calls):
            cw = "%s call %d" % (where, i)
            if not isinstance(c, dict):
                errors.append("%s: must be an object" % cw)
                continue
            extra(cw, c, "call")
            q = c.get("question")
            if not isinstance(q, str) or not q.strip():
                errors.append("%s: question is required" % cw)
            elif q in questions:
                errors.append("%s: the same question twice gives two calls one answer id" % cw)
            else:
                questions.add(q)
            opts = c.get("options")
            if not isinstance(opts, list) or len(opts) < 2 or not all(isinstance(o, str) and o.strip() for o in opts):
                errors.append("%s: options must list at least two choices" % cw)
            elif c.get("recommend") is None:
                warnings.append("%s: no recommendation (Dan's MAS: one recommendation per decision)" % cw)
            elif _pass.recommended(c) is None:
                errors.append("%s: recommend %r matches no option" % (cw, c.get("recommend")))
            if not isinstance(c.get("thread"), str) or not c["thread"].strip():
                errors.append("%s: thread is required: the answer goes to it" % cw)
            stamp(cw, c, "asked", required=True)
            if not isinstance(c.get("context"), str) or not c["context"].strip():
                errors.append("%s: context is required: Dan rules from the pass alone (ruling 2026-11-05)" % cw)
            media(cw, c)
            if c.get("visual") is not None and not isinstance(c["visual"], bool):
                errors.append("%s: visual must be true or false" % cw)
            elif _pass.needs_visuals(d, c) and not (c.get("images") or d.get("images")):
                warnings.append("%s: visual call with no images; the pass flags it red. "
                                "A decision with nothing to see can say \"visual\": false" % cw)
        if d.get("plating") is not None:
            if not isinstance(d["plating"], dict):
                errors.append("%s: plating must be {at} or absent" % where)
            else:
                extra(where + " plating", d["plating"], "plating")
                stamp(where + " plating", d["plating"], "at", required=True)
        if d.get("plated") is not None:
            p = d["plated"]
            if not isinstance(p, dict):
                errors.append("%s: plated must be {receipt, at} or absent" % where)
            else:
                extra(where + " plated", p, "plated")
                if not isinstance(p.get("receipt"), str) or not p["receipt"].strip():
                    errors.append("%s: plated needs a receipt" % where)
                stamp(where + " plated", p, "at", required=True)
                if calls:  # the same rule as `plate`: a plated dish waits on no call, so close cannot skip one
                    errors.append("%s: a plated dish cannot have calls on the board" % where)
    return errors, warnings


def read(path, create=False):
    """The board at path. A missing file is an error, so a mistyped --board never writes a new board
    beside the live one. Only `service open` may start a board (create=True)."""
    if not os.path.exists(path):
        if create:
            return {"service": None, "dishes": []}
        raise BoardError("no board at %s (a mistyped --board or BRIGADE_BOARD?)" % path)
    with open(path) as f:
        try:
            return json.load(f)
        except ValueError as ex:
            raise BoardError("%s is not valid JSON: %s" % (path, ex))


def find(board, dish_id):
    for i, d in enumerate(board.get("dishes", [])):
        if isinstance(d, dict) and d.get("id") == dish_id:
            return i, d
    raise BoardError("no dish %s on the board" % dish_id)


def write(path, change, out=sys.stdout, create=False):
    """Lock, read, change, validate, back up, and swap in. Returns the new board."""
    folder = os.path.dirname(os.path.abspath(path))
    if not create and not os.path.exists(path):
        raise BoardError("no board at %s (a mistyped --board or BRIGADE_BOARD?)" % path)
    with open(path + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        old_exists = os.path.exists(path)
        board = read(path, create)
        try:
            change(board)
            errors, warnings = validate(board)
        except (AttributeError, TypeError, KeyError, IndexError) as ex:  # a hand-broken board: report, never crash
            raise BoardError("the board file is malformed (%s: %s). Run check, then fix it." % (type(ex).__name__, ex))
        for w in warnings:
            print("warning: " + w, file=out)
        if errors:
            raise BoardError("not written:\n  " + "\n  ".join(errors))
        if old_exists:
            backup = base = "%s.bak-%s" % (path, datetime.datetime.now().strftime("%Y%m%d%H%M%S"))
            n = 1
            while os.path.exists(backup):  # two writes in one second keep both backups
                backup, n = "%s-%d" % (base, n), n + 1
            # Owner-only, like the atomic save: a backup never shows more than the live board does.
            fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with open(path, "rb") as src, os.fdopen(fd, "wb") as dst:
                dst.write(src.read())
        fd, tmp = tempfile.mkstemp(dir=folder, prefix=".board-", suffix=".json")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(board, f, indent=2)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise
    return board


def put(board, dish):
    if not isinstance(dish, dict) or not dish.get("id"):
        raise BoardError("put reads one dish object with an id from stdin")
    try:
        i, _ = find(board, dish["id"])
        board["dishes"][i] = dish
    except BoardError:
        board.setdefault("dishes", []).append(dish)


def drop(board, dish_id):
    i, _ = find(board, dish_id)
    del board["dishes"][i]


def drop_call(board, dish_id, key):
    _, d = find(board, dish_id)
    calls = d.get("calls") or []
    keep = [c for c in calls if call_key(d, c) != key]
    if len(keep) == len(calls):
        raise BoardError("dish %s has no call with answer id %s" % (dish_id, key))
    d["calls"] = keep


def plate(board, dish_id, receipt):
    _, d = find(board, dish_id)
    open_calls = [c.get("question") for c in d.get("calls") or []]
    if open_calls:
        raise BoardError("dish %s still has calls on the board: %s" % (dish_id, "; ".join(open_calls)))
    d["plated"] = {"receipt": receipt, "at": now()}
    d.pop("plating", None)
    d["close"] = None


def plating(board, dish_id, on):
    """Mark a dish ready for the chef's look, or take the mark off. The pass shows Ready to merge only while every PR is
    in review. The command and the field keep their old name, "plating", so live boards and scripts stay valid."""
    _, d = find(board, dish_id)
    if d.get("plated"):
        raise BoardError("dish %s already has its receipt" % dish_id)
    if on:
        d["plating"] = {"at": now()}
    else:
        d.pop("plating", None)


def service_open(board, expo):
    svc = board.get("service") or {}
    if svc.get("opened") and not svc.get("closed"):
        raise BoardError("service is already open since %s. Close it first (invariant 4), or hand it over with "
                         "`service expo THREAD`" % svc["opened"])
    board["service"] = {"opened": now(), "expoThread": expo, "closed": None}


def service_expo(board, expo):
    """A new expo takes over the open service (an ATC handoff). The service keeps its opening time."""
    svc = board.get("service") or {}
    if not svc.get("opened") or svc.get("closed"):
        raise BoardError("no open service to hand over")
    svc["expoThread"] = expo


def service_close(board):
    svc = board.get("service") or {}
    if not svc.get("opened") or svc.get("closed"):
        raise BoardError("no open service to close")
    loose = [d.get("id") for d in board.get("dishes", []) if not d.get("plated") and d.get("close") not in ("carry", "86", "blocked")]
    if loose:
        raise BoardError("every open dish needs carry, 86, or blocked before close (spec invariant 4): %s" % ", ".join(loose))
    svc["closed"] = now()
    board["service"] = svc


def main(argv, stdin=sys.stdin, out=sys.stdout):
    args = list(argv)
    path = os.path.expanduser(os.environ.get("BRIGADE_BOARD", os.path.join(os.environ.get("BRIGADE_HOME", "~/yeschef"), "board.json")))
    if args[:1] == ["--board"] and len(args) > 1:
        path, args = os.path.expanduser(args[1]), args[2:]
    cmd, rest = (args[0], args[1:]) if args else ("", [])
    try:
        if cmd == "check" and not rest:
            try:
                errors, warnings = validate(read(path))
            except (AttributeError, TypeError, KeyError, IndexError) as ex:
                errors, warnings = ["the board file is malformed (%s: %s)" % (type(ex).__name__, ex)], []
            for w in warnings:
                print("warning: " + w, file=out)
            for x in errors:
                print("error: " + x, file=out)
            print("%s: %s" % (path, "invalid" if errors else "ok"), file=out)
            return 1 if errors else 0
        if cmd == "show" and len(rest) <= 1:
            board = read(path)
            print(json.dumps(find(board, rest[0])[1] if rest else board, indent=2), file=out)
            return 0
        if cmd == "put" and not rest:
            try:
                dish = json.load(stdin)
            except ValueError as ex:
                raise BoardError("stdin is not valid JSON: %s" % ex)
            write(path, lambda b: put(b, dish), out)
        elif cmd == "drop" and len(rest) == 1:
            write(path, lambda b: drop(b, rest[0]), out)
        elif cmd == "drop-call" and len(rest) == 2:
            write(path, lambda b: drop_call(b, rest[0], rest[1]), out)
        elif cmd == "plating" and (len(rest) == 1 or rest[1:] == ["off"]):
            write(path, lambda b: plating(b, rest[0], len(rest) == 1), out)
        elif cmd == "plate" and len(rest) == 2:
            write(path, lambda b: plate(b, rest[0], rest[1]), out)
        elif cmd == "service" and rest[:1] == ["open"] and len(rest) == 2:
            write(path, lambda b: service_open(b, rest[1]), out, create=True)
        elif cmd == "service" and rest[:1] == ["expo"] and len(rest) == 2:
            write(path, lambda b: service_expo(b, rest[1]), out)
        elif cmd == "service" and rest == ["close"]:
            write(path, service_close, out)
        else:
            print(__doc__.strip(), file=out)
            return 2
    except BoardError as ex:
        print(str(ex), file=out)
        return 1
    except OSError as ex:  # a folder that does not exist, or no permission: an error, not a traceback
        print("not written: %s" % ex, file=out)
        return 1
    print("written: %s" % path, file=out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
