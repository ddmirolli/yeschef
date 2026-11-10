#!/bin/zsh
# The PR review for this repo (Dan, 2026-11-05): the open-source PR-Agent, with GPT-6.1 Sol at xhigh
# effort, through the CLIProxy hub on this Mac. No CodeRabbit here: that subscription is ReviewWheel's.
# Usage: tools/review.sh <pr-number> [--dry-run]
#   Posts (or updates) one "PR-Agent review" comment on the PR, under the gh account.
#   --dry-run prints the review here and posts nothing.
# The gate: fix or answer each finding, re-run, and merge when a round has nothing above minor.
# Sol at xhigh can think for several minutes, so a model call may take up to 20 minutes.
set -e
pr=${1:?usage: tools/review.sh <pr-number> [--dry-run]}
[[ $pr == <-> ]] || { echo "PR number must be digits: $pr" >&2; exit 2; }
publish=true; [[ ${2:-} == --dry-run ]] && publish=false
repo=ddmirolli/yeschef
version=0.49.0
venv="$HOME/.cache/agent-brigade/pr-agent-$version"
keys=/opt/homebrew/etc/cliproxyapi-keys.txt

# Reuse the venv only when the pinned PR-Agent is really in it. A failed install is removed, so a retry starts clean.
if ! "$venv/bin/python" -I -c "import importlib.metadata as m, sys; sys.exit(m.version('pr-agent') != '$version')" 2>/dev/null; then
  rm -rf "$venv"
  if ! { uv venv -q -p /opt/homebrew/bin/python3.12 "$venv" && VIRTUAL_ENV="$venv" uv pip install -q "pr-agent[github]==$version"; }; then
    rm -rf "$venv"
    echo "PR-Agent $version did not install. Nothing was reviewed." >&2
    exit 1
  fi
fi
key=$(grep '^api_key=' "$keys" | cut -d= -f2- | tr -d '[:space:]')
[[ -n $key ]] || { echo "No api_key line in $keys (CLIProxy hub)." >&2; exit 1; }
token=$(gh auth token)

# Third-party code: an empty working folder, isolated Python, and only the variables it needs.
run=$(mktemp -d /tmp/ab-review.XXXXXX)
trap 'rm -rf "$run"' EXIT
cd "$run"
env -i HOME="$HOME" PATH=/usr/bin:/bin \
  GITHUB__USER_TOKEN="$token" CONFIG__GIT_PROVIDER=github \
  OPENAI__KEY="$key" OPENAI__API_BASE=http://127.0.0.1:8317/v1 \
  CONFIG__MODEL=openai/gpt-6.1-sol CONFIG__FALLBACK_MODELS='["openai/gpt-6.1-sol"]' \
  CONFIG__REASONING_EFFORT=xhigh CONFIG__ADDITIONAL_REASONING_EFFORT_MODELS='["gpt-6.1-sol"]' \
  CONFIG__AI_TIMEOUT=1200 CONFIG__CUSTOM_MODEL_MAX_TOKENS=200000 CONFIG__MAX_MODEL_TOKENS=200000 CONFIG__PUBLISH_OUTPUT=$publish CONFIG__LOG_LEVEL=ERROR \
  PR_REVIEWER__REVIEW_HEADING="PR-Agent review (GPT-6.1 Sol, xhigh)" PR_REVIEWER__NUM_MAX_FINDINGS=8 \
  PR_REVIEWER__REQUIRE_MERGE_RECOMMENDATION=true PR_REVIEWER__PUBLISH_OUTPUT_NO_SUGGESTIONS=true \
  PR_REVIEWER__ENABLE_REVIEW_LABELS_EFFORT=false PR_REVIEWER__ENABLE_REVIEW_LABELS_SECURITY=false \
  "$venv/bin/python" -I -c '
import asyncio, sys
from pr_agent.agent.pr_agent import PRAgent
from pr_agent.config_loader import get_settings
ok = asyncio.run(PRAgent().handle_request(sys.argv[1], ["review"]))
data = get_settings().get("data") or {}
art = data.get("artifact") if isinstance(data, dict) else None
if art:
    print(art)
print("review: %s" % ("posted on the PR" if get_settings().config.publish_output else "dry run, nothing posted"))
sys.exit(0 if ok is not False else 1)
' "https://github.com/$repo/pull/$pr"
