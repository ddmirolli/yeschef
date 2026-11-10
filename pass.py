"""The pass: the live brigade board, tailnet only.

Spec: docs/agent-brigade-spec-v1_0.md (sections 7, 8, 9); words: docs/pass-definitions-v1_0.md.
Yes Chef serves every project: each component names its GitHub repo (see README.md).
The expo writes the board file. This server reads the board file, GitHub through
`gh`, and Linear. It never merges or pushes (Invariant 3). Its one action (S5):
relay Dan's click on a call option to the owning thread and the expo, through
`t3 thread send`, then append it to its own answers log.
Each source is read at most once a minute, and only when a page asks for it.
A source that fails renders "not checked", never an older value (Invariant 2).
Runs on the macOS system Python 3.9: standard library only.
"""
import datetime
import hashlib
import html
import json
import os
import re
import shlex
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import groupby

# The live data folder: the board, the answers log, the allow list, and the service's env files.
HOME = os.path.expanduser(os.environ.get("BRIGADE_HOME", "~/yeschef"))
BOARD = os.path.expanduser(os.environ.get("BRIGADE_BOARD", os.path.join(HOME, "board.json")))
# Default GitHub repo for a component that names none (component "repo", then dish "repo", then board "repo").
# No project is built in: the service sets it in its env file, or the board names its repos.
REPO = os.environ.get("BRIGADE_REPO") or None
PORT = int(os.environ.get("BRIGADE_PORT", "8494"))
TTL = 60
# Thread links: T3 Code's web address and environment id, from the service's env file. Unset, threads show as plain text.
T3_WEB = (os.environ.get("BRIGADE_T3_WEB") or "").rstrip("/")
T3_ENV = os.environ.get("BRIGADE_T3_ENV") or ""
# The stages a ticket moves through, left to right (docs/pass-definitions-v1_0.md). Labels only: the board file
# never stores a stage, so older boards read the same (its fields keep their old names: prep, plating, plated).
GATES = ["Backlog", "Planned", "In progress", "In review", "Ready to merge", "Merged"]
GREEN = {"SUCCESS", "NEUTRAL", "SKIPPED"}
# Images are served only from this folder: the shared artifacts gallery every agent saves screenshots to.
ART_ROOT = os.path.realpath(os.path.expanduser(os.environ.get("BRIGADE_ART_ROOT", "~/rw-artifacts")))
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
               ".webp": "image/webp", ".svg": "image/svg+xml"}
# Answers (S5). Only a click from an allowed tailnet login on the pass page posts to a thread.
ANSWERS = os.path.expanduser(os.environ.get("BRIGADE_ANSWERS", os.path.join(HOME, "answers.jsonl")))
ALLOW = os.path.expanduser(os.environ.get("BRIGADE_ALLOW", os.path.join(HOME, "pass.allow")))
# The pass page's own address, as the browser sends it in Origin. Required: the service will not start without it.
ORIGIN = os.environ.get("BRIGADE_ORIGIN") or ""
T3_CLI = os.path.expanduser(os.environ.get("BRIGADE_T3_CLI", "~/.t3/bin/t3"))
_send_lock = threading.Lock()
# Areas (the board's "station" field) whose work is visual. A call on such a dish with no image gets a red flag.
VISUAL_STATIONS = {"website", "funnels", "app-ui", "design"}
e = html.escape

_cache = {}


def now_et():
    # ET label without tz data: the Mac runs in ET (Dan-facing times are ET).
    return datetime.datetime.now().strftime("%H:%M ET")


def cached(key, fn):
    """Return (value, error). A failure caches None, so no older value survives it."""
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < TTL:
        return hit[1], hit[2]
    try:
        value, err = fn(), None
    except Exception as ex:  # noqa: BLE001 - any source failure renders "not checked"
        value, err = None, "not checked at %s: %s" % (now_et(), str(ex)[:160])
    _cache[key] = (time.time(), value, err)
    return value, err


def gh_json(args):
    out = subprocess.run(["gh"] + args, capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or "gh exit %d" % out.returncode)
    return json.loads(out.stdout)


def fetch_pr(number, repo=REPO):
    return gh_json(["pr", "view", str(number), "-R", repo, "--json",
                    "number,title,url,state,isDraft,baseRefName,mergeCommit,statusCheckRollup,body"])


def fetch_linear(identifier):
    key = os.environ.get("LINEAR_API_KEY")
    if not key:
        raise RuntimeError("LINEAR_API_KEY is not set")
    q = "query($id:String!){issue(id:$id){identifier title url state{name}}}"
    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        data=json.dumps({"query": q, "variables": {"id": identifier}}).encode(),
        headers={"Content-Type": "application/json", "Authorization": key})
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.load(r)
    if d.get("errors"):
        raise RuntimeError(d["errors"][0].get("message", "Linear error"))
    return d["data"]["issue"]


def fetch_thread(thread_id):
    """One T3 thread's record (status, settled, pending requests, title, updatedAt) through T3's CLI. Read only."""
    out = subprocess.run([T3_CLI, "thread", "show", "--json", "--messages", "0", thread_id],
                         capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout).strip()[-160:] or "t3 exit %d" % out.returncode)
    return json.loads(out.stdout)["thread"]


def load_board(path=BOARD):
    """Return (board, error). A missing file is an empty board, not an error."""
    if not os.path.exists(path):
        return {"service": None, "dishes": []}, None
    try:
        with open(path) as f:
            board = json.load(f)
        board.setdefault("dishes", [])
        return board, None
    except (OSError, ValueError) as ex:
        return None, "board file invalid at %s: %s" % (now_et(), str(ex)[:160])


def checks_state(rollup):
    """green, pending, failed, or none, from a gh statusCheckRollup list."""
    if not rollup:
        return "none"
    pending = False
    for c in rollup:
        if c.get("__typename") == "StatusContext":
            st = c.get("state")
            if st == "PENDING" or st == "EXPECTED":
                pending = True
            elif st != "SUCCESS":
                return "failed"
        else:
            if c.get("status") != "COMPLETED":
                pending = True
            elif c.get("conclusion") not in GREEN:
                return "failed"
    return "pending" if pending else "green"


def component_gate(comp, pr):
    """Stage of one component. GitHub facts win over the board file (Invariant 1).

    pr: gh pr view JSON, or None when the component has no PR.
    Returns (stage, note). stage is Backlog, Planned, In progress, In review, Merged, "Closed", or "not checked".
    Merged into its base branch (staging, or main where a project has no staging) is Merged.
    """
    if not comp.get("pr"):
        return ("Planned", "") if comp.get("prep") else ("Backlog", "")
    if pr is None:
        return "not checked", ""
    if pr["state"] == "CLOSED":
        return "Closed", "closed without merge"
    if pr["state"] == "MERGED":
        return "Merged", "merged to " + pr["baseRefName"]
    checks = checks_state(pr.get("statusCheckRollup"))
    if pr.get("isDraft") or checks != "green":
        return "In progress", "draft" if pr.get("isDraft") else "checks " + checks
    return "In review", "checks green"


def dish_gate(dish, comp_gates):
    """A ticket sits at the stage of its least advanced component (spec, section 5).
    GitHub cannot show the chef's look, so a ticket in review that the board marks "plating" is Ready to merge."""
    if not comp_gates:
        return "Planned" if dish.get("prep") else "Backlog"
    if "not checked" in comp_gates:
        return "not checked"
    live = [g for g in comp_gates if g in GATES]
    if not live:
        return "Closed"
    gate = min(live, key=GATES.index)
    return "Ready to merge" if gate == "In review" and dish.get("plating") else gate


def thread_url(thread_id):
    """The thread in T3 Code's web app, or "" when the service names no T3 address."""
    if not (T3_WEB and T3_ENV):
        return ""
    return "%s/%s/%s" % (T3_WEB, T3_ENV, urllib.parse.quote(thread_id, safe=""))


def comp_repo(comp, dish):
    """The GitHub repo of one component: its own, else the dish's, else REPO. render() copies a board "repo" onto dishes."""
    return comp.get("repo") or dish.get("repo") or REPO


def resolve(dish, sources):
    """Attach live facts to each component. Records each source failure once."""
    rows = []
    for comp in dish.get("components", []):
        pr = None
        repo = comp_repo(comp, dish)
        if comp.get("pr") and not repo:
            sources["Board"] = "PR #%s on %s names no repo (set repo on the board, the dish, or the component)" % (comp["pr"], dish.get("id", "a dish"))
        elif comp.get("pr"):
            pr, err = cached(("pr", repo, comp["pr"]), lambda n=comp["pr"], r=repo: fetch_pr(n, r))
            if err:
                sources["GitHub"] = err
        gate, note = component_gate(comp, pr)
        rows.append((comp, pr, gate, note))
    return rows


# Stages that are pull request states wear GitHub's colors (Primer, Dan 2026-11-07): In review is an open PR (green),
# Merged is merged (purple), a closed PR or a canceled ticket is closed (red). Blue still belongs to the pass.
CHIP = {"Backlog": "gray", "Planned": "gray", "In progress": "amber", "In review": "open", "Ready to merge": "blue",
        "Merged": "merged", "Closed": "closed", "not checked": "red"}
# An on-hold ticket's close word: canceled reads as a closed PR, blocked stays gray.
CLOSE_TONE = {"Canceled": "closed", "Blocked": "gray"}
# What each stage means, in the words its column shows under its name.
GATE_HINT = {"Backlog": "No brief yet", "Planned": "Brief locked", "In progress": "Agents building",
             "In review": "PR open, checks green", "Ready to merge": "Your look", "Merged": "On staging"}
# The board's "close" values, as the On hold groups name them. The file keeps "86" (data); the page says Canceled.
# "carry" is not here: a carried ticket keeps its stage.
CLOSE = {"blocked": "Blocked", "86": "Canceled"}
# On hold groups, in order: out of the stages, never hidden.
HELD = ["Not checked", "Blocked", "PR closed", "Canceled"]
ICONS = {
    "cloche": '<path d="M4.25 17.4a7.75 7.75 0 0 1 15.5 0" stroke-width="1.5" stroke-linecap="butt"/><circle cx="12" cy="7.4" r="1.75" fill="currentColor" stroke="none"/><path d="M2.75 19h18.5l-1.5 1.5H4.25z" fill="currentColor" stroke="none"/>',
    "check": '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    "x": '<path d="M7 7l10 10M17 7 7 17"/>',
    "warn": '<path d="M12 4.2 2.9 19.5h18.2Z"/><path d="M12 10v4.4"/><path d="M12 17.1v.2"/>',
    "out": '<path d="M8.5 15.5 16 8"/><path d="M9.5 8H16v6.5"/>',
    "chev": '<path d="m6 9 6 6 6-6"/>',
    "done": '<circle cx="12" cy="12" r="9"/><path d="m8 12.4 2.7 2.7L16.2 9.4"/>',
}


def svg(name, cls="ic"):
    return ('<svg class="%s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">%s</svg>' % (cls, ICONS[name]))


def chip(text, color=None):
    return '<span class="chip c-%s">%s</span>' % (color or CHIP.get(text, "gray"), e(text))


def link(url, text, out=False):
    """An outside link. It opens a new tab, so an open plate is never lost. No address: the text alone."""
    if not url:
        return e(text)
    return '<a href="%s" target="_blank" rel="noopener">%s%s</a>' % (e(url, quote=True), e(text), svg("out") if out else "")


