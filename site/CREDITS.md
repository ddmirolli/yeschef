# Credits

## T3 Code marketing site (MIT)

The hero motion on this page is ported from the T3 Code marketing site:
`apps/marketing/src/lib/homeMotion.ts` (the cursor parallax and visibility gate) and the
`hero-float*` rules and `rise` keyframes from `apps/marketing/src/pages/index.astro` and
`src/layouts/Layout.astro`. The port lives in `site/site.js` (function `startHomeMotion`) and
`site/style.css` (`.hero-float*`, `[data-rise]`, `@keyframes mark-in`, `@keyframes rise`).

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Agent marks

The SVG marks in `site/assets/` (Claude, OpenAI, Cursor, OpenCode, Grok, Antigravity) are the
harness icons the T3 Code site ships in `apps/marketing/public/harnesses/`. Each mark belongs to
its owner. They appear here only to name the agents T3 Code runs.

`site/assets/t3code-mark.svg` is the T3 wordmark from the nav of https://t3.codes, recoloured white.
It belongs to T3 Tools. It appears here only to name T3 Code, the app Yes Chef runs in.

`site/assets/gemini-mark.svg` is the Gemini CLI icon from the ACP agent registry
(https://cdn.agentclientprotocol.com/registry/v1/latest/gemini.svg), recoloured white. It belongs to
Google. T3 Code runs Gemini CLI from that registry.

## Fraunces and Figtree (SIL Open Font License 1.1)

`site/fonts/fraunces-latin-var.woff2` and `fraunces-latin-var-italic.woff2` are Fraunces, copyright
2018 The Fraunces Project Authors (https://github.com/undercasetype/Fraunces), latin subset, variable
(opsz, wght, SOFT, WONK). `site/fonts/figtree-latin-var.woff2` is Figtree, copyright 2022 The Figtree
Project Authors (https://github.com/erikdkennedy/figtree), latin subset, variable weight. Both are
under the SIL Open Font License 1.1; the licences are in `site/fonts/OFL-Fraunces.txt` and
`site/fonts/OFL-Figtree.txt`.

## Yes Chef mark

`site/assets/yeschef-icon.svg` is the Yes Chef cloche, from this repo (`pass.py`, `ICONS["cloche"]`).
