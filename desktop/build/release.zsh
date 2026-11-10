#!/bin/zsh
# npm run release -- 0.2.0      a Stable release
# npm run release -- nightly    a Nightly release
#
# Yes Chef's release, on Dan's Mac (docs/desktop-release-plan-v0_1.md, section 7, steps 1 to 5; the site is PR D).
# Dan runs it himself, from a clean main, in a new Terminal window opened only for it, and locks 1Password when the
# key is deleted (his rule, 2026-11-09: the Touch ID approval serves only this release, and nothing in ReviewWheel
# can use it). Agents never run it: it refuses to run without a terminal.
#
# 1. Checks and the plan, with no key (build/publish.mjs plan): main is clean and pushed, the repo is public, the
#    Developer ID certificate is here, and the version and commit to build. Dan says yes before Touch ID.
# 2. One Touch ID approval: the App Store Connect key from the "Yes Chef Release" vault, written to a private temp
#    folder (mktemp -d) and deleted on exit. Nothing prints a secret.
# 3. The build (publish.mjs build): a clean copy of the commit, npm ci, then build/package.mjs --dist, which notarizes
#    and staples the app and the DMG, rewrites the feed and runs the checks and a hidden start.
# 4. The key is deleted. Lock 1Password then: publishing needs no key.
# 5. The release (publish.mjs publish): a draft, every file attached and checked, then published, then the feed read
#    back the way the app reads it.
#
# macOS 27: Terminal first needs System Settings, Privacy & Security, Files & Folders, Terminal, "Data shared by
# 1Password". Without it the 1Password CLI says "No accounts configured" and offers to add the account with a typed
# password: stop it with Ctrl+C instead. YESCHEF_OP_ACCOUNT names the 1Password account if there are several.
set -euo pipefail
# No umask here: it would carry into the build and make the app's files private to one user. mktemp -d makes a
# 0700 folder and the key file is written 0600, so the key stays private without it.

if [[ ! -t 0 || ! -t 1 ]]; then
  print -u2 "Run this in your own Terminal window, not from an agent."
  exit 1
fi
if (( $# != 1 )); then
  print -u2 "Usage: npm run release -- <version>   a Stable release, such as 0.2.0"
  print -u2 "       npm run release -- nightly     a Nightly release"
  exit 1
fi

DESKTOP=${0:A:h:h}
VAULT="Yes Chef Release"
ITEM="Yes Chef notarization"
acct=()
[[ -n "${YESCHEF_OP_ACCOUNT:-}" ]] && acct=(--account "$YESCHEF_OP_ACCOUNT")

RUN=$(mktemp -d)
KEYDIR=$(mktemp -d)
trap 'rm -rf "$KEYDIR"' EXIT
cd "$DESKTOP"

node build/publish.mjs plan "$1" "$RUN/plan.json"
if ! read -q "?Build, notarize and publish it? Touch ID comes next. [y/N] "; then
  print "\nStopped. Nothing was built or published."
  exit 1
fi
print

# The item's field labels and attachment names only, never their values.
labels() {
  op item get "$ITEM" --vault "$VAULT" "${acct[@]}" --format json | /usr/bin/python3 -I -c '
import json, sys
d = json.load(sys.stdin)
print("fields:", ", ".join(repr(f.get("label", "")) for f in d.get("fields", [])))
print("files: ", ", ".join(repr(f.get("name", "")) for f in d.get("files", [])))'
}

p8=$(op item get "$ITEM" --vault "$VAULT" "${acct[@]}" --format json | /usr/bin/python3 -I -c '
import json, sys
names = [f["name"] for f in json.load(sys.stdin).get("files", []) if f.get("name", "").endswith(".p8")]
print(names[0] if len(names) == 1 else "")')
if [[ -z "$p8" ]]; then
  print -u2 "Expected one .p8 attached to \"$ITEM\" in \"$VAULT\"."
  labels >&2
  exit 1
fi

op read "${acct[@]}" --no-newline --out-file "$KEYDIR/AuthKey.p8" "op://$VAULT/$ITEM/$p8" >/dev/null
key_id=$(op read "${acct[@]}" --no-newline "op://$VAULT/$ITEM/key id" 2>/dev/null || true)
issuer=$(op read "${acct[@]}" --no-newline "op://$VAULT/$ITEM/issuer id" 2>/dev/null || true)
if [[ -z "$key_id" || -z "$issuer" ]]; then
  print -u2 "Expected fields named \"key id\" and \"issuer id\" in \"$ITEM\"."
  labels >&2
  exit 1
fi

export APPLE_API_KEY="$KEYDIR/AuthKey.p8" APPLE_API_KEY_ID="$key_id" APPLE_API_ISSUER="$issuer"
unset key_id issuer

print "Key read. Building and notarizing the app and the DMG. Apple usually answers in minutes, sometimes longer."
node build/publish.mjs build "$RUN/plan.json" 2>&1 | tee "$RUN/build.log"

unset APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER
rm -rf "$KEYDIR"
print "\nThe key is deleted. Lock 1Password now (Lock in its menu bar icon): publishing needs no key.\n"

node build/publish.mjs publish "$RUN/plan.json"
print "\nDone. Plan and build log: $RUN"
print "If 1Password is still unlocked, lock it now."