# A board time: minutes, then optional seconds and fraction, then optional Z, +hh:mm, or +hhmm (hh 00-23, mm 00-59).
STAMP = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d)(?::(\d\d)(?:\.\d+)?)?(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$")


def when(stamp):
    """A board time as this Mac's local time (ET), or None.

    "2026-11-05T13:40" is already local. A stamp with "Z" or an offset ("2026-11-05T22:02:09Z", the
    expo's usual form) is converted, so a call asked at 17:02 ET never shows as 22:02.
    """
    m = STAMP.match(str(stamp or "").strip())
    if not m:
        return None
    try:
        t = datetime.datetime.strptime("%s:%s" % (m.group(1), m.group(2) or "00"), "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None
    tz = m.group(3)
    if not tz:
        return t
    off = 0 if tz == "Z" else (1 if tz[0] == "+" else -1) * (int(tz[1:3]) * 60 + int(tz[-2:]))
    try:
        utc = (t - datetime.timedelta(minutes=off)).replace(tzinfo=datetime.timezone.utc)
        return utc.astimezone().replace(tzinfo=None)
    except (OverflowError, ValueError):  # a typo'd year at the edge of the calendar
        return None


def clock(stamp):
    """"13:40" for today, "Nov 4, 13:40" for another day. A time that does not parse stays as written."""
    t = when(stamp)
    if not t:
        return str(stamp or "")
    if t.date() == datetime.date.today():
        return t.strftime("%H:%M")
    return "%s %d, %s" % (t.strftime("%b"), t.day, t.strftime("%H:%M"))


def waited(stamp):
    """How long ago, as "2 h 5 min". Empty when the time does not parse or is in the future."""
    t = when(stamp)
    minutes = int((datetime.datetime.now() - t).total_seconds() // 60) if t else -1
    return span(minutes) if minutes >= 0 else ""


def minutes_since(iso):
    """Whole minutes since a UTC stamp such as T3's "2026-11-05T21:50:25.057Z", or None."""
    try:
        t = datetime.datetime.strptime(str(iso or "")[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None
    return max(0, int((datetime.datetime.utcnow() - t).total_seconds() // 60))


def span(minutes):
    """Minutes as "5 min", "2 h 5 min", or "3 d"."""
    if minutes < 60:
        return "%d min" % minutes
    if minutes < 1440:
        return "%d h %d min" % divmod(minutes, 60)
    return "%d d" % (minutes // 1440)


def projects(dish):
    """Short repo names of a dish ("reviewwheel"), one per repo, in component order."""
    repos = [comp_repo(c, dish) for c in dish.get("components", [])] or [dish.get("repo") or REPO]
    return list(dict.fromkeys((r or "no repo").split("/")[-1] for r in repos))


def project_tag(dish):
    """The project name with its lettered mark."""
    names = projects(dish)
    return '<span class="proj">%s%s</span>' % (mark(names[0]), e(", ".join(names)))


def image_src(path):
    """URL for one board image, or None when it is outside ART_ROOT or not an image."""
    if path.startswith("https://"):
        return path
    # A relative path is relative to ART_ROOT.
    real = os.path.realpath(os.path.join(ART_ROOT, os.path.expanduser(path)))
    if not real.startswith(ART_ROOT + os.sep) or os.path.splitext(real)[1].lower() not in IMAGE_TYPES:
        return None
    return "/img/" + urllib.parse.quote(os.path.relpath(real, ART_ROOT))


def art_file(url_path):
    """Map /img/<rel> back to a file inside ART_ROOT, or None (traversal and non-images refused)."""
    rel = urllib.parse.unquote(url_path[len("/img/"):])
    real = os.path.realpath(os.path.join(ART_ROOT, rel))
    if not real.startswith(ART_ROOT + os.sep) or not os.path.isfile(real):
        return None
    if os.path.splitext(real)[1].lower() not in IMAGE_TYPES:
        return None
    return real


def render_text(text):
    """Plain text: blank lines split paragraphs, "- " lines become bullets, "#" lines become bold heads."""
    out = []
    for block in (text or "").strip().split("\n\n"):
        lines = [l.strip() for l in block.split("\n") if l.strip()]
        for bullet, run in groupby(lines, key=lambda l: l.startswith("- ")):
            run = list(run)
            if bullet:
                out.append("<ul>%s</ul>" % "".join("<li>%s</li>" % e(l[2:]) for l in run))
            else:
                out.append("<p>%s</p>" % "<br>".join("<b>%s</b>" % e(l.lstrip("# ")) if l.startswith("#") else e(l)
                                                     for l in run))
    return "".join(out)


def images(items):
    """(src or None, caption, path) for each board image."""
    for it in items or []:
        it = {"path": it} if isinstance(it, str) else it
        yield image_src(it.get("url") or it.get("path") or ""), it.get("caption", ""), it.get("path", "")


def render_images(items):
    out = []
    for src, cap, path in images(items):
        if src:
            out.append('<figure><a href="%s" target="_blank" rel="noopener"><img loading="lazy" src="%s" alt="%s"></a>'
                       '<figcaption>%s</figcaption></figure>' % (e(src, quote=True), e(src, quote=True), e(cap), e(cap)))
        else:
            out.append('<figure class="missing">%s<figcaption>%s %s</figcaption></figure>'
                       % (chip("image not shown", "red"), e(cap), e(path)))
    return '<div class="imgs">%s</div>' % "".join(out) if out else ""


def render_links(items):
    links = [link(l["url"], l.get("label", l["url"]), out=True) for l in items or [] if l.get("url")]
    return '<p class="links">%s</p>' % "".join(links) if links else ""


def is_visual(dish):
    return any(c.get("station") in VISUAL_STATIONS for c in dish.get("components", []))


def needs_visuals(dish, call):
    """Whether a call needs images: its own "visual" (true or false) when set, else the dish rule (a visual station)."""
    if isinstance(call.get("visual"), bool):
        return call["visual"]
    return is_visual(dish)


ACTIVE_RUN = {"preparing", "queued", "starting", "running", "waiting"}
# Most urgent first: a tile shows the first of these that any of its threads is in.
THREAD_RANK = ["Asks you in T3", "Failed", "Interrupted", "Thread not checked", "Working", "Idle", "Settled", "Archived"]
THREAD_TONE = {"Asks you in T3": "red", "Failed": "red", "Interrupted": "amber", "Thread not checked": "red",
               "Working": "green", "Idle": "gray", "Settled": "gray", "Archived": "gray"}
ALERT_RANK = THREAD_RANK.index("Thread not checked")  # this state and the ones before it show even off the rail


def thread_state(rec):
    """The state of one T3 thread record, as a THREAD_RANK label. No record: not checked."""
    if not rec:
        return "Thread not checked"
    if (rec.get("pendingRequestCount") or 0) > 0:
        return "Asks you in T3"
    if rec.get("archived"):
        return "Archived"
    if rec.get("status") in ACTIVE_RUN or rec.get("activeRunId"):
        return "Working"
    if rec.get("status") == "failed":
        return "Failed"
    if rec.get("status") == "interrupted":
        return "Interrupted"
    return "Settled" if rec.get("settled") else "Idle"


def thread_ids(dish):
    """Every thread a dish names, components first, each once."""
    ids = [c.get("thread") for c in dish.get("components", [])] + [c.get("thread") for c in dish.get("calls") or []]
    return list(dict.fromkeys(t for t in ids if t))


def read_thread(thread_id, sources):
    """{id, rec, state, mins} for one thread. A failed read is "not checked", never an older record."""
    rec, err = cached(("thread", thread_id), lambda: fetch_thread(thread_id))
    if err:
        sources["T3"] = err
    return {"id": thread_id, "rec": rec, "state": thread_state(rec), "mins": minutes_since((rec or {}).get("updatedAt"))}


def thread_label(th, working=1):
    """"Working", "2 working", "Idle 12 min", or the state as it is."""
    if th["state"] == "Working" and working > 1:
        return "%d working" % working
    if th["state"] == "Idle" and th["mins"] is not None:
        return "Idle %s" % span(th["mins"])
    return th["state"]


def thread_pill(threads, quiet=False):
    """The most urgent thread state of a dish, as one small line. Quiet tiles show only alerts."""
    if not threads:
        return ""
    rank = lambda th: (THREAD_RANK.index(th["state"]), th["mins"] if th["mins"] is not None else 1 << 30)  # noqa: E731
    top = min(threads, key=rank)
    if quiet and THREAD_RANK.index(top["state"]) > ALERT_RANK:
        return ""
    working = sum(th["state"] == "Working" for th in threads)
    return '<span class="th k-%s"><i></i>%s</span>' % (THREAD_TONE[top["state"]], e(thread_label(top, working)))


def read_dish(dish, sources, answers):
    """One dish with its live facts: component rows, the dish gate, the Linear issue, and the calls still open."""
    rows = resolve(dish, sources)
    issue = None
    if dish.get("id"):
        issue, err = cached(("linear", dish["id"]), lambda i=dish["id"]: fetch_linear(i))
        if err:
            sources["Linear"] = err
    calls = dish.get("calls") or []
    still_open = [c for c in calls if call_key(dish, c) not in answers]
    return {"dish": dish, "rows": rows, "gate": dish_gate(dish, [r[2] for r in rows]), "issue": issue,
            "open": still_open, "ruled": bool(calls) and not still_open,
            "threads": [read_thread(t, sources) for t in thread_ids(dish)]}


def place(v):
    """Where a ticket sits: the spike once its receipt is filed, an On hold group, or its stage column.
    A call never moves a ticket: it stays in its column and shows at the pass as well."""
    d = v["dish"]
    if d.get("plated"):
        return "Verified"
    if d.get("close") in CLOSE:
        return CLOSE[d["close"]]
    if v["gate"] in GATES:
        return v["gate"]
    return "Not checked" if v["gate"] == "not checked" else "PR closed"


def at_pass(v):
    """A ticket needs the chef: a call waits on him, or it sits at Ready to merge."""
    return bool(v["open"]) or place(v) == "Ready to merge"


def waiting_since(v):
    """When a ticket started waiting at the pass: its oldest open call, else the time it reached Ready to merge."""
    return (v["open"][0].get("asked") if v["open"] else (v["dish"].get("plating") or {}).get("at")) or "~"


def title(v):
    """Linear's title, else the board's outcome, else the dish id."""
    d = v["dish"]
    return v["issue"]["title"] if v["issue"] else (d.get("outcome") or d.get("id") or "Untitled dish")


def recommended(call):
    """Index of the option the expo recommends ("a" picks "a. Send it out"), or None."""
    rec = (call.get("recommend") or "").strip().lower()
    for i, o in enumerate(call.get("options", [])):
        o = o.strip().lower()
        if rec and (o == rec or o[:len(rec) + 1] in (rec + ".", rec + ")")):
            return i
    return None


def tile_note(v):
    """The one component note a tile shows: a failure first, then a wait, then any other note."""
    notes = [n for _, _, _, n in v["rows"] if n and n != "checks green"]
    if not notes:
        return ""
    rank = lambda n: 0 if "failed" in n or "not checked" in n else 1 if "pending" in n else 2  # noqa: E731
    worst = min(notes, key=rank)
    return '<span class="tnote t-%s">%s</span>' % (("red", "orange", "gray")[rank(worst)], e(worst))


def tile(v, quiet=False):
    """A ticket in its column. A button: a click, Return, or Space opens its plate.
    A ticket at the pass carries a blue edge and the blue cloche."""
    d = v["dish"]
    ruled = '<span class="ruled">%sRuled</span>' % svg("check") if v["ruled"] else ""
    mark = ('%s<span class="vh">At the pass.</span>' % svg("cloche", "ic at-ic")) if at_pass(v) else ""
    return ('<button type="button" class="tile%s%s" data-dish="%s" data-plate="p%d" aria-haspopup="dialog">'
            '<span class="tile-top">%s%s</span><span class="t">%s</span><span class="meta"><span class="id">%s</span>%s%s%s</span></button>'
            % (" quiet" if quiet else "", " at" if mark else "", e(d.get("id", ""), quote=True), v["n"], project_tag(d), mark,
               e(title(v)), e(d.get("id", "")), thread_pill(v.get("threads"), quiet or bool(d.get("plated"))), tile_note(v), ruled))


def call_tile(v):
    """A ticket at the pass: its oldest open call, large. A ticket at Ready to merge with no call waits for the chef's look."""
    d = v["dish"]
    if not v["open"]:
        return ('<button type="button" class="tile call-tile" data-dish="%s" data-plate="p%d" aria-haspopup="dialog">'
                '<span class="ct-top">%s<span class="id">%s</span><span class="age">%s</span></span>'
                '<span class="q">%s</span><span class="ct-foot"><span class="pick">Ready for your look</span>'
                '<span class="gate">Ready to merge</span></span></button>'
                % (e(d.get("id", ""), quote=True), v["n"], project_tag(d), e(d.get("id", "")),
                   e(clock((d.get("plating") or {}).get("at"))), e(title(v))))
    call = v["open"][0]
    plating = ' data-plating="%s"' % e(title(v), quote=True) if place(v) == "Ready to merge" else ""
    pics = call.get("images") or d.get("images")
    rec = recommended(call)
    pick = "Recommends <b>%s</b>" % e(call["options"][rec]) if rec is not None else "No recommendation"
    more = len(v["open"]) - 1
    flags = "".join([chip(CLOSE[d["close"]], CLOSE_TONE[CLOSE[d["close"]]]) if d.get("close") in CLOSE else "",
                     chip("no visuals attached", "red") if needs_visuals(d, call) and not pics else "",
                     chip("%d more call%s" % (more, "s" if more > 1 else ""), "blue") if more else ""])
    thumbs = "".join('<img src="%s" alt="">' % e(src, quote=True) for src, _, _ in images(pics) if src)
    return ('<button type="button" class="tile call-tile" data-dish="%s" data-plate="p%d"%s aria-haspopup="dialog">'
            '<span class="ct-top">%s<span class="id">%s</span><span class="age">%s</span></span>'
            '<span class="q">%s</span>%s%s<span class="ct-foot"><span class="pick">%s</span>'
            '<span class="gate">%s</span></span></button>'
            % (e(d.get("id", ""), quote=True), v["n"], plating, project_tag(d), e(d.get("id", "")), e(clock(call.get("asked"))),
               e(call.get("question", "")), '<span class="flags">%s</span>' % flags if flags else "",
               '<span class="thumbs">%s</span>' % thumbs if thumbs else "", pick, e(v["gate"])))


def gate_track(gate):
    """The stages as one bar, filled up to the ticket's stage. A held ticket fills none."""
    at = GATES.index(gate) if gate in GATES else -1
    steps = "".join('<li class="%s"%s>%s</li>' % ("now" if i == at else "past" if i < at else "",
                                                  ' aria-current="step"' if i == at else "", g)
                    for i, g in enumerate(GATES))
    return '<ol class="track" aria-label="Stages">%s</ol>' % steps


def call_key(dish, call):
    """Stable id for one call: the dish id and the question."""
    return hashlib.sha1((dish.get("id", "") + "\n" + call.get("question", "")).encode()).hexdigest()[:12]


def load_answers(path=None):
    out = {}
    try:
        with open(path or ANSWERS) as f:
            for line in f:
                try:
                    rec = json.loads(line)
                    if rec.get("failed"):
                        out.pop(rec["key"], None)  # a failed send frees the call for another click
                    else:
                        out[rec["key"]] = rec
                except (ValueError, KeyError):
                    continue
    except OSError:
        pass
    return out


def load_allow(path=None):
    """(logins, device tailnet IPs) from lines "login <email>" and "device <100.x.y.z>". No file: nobody."""
    logins, devices = set(), set()
    try:
        with open(path or ALLOW) as f:
            for line in f:
                kind, _, value = line.strip().partition(" ")
                if kind == "login" and value.strip():
                    logins.add(value.strip())
                elif kind == "device" and value.strip():
                    devices.add(value.strip())
    except OSError:
        pass
    return logins, devices


# One `netstat -anv -p tcp` row: local and foreign address, then "process:pid" before the hex state column.
# Process names can hold spaces ("Google Chrome He:1349"), so the name is everything up to the last ":pid".
NETSTAT_ROW = re.compile(r"^tcp4\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+\S+\s+\d+\s+\d+\s+\d+\s+\d+\s+.+:(\d+)\s+[0-9a-f]{5}\s")


def peer_pids(table, peer_port, server_port):
    """PIDs that netstat names for the client end of one loopback connection to the pass."""
    want = ("127.0.0.1.%d" % peer_port, "127.0.0.1.%d" % server_port)
    return {int(m.group(3)) for m in map(NETSTAT_ROW.match, table.splitlines()) if m and m.group(1, 2) == want}


def process_uid(pid):
    """The uid a live process runs as, or None if ps cannot read it (the process has exited)."""
    out = subprocess.run(["/bin/ps", "-o", "uid=", "-p", str(pid)], capture_output=True, text=True, timeout=10)
    try:
        return int(out.stdout.strip()) if out.returncode == 0 else None
    except ValueError:
        return None


def peer_is_local_process(peer_port, server_port=None, table=None, uid_of=None):
    """True unless netstat proves the TCP peer is a process of another user, so it came through Tailscale.

    `tailscale serve` connects from Tailscale's network extension, which runs as root. Every agent
    on this Mac runs as this user. The check fails closed: the peer counts as local when netstat
    shows no row for it, when any PID on it runs as this user, when a PID is 0 or has exited, or
    when netstat fails.

    lsof is not enough (CodeRabbit on ReviewWheel #2297): a client that half-closes or closes
    its socket right after it sends drops out of lsof's view. netstat still names the socket's
    last owner, Tailscale's included.
    """
    if table is None:
        out = subprocess.run(["/usr/sbin/netstat", "-anv", "-p", "tcp"], capture_output=True, text=True, timeout=10)
        if out.returncode != 0:
            return True
        table = out.stdout
    pids = peer_pids(table, peer_port, server_port or PORT)
    if not pids or 0 in pids:
        return True
    me = os.getuid()
    return any((uid_of or process_uid)(p) in (None, me) for p in pids)


def send_to_thread(thread, message):
    """Post through T3's own CLI, which signs in as a short-lived MCP client and revokes it after."""
    out = subprocess.run([T3_CLI, "thread", "send", thread, message], capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout).strip()[-300:] or "t3 exit %d" % out.returncode)


def answer(form, headers, board_path=None, sender=None, answers_path=None, allow_path=None,
           peer_port=None, peer_check=None, server_port=None):
    """Validate one click at the pass and relay it. Returns (http status, text).

    The answer is logged before the send, so a receiver that checks the log always finds it.
    A send that reaches no thread appends a "failed" line, which frees the call for another click.
    A logged answer is never sent twice. A send that reaches some threads but not all returns 207,
    so the page shows which thread missed it instead of a plain "sent".
    """
    # 1. The request must come through tailscale serve. Only then are its identity headers Tailscale's own.
    try:
        local = peer_check(peer_port) if peer_check else peer_is_local_process(peer_port, server_port)
    except Exception:  # noqa: BLE001 - fail closed
        local = True
    if local:
        return 403, "Answers come only through the tailnet. A process on this Mac cannot answer."
    # 2. Dan's login, from one of Dan's allowed devices (his phone and this Mac; the hard rule, not this list, keeps agents out).
    logins, devices = load_allow(allow_path)
    login = headers.get("Tailscale-User-Login") or ""
    device = (headers.get("X-Forwarded-For") or "").split(",")[-1].strip()
    if login not in logins or device not in devices:
        return 403, "Only Dan's login on an allowed device can answer at the pass."
    if not ORIGIN or headers.get("Origin") != ORIGIN:
        return 403, "Answers must come from the pass page."
    board, err = load_board(board_path or BOARD)
    if err:
        return 409, err
    key = (form.get("key") or [""])[0]
    found = [(d, c) for d in board["dishes"] for c in d.get("calls", []) if call_key(d, c) == key]
    if not found:
        return 409, "This call is no longer on the board. Reload the pass."
    dish, call = found[0]
    try:
        option = call.get("options", [])[int((form.get("option") or [""])[0])]
    except (ValueError, IndexError):
        return 400, "That option is not on this call."
    note = (form.get("note") or [""])[0].strip()[:2000]
    expo = ((board.get("service") or {}).get("expoThread")) or ""
    targets = [t for t in [call.get("thread"), expo] if t]
    targets = list(dict.fromkeys(targets))
    if not targets:
        return 409, "This call names no thread and no expo is on service."
    at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M ET")
    # The check names the log this pass really writes, so it holds for any BRIGADE_HOME or BRIGADE_ANSWERS.
    message = ('Dan ruled at the pass (%s, %s): "%s"\nCall: %s%s\nAnswer id %s. Check it before you act: '
               "grep %s %s. Expo: take this call off the board."
               % (dish.get("id", ""), at, option, call.get("question", ""), ("\nDan's note: " + note) if note else "", key, key,
                  shlex.quote(answers_path or ANSWERS)))
    with _send_lock:
        if key in load_answers(answers_path):
            return 409, "Already answered at the pass."
        log = answers_path or ANSWERS
        rec = {"key": key, "dish": dish.get("id"), "question": call.get("question"), "option": option, "note": note,
               "login": login, "at": at, "threads": targets}
        with open(log, "a") as f:
            f.write(json.dumps(rec) + "\n")
        sent, err = [], ""
        for t in targets:
            try:
                (sender or send_to_thread)(t, message)
                sent.append(t)
            except Exception as ex:  # noqa: BLE001 - the page shows the failure
                err = str(ex)[:300]
        if not sent:
            with open(log, "a") as f:
                f.write(json.dumps({"key": key, "failed": True, "at": at, "error": err}) + "\n")
            return 502, "Not sent: %s" % err
    if err:
        return 207, ('Sent "%s" to %d of %d threads. Failed: %s. The call stays answered. Tell the missing thread yourself.'
                     % (option, len(sent), len(targets), err))
    return 200, 'Sent "%s" to %d thread(s).' % (option, len(sent))


def render_answer(dish, call, answers):
    """Dan's side of a call: the options as buttons, an optional note, and one confirm step before the send.
    An answered call shows its answer instead, with no buttons."""
    key = call_key(dish, call)
    done = answers.get(key)
    if done:
        return ('<div class="decide done"><p class="decide-h">Your call</p><p class="result ok">%s'
                '<span>You answered <b>%s</b> at %s.</span></p></div>' % (svg("check"), e(done["option"]), e(done["at"])))
    rec = recommended(call)
    opts = "".join('<button type="button" class="opt" aria-pressed="false" data-label="%s"><span class="opt-t">%s</span>%s%s</button>'
                   % (e(o, quote=True), e(o), '<span class="rec">Recommended</span>' if i == rec else "",
                      "<kbd>%d</kbd>" % (i + 1) if i < 9 else "")
                   for i, o in enumerate(call.get("options", [])))
    return ('<form class="decide" method="post" action="/answer"><input type="hidden" name="key" value="%s">'
            '<input type="hidden" name="option" value=""><p class="decide-h">Your call</p>'
            '<div class="opts" role="group" aria-label="Options">%s</div>'
            '<label class="note"><span>Note <span class="muted">optional, sent with your answer</span></span>'
            '<textarea name="note" rows="2" maxlength="2000" placeholder="Add a note"></textarea></label>'
            '<div class="confirm" hidden><p>Send <b class="what"></b>?</p>'
            '<p class="muted">It goes to the owning thread and the expo.</p><div class="confirm-b">'
            '<button type="button" class="btn" data-cancel>Cancel<kbd>esc</kbd></button>'
            '<button type="submit" class="btn fill" data-send><span>Send</span><kbd>&#8617;</kbd></button></div></div>'
            '<p class="result" role="status" tabindex="-1"></p></form>'
            % (key, opts or '<p class="muted">This call lists no options. Ask the expo.</p>'))


def render_call(v, call, answers, i, count):
    """One call in a plate: what Dan is asked and why, beside his decision panel."""
    d = v["dish"]
    done = call_key(d, call) in answers
    label = ("Answered" if done else "Call for you") + (" (%d of %d)" % (i + 1, count) if count > 1 else "")
    pics = call.get("images") or d.get("images")
    asked, ago = clock(call.get("asked")), waited(call.get("asked"))
    meta = ["Asked %s%s" % (e(asked), ", %s ago" % ago if ago else "")] if asked else []
    if call.get("thread"):
        meta.append(link(thread_url(call["thread"]), "Owning thread", out=True))
    return ('<section class="call"><div class="call-main"><p class="kicker"><b class="%s">%s</b>%s</p>'
            '<h3 class="call-q">%s</h3>%s<div class="prose">%s</div>%s%s</div>%s</section>'
            % ("t-green" if done else "", label, "".join("<span>%s</span>" % m for m in meta), e(call.get("question", "")),
               chip("no visuals attached", "red") if needs_visuals(d, call) and not pics else "",
               render_text(call.get("context")) or '<p class="muted">No context written. Ask the expo.</p>',
               render_images(pics), render_links(call.get("links")), render_answer(d, call, answers)))


def render_rows(v):
    """Each area of a dish (the board's "station" field): its gate, PR, thread, prep, and the PR description."""
    out = []
    for comp, pr, g, note in v["rows"]:
        bits = []
        if pr:
            bits.append(link(pr["url"], "#%d %s" % (pr["number"], pr["title"])))
        elif comp.get("pr"):
            bits.append(e("#%s" % comp["pr"]))
        if comp.get("thread"):
            bits.append(link(thread_url(comp["thread"]), "Thread", out=True))
        if comp.get("prep"):
            bits.append('<span class="id">%s</span>' % e(comp["prep"]))
        body = ((pr or {}).get("body") or "").strip()
        desc = ('<details class="pr" open><summary>PR #%d description</summary><div class="prose">%s%s</div></details>'
                % (pr["number"], render_text(body[:4000]), "<p>...</p>" if len(body) > 4000 else "")) if body else ""
        out.append('<li><p class="row-h"><b>%s</b>%s<span class="muted">%s</span><span class="repo">%s</span></p>'
                   '<p class="row-l">%s</p>%s</li>'
                   % (e(comp.get("station", "")), chip(g), e(note), e(comp_repo(comp, v["dish"]) or "no repo"), " · ".join(bits), desc))
    return '<section class="sect"><h3>Areas</h3><ul class="rows">%s</ul></section>' % "".join(out) if out else ""


def render_threads(v):
    """Each T3 thread on a dish: its state, its title as a link, the areas it carries, and its last update."""
    out = []
    for th in v.get("threads") or []:
        rec = th["rec"] or {}
        stations = list(dict.fromkeys(c.get("station") for c in v["dish"].get("components", [])
                                      if c.get("thread") == th["id"] and c.get("station")))
        bits = ([", ".join(stations)] if stations else []) + ([rec["model"]] if rec.get("model") else [])
        if th["mins"] is not None:
            bits.append("updated %s ago" % span(th["mins"]))
        out.append('<li><p class="row-h">%s%s</p>%s</li>'
                   % (chip(thread_label(th), THREAD_TONE[th["state"]]), link(thread_url(th["id"]), rec.get("title") or "Thread", out=True),
                      '<p class="row-l">%s</p>' % e(" · ".join(bits)) if bits else ""))
    return '<section class="sect"><h3>Threads</h3><ul class="rows">%s</ul></section>' % "".join(out) if out else ""


def plate(v, answers):
    """Everything about one dish, in a modal sheet: calls first, then notes, then stations."""
    d, issue, n = v["dish"], v["issue"], v["n"]
    did = d.get("id") or "no id"
    if issue:
        ident, state = link(issue["url"], did), chip(issue["state"]["name"], "gray")
    else:
        ident, state = e(did), (chip("Linear not checked", "red") if d.get("id") else "")
    calls = d.get("calls") or []
    parts = [render_call(v, c, answers, i, len(calls)) for i, c in enumerate(calls)]
    notes = render_text(d.get("context"))
    if all(c.get("images") for c in calls):  # else a call already shows the dish images
        notes += render_images(d.get("images"))
    notes += render_links(d.get("links"))
    if d.get("plated"):
        p = d["plated"]
        notes += '<p class="plated">%s<span>Verified %s.</span> %s</p>' % (
            svg("check"), e(clock(p.get("at", ""))), link(p.get("receipt", "#"), "Receipt", out=True))
    if notes:
        parts.append('<section class="sect"><h3>Notes</h3><div class="prose">%s</div></section>' % notes)
    parts.append(render_threads(v))
    parts.append(render_rows(v))
    sub = '<p class="outcome">%s</p>' % e(d["outcome"]) if issue and d.get("outcome") else ""
    off = "" if v["gate"] in GATES else chip(v["gate"])
    close = chip(CLOSE[d["close"]], CLOSE_TONE[CLOSE[d["close"]]]) if d.get("close") in CLOSE else ""
    return ('<dialog class="plate" id="p%d" aria-labelledby="p%d-t"><div class="plate-bar">%s'
            '<span class="id">%s</span>%s%s<button type="button" class="close" data-close aria-label="Close">'
            '<kbd>esc</kbd>%s</button></div><div class="plate-scroll" tabindex="-1"><header class="plate-h"><h2 id="p%d-t">%s</h2>%s'
            '<div class="gates">%s%s</div></header>%s</div></dialog>'
            % (n, n, project_tag(d), ident, state, close, svg("x"), n, e(title(v)), sub, gate_track(v["gate"]), off,
               "".join(parts)))


def mark(name):
    """A project's lettered mark. Its hue comes from the name, so it never changes."""
    hue = int(hashlib.sha1(name.encode()).hexdigest(), 16) % 360
    return '<i class="pm" style="--h:%d" aria-hidden="true">%s</i>' % (hue, e(name[:1].upper()))


def render_menu(views, project):
    """The project menu: All projects, with no icon, then each project on the board, with its ticket count."""
    counts = {}
    for v in views:
        for name in projects(v["dish"]):
            counts[name] = counts.get(name, 0) + 1
    rows = [("/", "", "All projects", len(views), not project)]
    rows += [("/?p=" + urllib.parse.quote(name), mark(name), name, n, name == project) for name, n in sorted(counts.items())]
    items = "".join('<a href="%s"%s>%s<span>%s</span><span class="n">%d</span></a>'
                    % (e(href, quote=True), ' aria-current="page"' if on else "", m, e(name), n) for href, m, name, n, on in rows)
    cur = [r for r in rows if r[4]][0]
    return ('<details class="pmenu"><summary>%s<span>%s</span><span class="n">%d</span>%s</summary>'
            '<nav class="pmenu-l" aria-label="Projects">%s</nav></details>' % (cur[1], e(cur[2]), cur[3], svg("chev"), items))


def render_bar(stats, menu, sources):
    """The header: the logo, the counts, and the project menu. A failed source also gets a strip below it."""
    bad = [(k, v) for k, v in sources.items() if v != "ok"]
    strip = ('<div class="strip" role="status">%s%s</div>'
             % (svg("warn"), "".join("<span><b>%s</b> %s</span>" % (e(k), e(v)) for k, v in bad))) if bad else ""
    counts = "".join('<li class="stat">%s <b>%d</b></li>' % (k, n) for k, n in stats)
    return ('<header class="bar"><h1 class="logo">%s<span class="vh">Yes Chef</span></h1>'
            '<ul class="stats" aria-label="Counts">%s</ul>%s</header>%s' % (svg("cloche"), counts, menu, strip))


def render_pass(waiting):
    """The Pass: every ticket that needs the chef, oldest first. Calls at any stage, and every ticket at Ready to merge."""
    if waiting:
        body = "".join(call_tile(v) for v in waiting)
        sub = "Needs your focus. Oldest first."
    else:
        body = '<div class="clear">%s<p><b>All clear</b></p><p class="muted">Nothing needs you.</p></div>' % svg("cloche")
        sub = "Calls and plates for you land here."
    return ('<section class="head" aria-labelledby="head-t"><header class="head-h"><h2 id="head-t">%sThe Pass</h2>'
            '%s<p class="muted">%s</p></header><div class="head-b">%s</div><p class="head-keys">'
            '<span><kbd>&#8593;</kbd><kbd>&#8595;</kbd> Move</span><span><kbd>&#8617;</kbd> Open</span>'
            '<span><kbd>1</kbd>&#8211;<kbd>9</kbd> Pick</span><button type="button" data-keys><kbd>?</kbd> All shortcuts</button></p></section>'
            % (svg("cloche"), '<span class="badge">%d</span>' % len(waiting) if waiting else "", sub, body))


def render_spike(done):
    """Tickets with a receipt filed, on the spike at the end of Merged."""
    if not done:
        return ""
    return ('<div class="spike"><p class="spike-h">%s<b>Verified</b><span class="n">%d</span></p>%s</div>'
            % (svg("done"), len(done), "".join(tile(v, quiet=True) for v in done)))


def render_rail(spots):
    """One column per stage, left to right. Merged ends in the spike."""
    trays = []
    for g in GATES:
        here = spots.get(g, [])
        trays.append('<section class="tray" aria-label="%s: %d"><header class="tray-h"><span class="g"><i class="gd c-%s"></i>'
                     '%s</span><span class="n">%d</span><span class="hint">%s</span></header><div class="tray-b">%s%s</div></section>'
                     % (g, len(here), CHIP[g], g, len(here), GATE_HINT[g], "".join(tile(v) for v in here),
                        render_spike(spots.get("Verified", [])) if g == "Merged" else ""))
    gatebar = "".join('<button type="button" data-gate="%d"><b>%d</b>%s</button>' % (i, len(spots.get(g, [])), g)
                      for i, g in enumerate(GATES))
    return ('<section class="rail-wrap" aria-label="Stages"><div class="gatebar" role="group" aria-label="Go to a stage">%s</div>'
            '<div class="rail">%s</div></section>' % (gatebar, "".join(trays)))


def render_shelf(spots):
    """On hold tickets: out of the stages, never hidden. A stage that was not checked is red; a closed PR or a canceled
    ticket wears GitHub's closed red."""
    held = [name for name in HELD if spots.get(name)]
    groups = "".join('<div class="grp"><h3 class="%s">%s <span class="muted">%d</span></h3>%s</div>'
                     % ("t-red" if name == "Not checked" else "t-closed" if name in ("PR closed", "Canceled") else "", e(name), len(spots[name]),
                        "".join(tile(v, quiet=True) for v in spots[name]))
                     for name in held)
    return ('<section class="shelf" aria-labelledby="shelf-t"><h2 class="sec" id="shelf-t">On hold<span class="muted">%d</span></h2>'
            '<div class="groups">%s</div></section>' % (sum(len(spots[n]) for n in held), groups)) if groups else ""


def render(board_path=BOARD, project=None):
    """The whole page. project: a short repo name from the project menu, or None for All projects."""
    sources = {"Board": "ok", "GitHub": "ok", "Linear": "ok", "T3": "ok"}
    board, err = load_board(board_path)
    if err:
        sources["Board"] = err
        board = {"service": None, "dishes": []}
    for d in board["dishes"]:
        if board.get("repo"):
            d.setdefault("repo", board["repo"])
    answers = load_answers()
    # Each T3, GitHub, or Linear read takes up to a second or more, so warm the cache with every thread, PR, and issue at once, in parallel.
    # The reads below then hit the cache. Errors stay in the cache, so they still reach the lamps.
    ids = list(dict.fromkeys(t for d in board["dishes"] for t in thread_ids(d)))
    prs = list(dict.fromkeys((comp_repo(c, d), c["pr"]) for d in board["dishes"] for c in d.get("components", [])
                             if c.get("pr") and comp_repo(c, d)))
    reads = [(("thread", t), lambda t=t: fetch_thread(t)) for t in ids] + \
            [(("pr", r, n), lambda r=r, n=n: fetch_pr(n, r)) for r, n in prs] + \
            [(("linear", d["id"]), lambda i=d["id"]: fetch_linear(i)) for d in board["dishes"] if d.get("id")]
    if reads:
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda kf: cached(*kf), reads))
    views = [read_dish(d, sources, answers) for d in board["dishes"]]  # every other source read happens here
    for n, v in enumerate(views):
        v["n"] = n
    if project and not any(project in projects(v["dish"]) for v in views):
        project = None  # a project with no tickets on the board: show All projects
    shown = [v for v in views if not project or project in projects(v["dish"])]
    spots = {}
    for v in shown:
        spots.setdefault(place(v), []).append(v)
    waiting = sorted((v for v in shown if at_pass(v)), key=waiting_since)
    today = datetime.datetime.now().date()
    verified_today = sum(1 for v in spots.get("Verified", []) if (when(v["dish"]["plated"].get("at", "")) or datetime.datetime.min).date() == today)
    stats = [("Active", sum(len(spots.get(g, [])) for g in GATES)), ("Verified today", verified_today),
             ("On hold", sum(len(spots.get(h, [])) for h in HELD))]
    at = now_et()
    lamps = "".join('<li class="%s"><i></i>%s<span class="vh">: %s</span></li>'
                    % ("ok" if v == "ok" else "bad", e(k), "ok" if v == "ok" else "not checked") for k, v in sources.items())
    # On the phone, once the pass scrolls away, the oldest ticket there stays one tap away, in thumb reach.
    pill = ('<button type="button" class="pill away" data-pill data-plate="p%d">%s<span>Open the oldest</span>'
            '<span class="badge">%d</span></button>' % (waiting[0]["n"], svg("cloche"), len(waiting))) if waiting else ""
    app = ('<main id="app" data-at="%s">%s<p class="stale" id="stale" role="status" hidden></p><div class="board">%s%s%s</div>'
           '<footer class="foot"><ul class="lamps" aria-label="Sources">%s</ul><span class="upd">Updated %s. '
           'The board updates every minute while no plate is open.</span></footer>%s%s</main>'
           % (at, render_bar(stats, render_menu(views, project), sources), render_rail(spots), render_pass(waiting),
              render_shelf(spots), lamps, at, pill, "".join(plate(v, answers) for v in shown)))
    return PAGE.replace("@@title@@", "Yes Chef" + (" (%d)" % len(waiting) if waiting else "")).replace("@@app@@", app)


CSS = r"""
:root{color-scheme:light dark;
--bg:#F2F2F7;--well:#E5E5EA;--card:#FFFFFF;--card2:#F7F7FA;--inset:#F2F2F7;
--label:#1D1D1F;--label2:#636366;--sep:rgba(60,60,67,.16);--fill:rgba(118,118,128,.12);--fill2:rgba(118,118,128,.24);
--accent:#0071E3;--link:#0066CC;--focus:#007AFF;
--green:#1F7A35;--orange:#B24C00;--red:#C8001A;--gray:#636366;--blue:#005CBF;
--green-t:rgba(52,199,89,.15);--orange-t:rgba(255,149,0,.15);--red-t:rgba(255,59,48,.10);--blue-t:rgba(0,122,255,.10);--indigo:#4B44C8;--indigo-t:rgba(88,86,214,.12);--open:#1A7F37;--open-t:rgba(26,127,55,.12);--merged:#8250DF;--merged-t:rgba(130,80,223,.12);--closed:#D1242F;--closed-t:rgba(209,36,47,.10);--pass:#0071E3;--pass-t:rgba(0,113,227,.10);--gray-t:rgba(118,118,128,.13);
--mat:rgba(242,242,247,.8);--matsheet:rgba(255,255,255,.86);
--sh1:0 0 0 .5px rgba(0,0,0,.05),0 1px 3px rgba(0,0,0,.08);
--sh2:0 0 0 .5px rgba(0,0,0,.05),0 6px 18px rgba(0,0,0,.10);
--sh3:0 0 0 .5px rgba(0,0,0,.05),0 18px 50px rgba(0,0,0,.10);
--sh4:0 0 0 .5px rgba(0,0,0,.08),0 32px 100px rgba(0,0,0,.30);
--sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","Segoe UI",Roboto,system-ui,sans-serif;
--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono","Liberation Mono",monospace}
@media (prefers-color-scheme:dark){:root{
--bg:#1C1C1E;--well:#161618;--card:#2C2C2E;--card2:#3A3A3C;--inset:#242426;
--label:#F5F5F7;--label2:#AEAEB2;--sep:rgba(235,235,245,.13);--fill:rgba(118,118,128,.24);--fill2:rgba(118,118,128,.36);
--accent:#0071E3;--link:#5AA9FF;--focus:#0A84FF;
--green:#30D158;--orange:#FF9F0A;--red:#FF938A;--gray:#C7C7CC;--blue:#7CBBFF;
--green-t:rgba(48,209,88,.15);--orange-t:rgba(255,159,10,.15);--red-t:rgba(255,69,58,.13);--blue-t:rgba(10,132,255,.14);--indigo:#A5A2FF;--indigo-t:rgba(94,92,230,.2);--open:#3FB950;--open-t:rgba(46,160,67,.18);--merged:#AB7DF8;--merged-t:rgba(171,125,248,.18);--closed:#F85149;--closed-t:rgba(248,81,73,.15);--pass:#3B9BFF;--pass-t:rgba(10,132,255,.16);--gray-t:rgba(118,118,128,.2);
--mat:rgba(28,28,30,.8);--matsheet:rgba(44,44,46,.88);
--sh1:0 0 0 .5px rgba(255,255,255,.07),0 1px 3px rgba(0,0,0,.45);
--sh2:0 0 0 .5px rgba(255,255,255,.09),0 8px 22px rgba(0,0,0,.5);
--sh3:0 0 0 .5px rgba(255,255,255,.08),0 18px 50px rgba(0,0,0,.45);
--sh4:0 0 0 .5px rgba(255,255,255,.1),0 36px 110px rgba(0,0,0,.6)}}
*{box-sizing:border-box}
html,body{background:var(--bg)}
body{margin:0;color:var(--label);font:15px/1.45 var(--sans);letter-spacing:-.006em;-webkit-font-smoothing:antialiased}
body:has(dialog[open]){overflow:hidden}
h1,h2,h3,p,figure{margin:0}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
a .ic{width:.85em;height:.85em;margin-left:2px;vertical-align:-.05em}
button{font:inherit;color:inherit}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.ic{width:1em;height:1em;flex:none}
.id{font-family:var(--mono);font-size:11px;letter-spacing:-.01em}
.muted{color:var(--label2)}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
kbd{font:500 12px/1 var(--sans);color:var(--label2);letter-spacing:.03em}
.chip{display:inline-flex;align-items:center;font-size:11px;font-weight:600;line-height:1.3;padding:2px 8px;border-radius:999px;white-space:nowrap;letter-spacing:0}
.c-gray{color:var(--gray);background:var(--gray-t)}.c-green{color:var(--green);background:var(--green-t)}
.c-amber{color:var(--orange);background:var(--orange-t)}.c-red{color:var(--red);background:var(--red-t)}
.c-blue{color:var(--blue);background:var(--blue-t)}.c-indigo{color:var(--indigo);background:var(--indigo-t)}
.c-open{color:var(--open);background:var(--open-t)}.c-merged{color:var(--merged);background:var(--merged-t)}.c-closed{color:var(--closed);background:var(--closed-t)}
.t-red{color:var(--red)}.t-closed{color:var(--closed)}.t-orange{color:var(--orange)}.t-gray{color:var(--label2)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:40px;padding:0 16px;border:0;border-radius:10px;background:var(--fill);font-size:15px;font-weight:500;cursor:pointer;transition:background .15s}
.btn:hover{background:var(--fill2)}
.btn.sm{min-height:30px;padding:0 12px;border-radius:8px;font-size:13px}
.btn.fill{background:var(--accent);color:#fff;font-weight:600}
.btn.fill:hover{background:#0068D1}
.btn.fill kbd{color:#fff}
.btn:disabled{opacity:.55;cursor:default}

.bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;min-height:64px;padding:10px 24px 4px}
.logo{display:grid;place-items:center;flex:none;width:34px;height:34px;border-radius:9px;color:#fff;background:linear-gradient(180deg,#3B9BFF,#0066D6);box-shadow:inset 0 0 0 .5px rgba(0,0,0,.12)}
/* Lifted 1 px so the cloche itself is centred on the tile, not its 24-unit box (2026-11-08). */
.logo .ic{position:relative;top:-1px;width:22px;height:22px}
.stats{display:flex;gap:8px;margin:0;padding:0;list-style:none}
.stat{display:inline-flex;align-items:baseline;gap:6px;padding:4px 10px;border-radius:8px;background:var(--fill);font-size:12.5px;font-weight:500;color:var(--label2)}
.stat b{font-size:13px;font-weight:700;color:var(--label);font-variant-numeric:tabular-nums}
.pmenu{position:relative;margin-left:auto}
.pmenu summary{display:flex;align-items:center;gap:8px;min-height:34px;padding:0 10px 0 12px;border-radius:9px;background:var(--fill);font-size:14px;font-weight:600;list-style:none;cursor:pointer}
.pmenu summary::-webkit-details-marker{display:none}
.pmenu summary:hover{background:var(--fill2)}
.pmenu .n{margin-left:auto;padding-left:6px;font-weight:500;color:var(--label2);font-variant-numeric:tabular-nums}
.pmenu summary .ic{width:12px;height:12px;color:var(--label2)}
.pmenu-l{position:absolute;top:42px;right:0;z-index:7;display:flex;flex-direction:column;width:280px;padding:6px;border-radius:12px;background:var(--card);box-shadow:var(--sh3)}
.pmenu-l a{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:7px;color:var(--label);font-size:14px;text-decoration:none}
.pmenu-l a:hover{background:var(--fill)}
.pmenu-l a[aria-current]{font-weight:600}
.pmenu-l a:first-child{margin-bottom:6px;box-shadow:0 6px 0 -5.5px var(--sep)}
.lamps{display:flex;gap:12px;margin:0;padding:0;list-style:none}
.lamps li{display:flex;align-items:center;gap:6px}
.lamps i{width:6px;height:6px;border-radius:50%;background:var(--green)}
.lamps .bad{color:var(--red);font-weight:600}.lamps .bad i{background:var(--red)}
.strip{display:flex;flex-wrap:wrap;align-items:center;gap:4px 18px;margin:6px 24px 0;padding:10px 14px;border-radius:12px;background:var(--card);box-shadow:var(--sh1);font-size:13px;color:var(--label2)}
.strip .ic{width:16px;height:16px;color:var(--red)}
.strip b{color:var(--red);font-weight:600}
.stale{margin:10px 24px 0;padding:9px 14px;border-radius:12px;background:var(--orange-t);font-size:13px}
.stale[hidden]{display:none}

/* The stages and the pass fit the window; each column scrolls on its own (Dan, 2026-11-06). */
.board{--rowh:max(440px,calc(100vh - 150px));--rowh:max(440px,calc(100dvh - 150px));display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,400px);grid-template-areas:"rail head" "shelf shelf";align-items:stretch;gap:28px 24px;padding:8px 24px 8px}
.sec{display:flex;align-items:baseline;gap:10px;margin:2px 0 12px;font-size:20px;line-height:1.2;font-weight:700;letter-spacing:-.02em}
.sec .muted{font-size:13px;font-weight:500;letter-spacing:0}

.rail-wrap{grid-area:rail;display:flex;flex-direction:column;min-width:0;height:var(--rowh)}
.rail{flex:1;min-height:0;display:grid;grid-template-columns:repeat(6,minmax(132px,1fr));grid-template-rows:minmax(0,1fr);gap:12px;overflow-x:auto;overflow-y:hidden;padding:3px;margin:-3px}
.tray{position:relative;display:flex;flex-direction:column;min-height:0;padding:8px;border-radius:16px;background:var(--well)}
.tray:not(:last-child)::after{content:"";position:absolute;right:-8.5px;top:19px;width:5px;height:5px;border:solid var(--label2);border-width:1.5px 1.5px 0 0;transform:rotate(45deg);opacity:.7}
.tray-h{display:flex;flex-wrap:wrap;align-items:center;gap:0 6px;padding:5px 5px 11px}
.tray-h .g{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600}
.tray-h .n{margin-left:auto;font-size:13px;color:var(--label2);font-variant-numeric:tabular-nums}
.tray-h .hint{flex-basis:100%;margin-top:1px;font-size:11px;color:var(--label2)}
.gd{width:8px;height:8px;border-radius:50%}
.gd.c-gray{background:var(--gray)}.gd.c-amber{background:var(--orange)}.gd.c-blue{background:var(--pass)}.gd.c-green{background:var(--green)}.gd.c-indigo{background:var(--indigo)}.gd.c-open{background:var(--open)}.gd.c-merged{background:var(--merged)}.gd.c-closed{background:var(--closed)}
.tray-b{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;overflow-y:auto;overscroll-behavior:contain;margin:0 -4px;padding:2px 4px 4px}
.spike{margin-top:auto;display:flex;flex-direction:column;gap:6px;padding:10px 8px 6px;border-top:1px dashed var(--fill2)}
.spike-h{display:flex;align-items:center;gap:7px;padding:0 3px;font-size:12px;color:var(--label2)}
.spike-h .ic{width:16px;height:16px;color:var(--green);stroke-width:2}
.spike-h b{color:var(--label);font-weight:600}
.spike-h .n{margin-left:auto;font-variant-numeric:tabular-nums}

.tile{display:flex;flex-direction:column;align-items:stretch;gap:5px;width:100%;margin:0;padding:10px 11px;border:0;border-radius:12px;background:var(--card);box-shadow:var(--sh1);text-align:left;cursor:pointer;transition:box-shadow .2s,transform .2s}
.tile:hover{box-shadow:var(--sh2);transform:translateY(-1px)}
.tile:active{transform:scale(.985)}
.tile .t{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;font-size:13px;line-height:1.3;font-weight:600}
.tile-top{display:flex;align-items:center;gap:6px;min-width:0}
.proj{display:flex;align-items:center;gap:6px;min-width:0;font-size:11px;font-weight:500;color:var(--label2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.at-ic{width:16px;height:16px;margin-left:auto;color:var(--pass);stroke-width:2}
.tile.at{box-shadow:inset 3px 0 0 var(--pass),var(--sh1)}
.tile.at:hover{box-shadow:inset 3px 0 0 var(--pass),var(--sh2)}
.tile.quiet.at{box-shadow:inset 3px 0 0 var(--pass),inset 0 0 0 1px var(--sep)}
.pm{display:grid;place-items:center;flex:none;width:15px;height:15px;border-radius:4px;background:hsl(var(--h) 48% 42%);color:#fff;font:700 9px/1 var(--sans);font-style:normal}
.meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;font-size:11px;color:var(--label2)}
.tnote{font-weight:600}
.ruled{display:inline-flex;align-items:center;gap:3px;color:var(--green);font-weight:600}
.th{display:inline-flex;align-items:center;gap:5px;font-weight:600;color:var(--label2);white-space:nowrap}
.th i{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.th.k-green{color:var(--green)}.th.k-red{color:var(--red)}.th.k-amber{color:var(--orange)}
.th.k-green i{animation:beat 2.4s ease-in-out infinite}
@keyframes beat{50%{opacity:.3}}
.tile.quiet{background:transparent;box-shadow:inset 0 0 0 1px var(--sep);padding:8px 10px}
.tile.quiet:hover{background:var(--fill);transform:none;box-shadow:inset 0 0 0 1px var(--sep)}
.tile.quiet .t{font-weight:500;color:var(--label2);-webkit-line-clamp:2}

.head{grid-area:head;position:relative;display:flex;flex-direction:column;height:var(--rowh);border-radius:22px;background:var(--card);box-shadow:var(--sh3);overflow:hidden}
.head::before{content:"";position:absolute;inset:0 0 auto;height:180px;background:radial-gradient(90% 100% at 50% 0,var(--pass-t),transparent 72%);pointer-events:none}
.head-h{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;padding:20px 22px 14px}
.head-h h2{display:flex;align-items:center;gap:9px;font-size:22px;line-height:1.2;font-weight:700;letter-spacing:-.022em}
.head-h h2 .ic{width:24px;height:24px;color:var(--pass)}
.head-h p{flex-basis:100%;font-size:13px}
.badge{display:grid;place-items:center;min-width:26px;height:26px;padding:0 8px;border-radius:13px;background:var(--pass-t);color:var(--blue);font-size:14px;font-weight:700;font-variant-numeric:tabular-nums}
.head-b{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;gap:10px;padding:0 12px 12px;overflow:auto;overscroll-behavior:contain}
.head-keys{display:flex;flex-wrap:wrap;gap:4px 16px;padding:11px 22px 13px;border-top:.5px solid var(--sep);font-size:12px;color:var(--label2)}
.head-keys span,.head-keys button{display:inline-flex;align-items:baseline;gap:4px}
.head-keys button{padding:0;border:0;background:none;color:inherit;font-size:12px;cursor:pointer}
.head-keys kbd{color:var(--label)}
.call-tile{gap:9px;padding:14px 16px 13px;border-radius:16px;background:var(--card2);box-shadow:inset 0 0 0 .5px var(--sep)}
.call-tile:hover{box-shadow:inset 0 0 0 .5px var(--sep),var(--sh2)}
.ct-top{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--label2)}
.ct-top .age{margin-left:auto;font-variant-numeric:tabular-nums}
.call-tile .q{font-size:17px;line-height:1.28;font-weight:600;letter-spacing:-.018em}
.flags{display:flex;flex-wrap:wrap;gap:6px}
.thumbs{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.thumbs img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:8px;box-shadow:0 0 0 .5px var(--sep)}
.ct-foot{display:flex;align-items:baseline;gap:8px;font-size:13px;color:var(--label2)}
.ct-foot b{color:var(--label);font-weight:600}
.ct-foot .gate{margin-left:auto;font-size:12px}
.sent-tag{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--green)}
.clear{display:flex;flex-direction:column;align-items:center;gap:2px;padding:36px 16px 44px;text-align:center}
.clear .ic{width:44px;height:44px;margin-bottom:8px;color:var(--label2)}

.shelf{grid-area:shelf;min-width:0}
.shelf .sec{font-size:20px}
.groups{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:16px}
.grp{display:flex;flex-direction:column;gap:8px}
.grp h3{font-size:13px;font-weight:600}
.foot{display:flex;flex-wrap:wrap;align-items:center;gap:6px 18px;margin-top:20px;padding:12px 24px 20px;border-top:.5px solid var(--sep);font-size:12px;color:var(--label2)}
.foot .upd{margin-left:auto}
.gatebar,.pill{display:none}

dialog{color:var(--label)}
.plate{width:min(1120px,calc(100vw - 48px));max-width:none;max-height:min(920px,calc(100vh - 48px));padding:0;border:0;border-radius:22px;background:var(--card);box-shadow:var(--sh4);overflow:hidden}
.plate[open]{display:flex;flex-direction:column;animation:rise .3s cubic-bezier(.2,.9,.25,1)}
.plate:focus,.plate-scroll:focus{outline:none}
.plate::backdrop,.keys::backdrop{background:rgba(0,0,0,.32);-webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px)}
@keyframes rise{from{opacity:0;transform:translateY(14px) scale(.985)}}
.plate-bar{flex:none;display:flex;align-items:center;gap:10px;min-height:56px;padding:8px 12px 8px 24px;border-bottom:.5px solid var(--sep);font-size:13px;color:var(--label2)}
.plate-bar .id{font-size:13px}
.close{display:inline-flex;align-items:center;gap:10px;margin-left:auto;padding:4px;border:0;border-radius:18px;background:none;cursor:pointer;color:var(--label2)}
.close .ic{width:30px;height:30px;padding:7px;border-radius:50%;background:var(--fill);color:var(--label)}
.close:hover .ic{background:var(--fill2)}
.plate-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
.plate-h{padding:26px 32px 8px}
.plate-h h2{font-size:30px;line-height:1.12;font-weight:700;letter-spacing:-.028em}
.outcome{margin-top:6px;font-size:17px;color:var(--label2)}
.gates{display:flex;align-items:center;gap:12px;margin-top:18px}
.track{display:grid;grid-template-columns:repeat(6,1fr);gap:4px;flex:1;max-width:620px;margin:0;padding:0;list-style:none}
.track li{position:relative;padding-top:11px;font-size:11px;font-weight:500;color:var(--label2)}
.track li::before{content:"";position:absolute;top:0;left:0;right:0;height:4px;border-radius:2px;background:var(--fill2)}
.track .past::before{background:var(--accent);opacity:.45}
.track .now{color:var(--label);font-weight:700}
.track .now::before{background:var(--accent)}
.call{display:grid;grid-template-columns:minmax(0,1fr) 344px;align-items:start;gap:36px;padding:22px 32px 30px}
.call+.call,.sect{border-top:.5px solid var(--sep)}
.kicker{display:flex;flex-wrap:wrap;gap:4px 10px;margin-bottom:6px;font-size:13px;color:var(--label2)}
.kicker b{color:var(--blue);font-weight:700}
.kicker b.t-green{color:var(--green)}
.call-q{margin-bottom:12px;font-size:22px;line-height:1.25;font-weight:700;letter-spacing:-.02em}
.call-q+.chip{margin:-2px 0 12px}
.prose{font-size:15px;line-height:1.55}
.prose p,.prose ul{margin:0 0 10px}
.prose ul{padding-left:20px}
.prose li{margin:3px 0}
.imgs{display:flex;flex-direction:column;gap:20px;margin:20px 0 6px}
.imgs img{display:block;width:100%;height:auto;border-radius:12px;box-shadow:0 0 0 .5px var(--sep),0 2px 12px rgba(0,0,0,.07)}
.imgs .missing{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:14px;border-radius:12px;background:var(--red-t)}
figcaption{margin-top:7px;font-size:12px;color:var(--label2)}
.links{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:10px;font-size:14px}
.decide{position:sticky;top:18px;display:flex;flex-direction:column;gap:12px;padding:16px;border-radius:18px;background:var(--inset)}
.decide-h{font-size:13px;font-weight:600;color:var(--label2)}
.opts{display:flex;flex-direction:column;gap:8px}
.opt{display:flex;align-items:center;gap:10px;min-height:50px;padding:10px 14px;border:0;border-radius:12px;background:var(--card);box-shadow:var(--sh1);font-size:15px;font-weight:500;text-align:left;cursor:pointer;transition:box-shadow .15s,background .15s}
.opt:hover{box-shadow:var(--sh2)}
.opt[aria-pressed="true"]{background:var(--blue-t);box-shadow:inset 0 0 0 2px var(--accent)}
.opt:disabled{cursor:default;opacity:.6}
.opt-t{flex:1}
.rec{padding:2px 8px;border-radius:999px;background:var(--blue-t);color:var(--blue);font-size:11px;font-weight:600;white-space:nowrap}
.opt kbd{min-width:10px;text-align:right}
.note{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600;color:var(--label2)}
.note .muted{font-weight:400}
.note textarea{display:block;width:100%;min-height:44px;padding:10px 12px;border:0;border-radius:10px;background:var(--card);box-shadow:inset 0 0 0 .5px var(--sep);font:400 15px/1.4 var(--sans);color:var(--label);resize:vertical}
.note textarea::placeholder{color:var(--label2)}
.confirm{display:flex;flex-direction:column;gap:4px;padding:14px;border-radius:14px;background:var(--card);box-shadow:var(--sh2);font-size:15px;animation:rise .2s ease-out}
.confirm[hidden]{display:none}
.confirm .muted{font-size:13px}
.confirm-b{display:flex;gap:8px;margin-top:10px}
.confirm-b .btn{flex:1}
.result{display:flex;align-items:flex-start;gap:8px;font-size:14px;font-weight:500}
.result:empty{display:none}
.result .ic{width:18px;height:18px;margin-top:1px}
.result.ok{color:var(--green)}.result.warn{color:var(--orange)}.result.bad{color:var(--red)}
.result:focus{outline:none}
.decide.done .result{padding:12px;border-radius:12px;background:var(--green-t);color:var(--label)}
.decide.done .result .ic{color:var(--green)}
.decide.done .result.warn{background:var(--orange-t)}
.sect{padding:22px 32px 30px}
.sect h3{margin-bottom:10px;font-size:13px;font-weight:600;color:var(--label2)}
.plated{display:flex;align-items:center;gap:6px}
.plated .ic{color:var(--green)}
.rows{margin:0;padding:0;list-style:none;border-radius:14px;background:var(--inset);overflow:hidden}
.rows li{padding:13px 16px}
.rows li+li{border-top:.5px solid var(--sep)}
.row-h{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:15px}
.row-h .muted{font-size:13px}
.repo{margin-left:auto;font-size:12px;color:var(--label2)}
.row-l{margin-top:4px;font-size:14px;color:var(--label2)}
.pr{margin-top:10px}
.pr summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--label2)}
.pr .prose{margin-top:8px;padding:12px 14px;border-radius:10px;background:var(--card);font-size:14px}
.pr .prose p:last-child{margin:0}

.keys{width:min(460px,calc(100vw - 32px));padding:0;border:0;border-radius:20px;background:var(--card);box-shadow:var(--sh4)}
.keys[open]{animation:rise .24s cubic-bezier(.2,.9,.25,1)}
.keys-in{padding:22px 22px 18px}
.keys h2{font-size:20px;font-weight:700;letter-spacing:-.02em}
.keys h3{margin:16px 0 4px;font-size:13px;font-weight:600;color:var(--label2)}
.keys dl{margin:0}
.keys dl div{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:.5px solid var(--sep);font-size:14px}
.keys dd{display:flex;gap:4px;margin:0}
.keys kbd{display:inline-grid;place-items:center;min-width:26px;height:24px;padding:0 7px;border-radius:6px;background:var(--fill);color:var(--label);font-size:13px}
.keys .btn{width:100%;margin-top:18px}

@media (max-width:1100px) and (min-width:761px){.board{grid-template-columns:minmax(0,1fr) 340px}}
@media (max-width:760px){
.bar{gap:10px;min-height:56px;padding:10px 16px 2px}
.stats{order:3;flex-basis:100%}
.head-keys,kbd{display:none}
.foot{padding-bottom:104px}
.foot .upd{margin-left:0}
.pill{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));z-index:6;display:flex;align-items:center;gap:10px;height:54px;padding:0 10px 0 18px;border:0;border-radius:27px;background:var(--accent);color:#fff;box-shadow:0 10px 30px rgba(0,60,140,.28),0 2px 6px rgba(0,0,0,.12);font-size:16px;font-weight:600;white-space:nowrap;transform:translateX(-50%);cursor:pointer;transition:opacity .2s,transform .25s}
.pill.away{visibility:hidden;opacity:0;transform:translate(-50%,24px);transition:opacity .2s,transform .25s,visibility 0s .25s}
.pill .ic{width:22px;height:22px}
.pill .badge{background:#fff;color:var(--accent)}
.gatebar{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:2px;margin:0 0 12px;padding:3px;border-radius:12px;background:var(--fill)}
.gatebar button{display:flex;flex-direction:column;align-items:center;gap:1px;min-height:44px;padding:5px 0 4px;border:0;border-radius:9px;background:none;font-size:10px;color:var(--label2);cursor:pointer;transition:background .2s}
.gatebar b{font-size:15px;line-height:1.2;color:var(--label);font-variant-numeric:tabular-nums}
.gatebar .on{background:var(--card);box-shadow:var(--sh1)}
.strip,.stale{margin:12px 16px 0}
.board{grid-template-columns:minmax(0,1fr);grid-template-areas:"head" "rail" "shelf";gap:26px;padding:10px 16px 4px}
.head{height:auto;max-height:none;border-radius:20px}
.rail-wrap{height:auto}
.tray-b{overflow:visible}
.head-h{padding:18px 18px 12px}
.head-b{padding:0 10px 10px}
.rail{grid-template-columns:none;grid-auto-flow:column;grid-auto-columns:168px;margin:-3px -16px;padding:3px 16px 6px;scroll-snap-type:x mandatory;scroll-padding:0 16px}
.tray{min-height:170px;scroll-snap-align:start}
.plate{width:100%;height:calc(100% - 10px);max-height:none;margin:auto 0 0;border-radius:16px 16px 0 0}
.plate[open]{animation-name:sheet}
.plate-bar{padding:6px 8px 6px 16px;min-height:52px}
.plate-h{padding:18px 16px 4px}
.plate-h h2{font-size:26px}
.outcome{font-size:16px}
.track li{font-size:10px}
.call{grid-template-columns:minmax(0,1fr);gap:18px;padding:18px 16px 0}
.decide{position:sticky;top:auto;bottom:0;gap:10px;margin:0 -16px;padding:14px 16px calc(14px + env(safe-area-inset-bottom));border-radius:20px 20px 0 0;background:var(--matsheet);-webkit-backdrop-filter:saturate(1.8) blur(20px);backdrop-filter:saturate(1.8) blur(20px);box-shadow:0 -.5px 0 var(--sep),0 -10px 30px rgba(0,0,0,.08)}
.note textarea{min-height:44px;height:44px}
.note textarea:focus{height:88px}
.sect{padding:20px 16px 28px}
.row-h .repo{margin-left:0;flex-basis:100%}
}
@keyframes sheet{from{transform:translateY(30%);opacity:.4}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
"""

JS = r"""
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var ARROWS = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};
  var downOn = null, opener = null, CALM = matchMedia("(prefers-reduced-motion: reduce)");

  function tiles() { return $$("#app .tile").filter(function (t) { return t.offsetParent !== null; }); }
  function land(t) { if (t) { t.focus({preventScroll: true}); t.scrollIntoView({block: "nearest", inline: "nearest"}); } }
  function headTile() { return $("#app .head .tile") || tiles()[0]; }

  // Arrow keys move to the nearest tile in that direction, measured between tile centers.
  function step(key) {
    var all = tiles(), cur = document.activeElement, d = ARROWS[key], best = null, score = Infinity;
    if (all.indexOf(cur) < 0) { land(headTile()); return; }
    var a = cur.getBoundingClientRect();
    all.forEach(function (t) {
      var b = t.getBoundingClientRect();
      var dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
      var along = dx * d[0] + dy * d[1], across = Math.abs(dx * d[1]) + Math.abs(dy * d[0]);
      if (t !== cur && along > 4 && along + 2 * across < score) { score = along + 2 * across; best = t; }
    });
    land(best);
  }

  function show(tile) {
    var d = document.getElementById(tile.dataset.plate);
    if (!d || d.open) return;
    var body = $(".plate-scroll", d);
    opener = tile;  // a ticket has a tile in its column and one at the pass: focus goes back to the one that opened it
    d.showModal();
    body.scrollTop = 0;
    body.focus({preventScroll: true});  // the arrow keys, Space, and Page Down scroll the plate
  }

  // The call that keys act on: the one holding focus, else the first one still open.
  function form(plate) {
    var f = document.activeElement && document.activeElement.closest && document.activeElement.closest("form.decide");
    return f && plate.contains(f) ? f : $("form.decide:not(.done)", plate);
  }
  function pending(plate) {
    return $$("form.decide:not(.done)", plate).filter(function (f) { return f.elements.option.value !== ""; })[0];
  }
  function say(f, text, tone, icon) {
    var r = $(".result", f);
    r.className = "result " + (tone || "");
    r.innerHTML = icon || "";
    r.appendChild(document.createElement("span")).textContent = text;
  }

  function pick(f, i) {
    if (!f || f.dataset.busy || f.classList.contains("done")) return;
    var opts = $$(".opt", f);
    if (!opts[i]) return;
    opts.forEach(function (o, j) { o.setAttribute("aria-pressed", String(i === j)); });
    f.elements.option.value = String(i);
    $(".what", f).textContent = "“" + opts[i].dataset.label + "”";
    $(".confirm", f).hidden = false;
    say(f, "");
    $("[data-send]", f).focus();
  }
  function unpick(f) {
    var was = $('.opt[aria-pressed="true"]', f);
    $$(".opt", f).forEach(function (o) { o.setAttribute("aria-pressed", "false"); });
    f.elements.option.value = "";
    $(".confirm", f).hidden = true;
    if (was) was.focus();
  }

  // One send per confirm. The result shows in place; the page never reloads under an open plate.
  function send(f) {
    if (!f || f.dataset.busy || f.classList.contains("done") || f.elements.option.value === "") return;
    var btn = $("[data-send]", f), body = new URLSearchParams(new FormData(f));
    f.dataset.busy = "1";
    btn.disabled = true;
    $("span", btn).textContent = "Sending…";
    fetch(f.getAttribute("action"), {method: "POST", headers: {"X-Pass-Fetch": "1"}, body: body})
      .then(function (r) { return r.text().then(function (t) { return [r.status, t]; }); })
      .then(function (r) {
        if (r[0] === 200) finish(f, "ok", r[1]);
        else if (r[0] === 207 || (r[0] === 409 && /^Already answered/.test(r[1]))) finish(f, "warn", r[1]);
        else retry(f, r[1]);
      }, function () { retry(f, "Not sent. The pass did not answer. Check the connection and try again."); });
  }
  function finish(f, tone, text) {
    delete f.dataset.busy;
    f.classList.add("done");
    $(".confirm", f).hidden = true;
    $$(".opt, textarea", f).forEach(function (x) { x.disabled = true; });
    say(f, text, tone, CHECK);
    var kicker = $(".kicker b", f.closest(".call"));
    kicker.textContent = "Answered";
    kicker.className = "t-green";
    var plate = f.closest("dialog"), t = $('#app .head .tile[data-plate="' + plate.id + '"]'), next = null;
    if (!$("form.decide:not(.done)", plate)) {
      if (t && t.dataset.plating) {
        // A ticket at Ready to merge still waits for the chef's look once its calls are answered.
        $(".q", t).textContent = t.dataset.plating;
        $(".pick", t).textContent = "Ready for your look";
        $$(".flags, .thumbs", t).forEach(function (x) { x.remove(); });
      } else if (t && !t.classList.contains("sent")) {
        t.classList.add("sent");
        t.insertAdjacentHTML("beforeend", '<span class="sent-tag">' + CHECK + "Answered</span>");
      }
      next = $$("#app .head .tile:not(.sent)").filter(function (x) { return x !== t; })[0];
    }
    if (next) {
      f.insertAdjacentHTML("beforeend", '<button type="button" class="btn fill" data-next="' + next.dataset.plate +
        '"><span>Next call</span><kbd>\u21a9</kbd></button>');
      $("[data-next]", f).focus();
    } else $(".result", f).focus();
  }
  function retry(f, text) {
    var btn = $("[data-send]", f);
    delete f.dataset.busy;
    btn.disabled = false;
    $("span", btn).textContent = "Send";
    say(f, text, "bad");
    btn.focus();
  }

  document.addEventListener("pointerdown", function (ev) { downOn = ev.target; });
  document.addEventListener("click", function (ev) {
    var el = ev.target, t = el.closest(".tile, [data-pill]"), o = el.closest(".opt"), menu = $("#app details.pmenu[open]");
    if (menu && !menu.contains(el)) menu.open = false;  // the project menu closes on a click anywhere else
    if (t) show(t);
    else if (o) pick(o.form, $$(".opt", o.form).indexOf(o));
    else if (el.closest("[data-cancel]")) unpick(el.closest("form"));
    else if (el.closest("[data-next]")) { el.closest("dialog").close(); show($('.tile[data-plate="' + el.closest("[data-next]").dataset.next + '"]')); }
    else if (el.closest("[data-gate]")) $$("#app .tray")[el.closest("[data-gate]").dataset.gate].scrollIntoView({block: "nearest", inline: "start", behavior: CALM.matches ? "auto" : "smooth"});
    else if (el.closest("[data-keys]")) $("#keys").showModal();
    else if (el.closest("[data-close]")) el.closest("dialog").close();
    else if (el.tagName === "DIALOG" && downOn === el) el.close();  // a click on the dimmed backdrop
  });
  document.addEventListener("submit", function (ev) {
    if (ev.target.classList.contains("decide")) { ev.preventDefault(); send(ev.target); }
  });
  // Escape first takes back a picked option. Only then does it close the plate.
  document.addEventListener("cancel", function (ev) {
    var f = ev.target.classList.contains("plate") && pending(ev.target);
    if (f) { ev.preventDefault(); unpick(f); }
  }, true);
  document.addEventListener("close", function (ev) {
    if (ev.target.classList.contains("plate") && !$("dialog.plate[open]"))
      land(opener && opener.isConnected && opener.dataset.plate === ev.target.id ? opener : $('.tile[data-plate="' + ev.target.id + '"]'));
  }, true);

  document.addEventListener("keydown", function (ev) {
    if (ev.defaultPrevented || ev.altKey) return;
    var plate = $("dialog.plate[open]"), keys = $("#keys"), typing = /^(TEXTAREA|INPUT|SELECT)$/.test(ev.target.tagName);
    if (plate && ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); send(pending(plate)); return; }
    if (ev.metaKey || ev.ctrlKey || typing) return;
    if (ev.key === "?") { ev.preventDefault(); if (keys.open) keys.close(); else keys.showModal(); return; }
    if (keys.open) return;
    if (plate) {
      var f = form(plate);
      if (/^[1-9]$/.test(ev.key)) { ev.preventDefault(); pick(f, Number(ev.key) - 1); }
      else if ((ev.key === "n" || ev.key === "N") && f && !f.classList.contains("done")) { ev.preventDefault(); f.elements.note.focus(); }
      else if (ev.key === "Enter" && !ev.target.closest("button, a, summary") && pending(plate)) { ev.preventDefault(); send(pending(plate)); }
      return;
    }
    var menu = $("#app details.pmenu[open]");
    if (menu && ev.key === "Escape") { menu.open = false; $("summary", menu).focus(); return; }
    if (ARROWS[ev.key]) { ev.preventDefault(); step(ev.key); }
    else if (ev.key === "h" || ev.key === "H") { ev.preventDefault(); land(headTile()); }
  });

  // Every minute, and when the page comes back into view, swap in a fresh board.
  // Never while a plate is open or a note is half written.
  function refresh() {
    if (document.hidden || $("dialog[open]") || $("details.pmenu[open]")) return;
    if ($$("#app textarea").some(function (t) { return !t.disabled && t.value.trim(); })) return;
    fetch(location.pathname + location.search, {cache: "no-store"})
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(function (html) {
        if ($("dialog[open]") || $("details.pmenu[open]")) return;  // opened while the board was loading
        var doc = new DOMParser().parseFromString(html, "text/html"), next = doc.getElementById("app");
        if (!next) throw new Error("no board");
        var focus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.dish : null;
        var rail = $(".rail"), x = rail ? rail.scrollLeft : 0;
        $("#app").replaceWith(next);
        document.title = doc.title;
        if ($(".rail")) $(".rail").scrollLeft = x;
        lightGates();
        watchHead();
        if (focus) land(tiles().filter(function (t) { return t.dataset.dish === focus; })[0]);
      })
      .catch(function () {
        var s = $("#stale");
        s.hidden = false;
        s.textContent = "Not refreshed: the pass did not answer at " + new Date().toTimeString().slice(0, 5) +
          ". This board is from " + $("#app").dataset.at + ".";
      });
  }
  // On the phone the stages scroll sideways. The stage bar lights the columns in view.
  function lightGates() {
    var rail = $("#app .rail"), box = rail && rail.getBoundingClientRect();
    if (!box || !box.width) return;
    $$(".tray", rail).forEach(function (t, i) {
      var r = t.getBoundingClientRect(), b = $$('#app [data-gate]')[i];
      if (b) b.classList.toggle("on", r.right > box.left + 24 && r.left < box.right - 24);
    });
  }
  document.addEventListener("scroll", function (ev) { if (ev.target.classList && ev.target.classList.contains("rail")) lightGates(); }, true);
  lightGates();
  // The phone's "Open the oldest" button shows only once the pass has scrolled up out of view.
  function watchHead() {
    var pill = $("#app .pill"), t = $("#app .head .tile"), bar = $("#app .bar");
    if (pill && t) pill.classList.toggle("away", t.getBoundingClientRect().bottom > bar.offsetHeight);
  }
  window.addEventListener("scroll", watchHead, {passive: true});
  var CHECK = '@@check@@';
  setInterval(refresh, 60000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
})();
"""

KEYS = ('<dialog class="keys" id="keys" aria-labelledby="keys-t"><div class="keys-in"><h2 id="keys-t">Keyboard shortcuts</h2>'
        '<h3>On the board</h3><dl>'
        '<div><dt>Move between plates</dt><dd><kbd>&#8592;</kbd><kbd>&#8593;</kbd><kbd>&#8594;</kbd><kbd>&#8595;</kbd></dd></div>'
        '<div><dt>Go to the pass</dt><dd><kbd>H</kbd></dd></div>'
        '<div><dt>Open a plate</dt><dd><kbd>&#8617;</kbd><kbd>Space</kbd></dd></div>'
        '<div><dt>Show these shortcuts</dt><dd><kbd>?</kbd></dd></div></dl>'
        '<h3>In an open plate</h3><dl>'
        '<div><dt>Pick an option</dt><dd><kbd>1</kbd>&#8211;<kbd>9</kbd></dd></div>'
        '<div><dt>Send the picked option</dt><dd><kbd>&#8617;</kbd></dd></div>'
        '<div><dt>Write a note</dt><dd><kbd>N</kbd></dd></div>'
        '<div><dt>Send from the note</dt><dd><kbd>&#8984;</kbd><kbd>&#8617;</kbd></dd></div>'
        '<div><dt>Open the next call after a send</dt><dd><kbd>&#8617;</kbd></dd></div>'
        '<div><dt>Take back the pick, then close</dt><dd><kbd>esc</kbd></dd></div></dl>'
        '<button type="button" class="btn" data-close>Done</button></div></dialog>')

PAGE = ("""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><title>@@title@@</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='t' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%233B9BFF'/%3E%3Cstop offset='1' stop-color='%230066D6'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='64' height='64' rx='17' fill='url(%23t)'/%3E%3Cg transform='translate(11.3 9.45) scale(1.725)' fill='%23fff'%3E%3Cpath d='M4.25 17.4a7.75 7.75 0 0 1 15.5 0' fill='none' stroke='%23fff' stroke-width='1.5'/%3E%3Ccircle cx='12' cy='7.4' r='1.75'/%3E%3Cpath d='M2.75 19h18.5l-1.5 1.5H4.25z'/%3E%3C/g%3E%3C/svg%3E">
<style>""" + CSS + """</style></head><body>@@app@@""" + KEYS + """
<script>""" + JS.replace("@@check@@", svg("check")) + """</script></body></html>""")


def log(line):
    """One line to stdout, which the login service sends to ~/yeschef/pass.log."""
    print(line, flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/answer":
            self.send_error(404)
            return
        length = min(int(self.headers.get("Content-Length") or 0), 20000)
        form = urllib.parse.parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
        if DEMO:
            status, text = demo_answer(form)
        else:
            status, text = answer(form, self.headers, peer_port=self.client_address[1],
                                  server_port=self.server.server_address[1])
        if status != 200:
            # One line per refused or part-sent tap in pass.log, so it can be diagnosed. No secrets in it.
            log("%s answer %s %d: %s (login=%s device=%s)" % (
                datetime.datetime.now().strftime("%H:%M:%S"), "refused" if 400 <= status < 500 else "not fully sent", status, text,
                self.headers.get("Tailscale-User-Login") or "-",
                (self.headers.get("X-Forwarded-For") or "-").split(",")[-1].strip()))
        if self.headers.get("X-Pass-Fetch") == "1":
            # The pass page's own script: it shows the result in place, so an open plate never reloads.
            self.send_text(status, text.encode(), "text/plain; charset=utf-8")
            return
        if status == 200:
            self.send_response(303)
            self.send_header("Location", "/")
            self.end_headers()
            return
        body = ('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
                '<body style="font:16px system-ui;padding:24px"><p>%s</p><p><a href="/">Back to the pass</a></p></body>' % e(text)).encode()
        self.send_text(status, body, "text/html; charset=utf-8")

    def send_text(self, status, body, ctype):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/img/"):
            real = art_file(self.path.split("?", 1)[0])
            if not real:
                self.send_error(404)
                return
            with open(real, "rb") as f:
                body = f.read()
            ctype = IMAGE_TYPES[os.path.splitext(real)[1].lower()]
        elif self.path == "/healthz":
            body, ctype = b"ok", "text/plain"
        elif self.path.split("?", 1)[0] in ("/", "/index.html"):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            body, ctype = render(BOARD, (query.get("p") or [None])[0]).encode(), "text/html; charset=utf-8"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        if self.path.startswith("/img/"):
            # An SVG opened directly must not run script on the pass origin.
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


# Demo mode: `python3 pass.py --demo [port]`. A design and test bench with fixture data.
# It reads fixtures/ instead of the board, GitHub, and Linear, and its answers go to a temp log.
# It never calls `t3 thread send`. The login service never passes --demo.
DEMO = False
HERE = os.path.dirname(os.path.abspath(__file__))


def demo_answer(form):
    """Run the real answer() checks with demo identity, a fake sender, and a temp log."""
    allow = os.path.join(HERE, "fixtures", "demo.allow")
    headers = {"Tailscale-User-Login": "chef@demo.local", "X-Forwarded-For": "100.64.0.1", "Origin": ORIGIN}
    sent = []
    status, text = answer(form, headers, peer_check=lambda port: False, allow_path=allow,
                          sender=lambda thread, message: sent.append(thread))
    return status, text + (" (demo: nothing was sent)" if status == 200 else "")


def start_demo(port):
    global DEMO, BOARD, ART_ROOT, ANSWERS, ORIGIN, PORT, T3_WEB, T3_ENV, fetch_pr, fetch_linear, fetch_thread
    import tempfile
    DEMO, PORT = True, port
    fx = os.path.join(HERE, "fixtures")
    BOARD = os.path.join(fx, "board.json")
    ART_ROOT = os.path.realpath(os.path.join(fx, "art"))
    ANSWERS = os.path.join(tempfile.mkdtemp(prefix="brigade-demo-"), "answers.jsonl")
    ORIGIN = "http://127.0.0.1:%d" % port
    T3_WEB, T3_ENV = "https://t3.example", "demo"
    with open(os.path.join(fx, "sources.json")) as f:
        src = json.load(f)

    def lookup(table, key):
        if key not in src[table]:
            raise RuntimeError("demo source has no %s" % key)
        val = src[table][key]
        if val == "fail":
            raise RuntimeError("demo outage")
        return val

    fetch_pr = lambda number, repo=REPO: lookup("prs", "%s#%s" % (repo, number))
    fetch_linear = lambda identifier: lookup("linear", identifier)

    def demo_thread(thread_id):
        rec = dict(lookup("threads", thread_id))
        ago = rec.pop("updatedMinutesAgo", 0)
        rec["updatedAt"] = (datetime.datetime.utcnow() - datetime.timedelta(minutes=ago)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        return rec
    fetch_thread = demo_thread


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--demo":
        start_demo(int(sys.argv[2]) if len(sys.argv) > 2 else 8600)
    elif not ORIGIN:
        sys.stderr.write("BRIGADE_ORIGIN is not set. Put the pass page's address in the env file, for example "
                         "BRIGADE_ORIGIN=https://<mac>.<tailnet>.ts.net:%d (see README.md).\n" % PORT)
        sys.exit(2)
    # Loopback only. Tailnet access goes through `tailscale serve`, never funnel.
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
