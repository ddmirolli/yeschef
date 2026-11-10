#!/bin/zsh
# Starts the pass under launchd (com.yeschef.pass).
# 1Password law (docs/ops/rulings/onepassword-law.md): source the RW service
# account first, read values only through `op run`, strip OP_* from the child.
# The Linear key reference lives in ~/yeschef/pass.env, outside the repo:
# no repo file may name vault items or fields. Plain lines there (BRIGADE_REPO) pass through as they are.
set -e
set -a; source "$HOME/Developer/reviewwheel/.env.op"; set +a
strip=(); for v in $(env | grep -oE '^OP_[A-Za-z0-9_]+'); do strip+=(-u "$v"); done
exec op run --env-file "$HOME/yeschef/pass.env" -- env "${strip[@]}" /usr/bin/python3 -I "$HOME/yeschef/bin/pass.py"
