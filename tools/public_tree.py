#!/usr/bin/env python3
"""The public copy of this repository (Dan's ruling 1A, 2026-11-09: a fresh public repo from a clean copy of main).

  python3 tools/public_tree.py check          scan the files git tracks; exit 1 on any hit
  python3 tools/public_tree.py build OUT_DIR  write HEAD without PRIVATE into OUT_DIR, then scan it

Standard library only. It reads git and writes only OUT_DIR, which must not exist yet.
"""
import io
import os
import re
import subprocess
import sys
import tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Files that stay in the private archive. The public copy leaves them out.
PRIVATE = {
    "docs/team-brigade-brief-v0_1.md",  # the pitch, private until Dan says otherwise
}

# What must never reach the public copy. Each rule: a name, then a pattern.
BANNED = [
    # A tailnet: its tail<hex> name in any form (PR-Agent r2 on #63), or any <name>.ts.net host, including
    # word-style tailnet names such as yak-bebop (r3). The placeholders example.ts.net and <tailnet>.ts.net are fine.
    ("tailnet address", re.compile(r"\btail[0-9a-f]{6}\b")),
    ("tailnet address", re.compile(r"\b(?!example\.)[A-Za-z0-9-]+\.ts\.net\b")),
    # A real home folder or a path in it (r3: no trailing slash needed).
    # Placeholders are fine: chef, dan, me, someone, you, Shared and <name>.
    ("home path", re.compile(r"/Users/(?!(?:chef|dan|me|someone|you|Shared)(?![A-Za-z0-9._-])|<)[A-Za-z0-9._-]+")),
    ("pitch name", re.compile(r"\bTheo\b")),
    ("1Password reference", re.compile(r"\bop://[A-Za-z0-9]")),
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    # OpenAI and Anthropic, AWS, GitHub, Slack, Linear, Browserbase, and 1Password service account tokens.
    ("API key", re.compile(r"\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}"
                           r"|xox[abprs]-[A-Za-z0-9-]{10,}|lin_api_[A-Za-z0-9]{20,}|bb_live_[A-Za-z0-9_-]{20,}|ops_[A-Za-z0-9+/=_-]{40,})")),
]
# A match under these rules is never kept or printed, only its file, line and rule.
SECRET = {"1Password reference", "private key", "API key"}


def scan_text(path, text):
    """Every banned match in one file, as (path, line number, rule name, matched text or "(hidden)" for a SECRET rule)."""
    hits = []
    for n, line in enumerate(text.splitlines(), 1):
        # Undo regex and JSON escapes first (\/ and \.), so every rule also sees escaped forms (PR-Agent r2 to r4 on #63).
        line = line.replace("\\/", "/").replace("\\.", ".")
        for name, rx in BANNED:
            for m in rx.finditer(line):
                hits.append((path, n, name, "(hidden)" if name in SECRET else m.group(0)))
    return hits


def scan_bytes(path, data):
    if b"\0" in data[:8192]:
        return []  # binary: images and icons
    return scan_text(path, data.decode("utf-8", "replace"))


def tracked():
    out = subprocess.run(["git", "-C", ROOT, "ls-files", "-z"], check=True, capture_output=True).stdout
    return [p for p in out.decode().split("\0") if p]


def check(root=ROOT, paths=None):
    hits = []
    for p in paths if paths is not None else tracked():
        if p in PRIVATE:
            continue
        full = os.path.join(root, p)
        if os.path.isfile(full) and not os.path.islink(full):
            with open(full, "rb") as f:
                hits += scan_bytes(p, f.read())
    return hits


def build(out_dir):
    if os.path.exists(out_dir):
        sys.exit("%s already exists. Pick a new folder." % out_dir)
    data = subprocess.run(["git", "-C", ROOT, "archive", "--format=tar", "HEAD"], check=True, capture_output=True).stdout
    os.makedirs(out_dir)
    written = []
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for m in tar.getmembers():
            if m.name in PRIVATE or not (m.isfile() or m.isdir()):
                continue
            tar.extract(m, out_dir)
            if m.isfile():
                written.append(m.name)
    return written, check(out_dir, written)


def report(hits):
    for path, n, name, text in hits:
        print("%s:%d: %s: %s" % (path, n, name, text))
    print("%d banned matches." % len(hits) if hits else "Clean: no banned matches.")
    return 1 if hits else 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["check"]:
        sys.exit(report(check()))
    if sys.argv[1:2] == ["build"] and len(sys.argv) == 3:
        files, hits = build(sys.argv[2])
        print("Wrote %d files to %s, without %s." % (len(files), sys.argv[2], ", ".join(sorted(PRIVATE))))
        sys.exit(report(hits))
    sys.exit(__doc__)
