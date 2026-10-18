# Don't Get Nuked

This is a local, paper-only Solana meme-coin research and trading simulator. Keep real wallet signing and live order execution out of the application.

All application UI, generated analysis prose, code comments and documentation must be in English. The user and Codex may converse in Chinese. Preserve original source quotations and token names.

The Next.js UI proxies to the Node worker on 127.0.0.1:3101. The worker owns data collection, deterministic strategies and risk, SQLite persistence, and Codex analysis. See README.md for the current setup and architecture.

For external research, use the configured Treg MCP or `treg` CLI. Inspect catalog parameters and price first. This project's data budget is free-only: search uses `tinyfish.web.search`, catalog cost must be explicitly $0, and every call must include `X-Treg-Route-Max-Cost: 0` and `X-Treg-Route-Waterfall: 0`. Pass these through the MCP `call.headers` object or CLI `--header` flags. Do not silently use paid fallbacks. Keep URLs and call IDs with research; distinguish unavailable information from negative evidence.

Never print or commit credentials. TREG_TOKEN is in ignored .env.local; Codex MCP credentials and Treg CLI credentials are in private user configuration outside the repository. Do not include tokens in browser code, reports, or logs.

The autonomous analyst uses the logged-in Codex CLI with an ephemeral read-only run outside this repository. Treg fetches the evidence before Codex judges it. Preserve the separation between probabilistic research and deterministic execution/risk.

Validation: `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`. `npm run research:check` performs a live free Treg search plus a Codex diagnostic, using an in-memory database and no paper trades. Restart an existing worker with `npm run agent:start` after backend changes.
