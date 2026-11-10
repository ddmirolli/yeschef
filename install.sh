#!/bin/zsh
# Installs or updates the pass as a login service and publishes it on the tailnet.
# Run from this folder: zsh install.sh. Idempotent.
set -e
here=${0:A:h}
home_dir="$HOME/yeschef"
label=com.yeschef.pass
plist="$HOME/Library/LaunchAgents/$label.plist"
port=8494

# One-time moves from earlier names (Dan, 2026-11-06): ReviewWheel era (rw-brigade), then Agent Brigade.
# The old service stops first, so nothing writes the folder while it moves. The old path stays as a link,
# so older commands and notes keep working.
old_homes=("$HOME/rw-brigade" "$HOME/agent-brigade")
old_labels=(com.reviewwheel.pass com.agentbrigade.pass)
stop() {
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  # bootout returns before the old job is gone; bootstrap fails (error 5) if it runs too soon.
  for i in {1..20}; do launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1 || break; sleep 0.5; done
}
# Check before anything stops: a refusal must leave the old service running.
old_home=""
for d in $old_homes; do
  [[ -d "$d" && ! -L "$d" ]] || continue
  if [[ -n "$old_home" || -e "$home_dir" ]]; then
    echo "More than one of ${old_homes[*]} $home_dir is a real folder. Nothing was changed; the old service still runs." >&2
    echo "Keep the folder with the live data, remove the other, and run this again." >&2
    exit 1
  fi
  old_home=$d
done
for l in $old_labels; do
  p="$HOME/Library/LaunchAgents/$l.plist"
  [[ -f "$p" ]] || continue
  stop $l
  rm -f "$p"
done
if [[ -n "$old_home" ]]; then
  mv "$old_home" "$home_dir"
  ln -s "$home_dir" "$old_home"
fi

if [[ ! -f "$home_dir/pass.env" ]]; then
  echo "Missing $home_dir/pass.env. Create it with LINEAR_API_KEY=<op:// reference>, found by a live vault" >&2
  echo "metadata read under the service account, and BRIGADE_REPO=<owner/name> if the board names no repo (see README.md)." >&2
  exit 1
fi
if ! grep -q '^BRIGADE_ORIGIN=[^[:space:]]' "$home_dir/pass.env"; then
  echo "$home_dir/pass.env has no BRIGADE_ORIGIN value. Add BRIGADE_ORIGIN=https://<mac>.<tailnet>.ts.net:8494," >&2
  echo "the pass page's address (see README.md). The pass will not start without it." >&2
  exit 1
fi

mkdir -p "$home_dir/bin"
cp "$here/pass.py" "$here/board.py" "$home_dir/bin/"
# macOS Login Items names a background item after the file that launchd runs.
# launchd runs the wrapper directly, so the item shows as "The Pass", not "zsh".
launcher="$home_dir/bin/The Pass"
cp "$here/run-pass.sh" "$launcher"
chmod 755 "$launcher"
rm -f "$home_dir/bin/run-pass.sh"
[[ -f "$home_dir/board.json" ]] || echo '{"service": null, "dishes": []}' > "$home_dir/board.json"

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$launcher</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>$home_dir/pass.log</string>
  <key>StandardErrorPath</key><string>$home_dir/pass.log</string>
</dict></plist>
EOF

stop $label
launchctl bootstrap "gui/$(id -u)" "$plist"
tailscale serve --bg --https=$port http://127.0.0.1:$port
# The vault sign-in takes a few seconds; wait for the server before reporting.
# A hard 30 s deadline: each try is capped at 2 s or the time left, and only an exact "ok" with HTTP 2xx counts.
deadline=$((SECONDS + 30)); out=""
while (( SECONDS < deadline )); do
  left=$((deadline - SECONDS)); (( left > 2 )) && left=2
  if out=$(curl -fsS -m "$left" "http://127.0.0.1:$port/healthz" 2>&1) && [[ $out == ok ]]; then
    echo "Installed and healthy on $port."; exit 0
  fi
  (( SECONDS + 1 < deadline )) && sleep 1 || break
done
echo "Installed, but /healthz did not answer ok in 30 s (last: ${out:-no reply}). See $home_dir/pass.log." >&2
exit 1
