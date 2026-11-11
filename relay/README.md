# Host your own relay

Yes Chef runs one relay for every team, free with a cap. If you hit the cap, or want your team's sealed summaries on your own Cloudflare account, deploy this one. It is the same code. How it works: `docs/team-relay-v0_1.md`.

The relay cannot read what it passes. Your team's names, roles, summaries and actions are sealed on each Mac with a key the relay never sees.

## Deploy

You need a Cloudflare account (the free plan works) and Node 24 or later (the relay is TypeScript, which Node 24 runs with the types stripped; the smoke test uses Node's own WebSocket, and the tests use `node:sqlite`). From the repo root:

```sh
npx wrangler@4 login
npx wrangler@4 deploy --config relay/wrangler.jsonc
```

Wrangler prints the address, like `https://yeschef-relay.<your-subdomain>.workers.dev`. Check it:

```sh
curl https://yeschef-relay.<your-subdomain>.workers.dev/healthz
node relay/smoke.ts https://yeschef-relay.<your-subdomain>.workers.dev
```

The smoke test makes a team with throwaway keys, runs an invite, a join, a summary and an action, then deletes the team.

To serve it on your own domain, add a route to `relay/wrangler.jsonc`, as `deploy/relay/wrangler.jsonc` does for `relay.yeschef.codes`.

## Point Yes Chef at it

The lead sets the relay's address before making the team. The invite link carries it, so devs who join need no setting. (Not built yet: the app's relay setting and team screens come in the next pull request.)

## Settings

Vars in `relay/wrangler.jsonc`. Empty means off.

- `SUMMARY_MIN_MS`: one summary update per member per this many ms (10000).
- `MAX_DEVS`: members per team.
- `MAX_DAILY_REQUESTS`: requests plus socket messages per team per UTC day. Only ones the relay took count: refused ones from outside the team do not.

To read usage per team, set a token and ask for it:

```sh
npx wrangler@4 secret put USAGE_TOKEN --config relay/wrangler.jsonc
curl -H "Authorization: Bearer <the token>" "https://yeschef-relay.<your-subdomain>.workers.dev/v1/usage?days=7"
```

## Run it locally

```sh
npx wrangler@4 dev --config relay/wrangler.jsonc --ip 127.0.0.1 --port 8790
node relay/smoke.ts http://127.0.0.1:8790
```

## Tests

The repo builds with T3 Code's tools: pnpm and [Vite+](https://viteplus.dev) (`vp`). From the repo root:

```sh
vp install
vp run -r typecheck
vp run -r test
```
