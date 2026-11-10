#!/bin/zsh
# Screenshots of a local pass (demo or live) at 1440 and 390, light and dark, through Browserbase.
# Usage: tools/shoot.sh <port> <out-dir> <label> ['<actions-json>']
# The Browserbase key comes from the ReviewWheel 1Password service account through `op run`,
# per ReviewWheel docs/ops/rulings/onepassword-law.md. It is never printed or written to disk.
set -e
here=${0:A:h}
[[ -f /tmp/bb/node_modules/playwright-core/index.mjs ]] || npm i --silent --prefix /tmp/bb playwright-core
# The Browserbase key reference lives in ~/yeschef/shoot.env, outside the repo (one line,
# BROWSERBASE_API_KEY=<op:// reference>), like pass.env: no repo file may name vault items or fields.
envf="$HOME/yeschef/shoot.env"
[[ -f "$envf" ]] || { echo "Missing $envf. Create it with one line, BROWSERBASE_API_KEY=<op:// reference>, found by a live vault metadata read under the service account." >&2; exit 1; }
set -a && source ~/Developer/reviewwheel/.env.op && set +a
op run --env-file "$envf" --no-masking -- /usr/bin/python3 -c 'import os,sys; os.execvpe("node", ["node"] + sys.argv[1:], {k:v for k,v in os.environ.items() if not k.startswith("OP_")})' "$here/shoot.mjs" "$@"
