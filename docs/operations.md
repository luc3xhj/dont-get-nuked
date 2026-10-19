# Operations and handoff

This guide covers running, recovering and evaluating the paper trader after the V2 upgrade (Releases A–D). The
application is paper-only: it never signs, broadcasts or holds keys, and it uses free data routes only.

## Run

| Task | Command |
|---|---|
| Install the worker as a LaunchAgent (starts at login, restarts on exit) | `npm run agent:install` |
| Start / restart the worker | `npm run agent:start` |
| Stop / status | `npm run agent:stop` · `npm run agent:status` |
| Terminal UI (proxies to the worker on 127.0.0.1:3101) | `npm run dev` |
| Live capability report | `npm run report:capabilities` |
| Consistent, verified database backup | `npm run db:backup` |
| Replay recorded decisions under the current policy | `npm run replay:decisions` |
| Repository gates | `npm test` · `npm run lint` · `npx tsc --noEmit` · `npm run build` |

If `agent:start` fails with `Bootstrap failed: 5`, check `launchctl print-disabled gui/$(id -u)`. A service disabled in
System Settings → Login Items must be re-enabled there or with `launchctl enable gui/$(id -u)/local.dont-get-nuked.agent`.

`npm run build` writes `.next`; if the dev server was running, delete `.next` and restart it.

## Startup and recovery

1. **Migrations.** Pending schema migrations run in order, each in its own transaction, after one verified
   `VACUUM INTO` backup in `agent/data/backups/`. Migrations only add tables, columns or provenance-marked import events.
2. **Ledger.** Account cash is the sum of the account's ledger events (integer lamports, exactly one opening credit).
   Pre-ledger balances were imported once as an opening credit plus a labelled `legacy_adjustment`.
3. **Obligations.** Every coin with an open position or pending order is restored regardless of age.
4. **Reconciliation.** Cash vs ledger, sleeve partitions, reservations, inventory and position cash flows are checked.
   Any failure puts the worker in `faulted`: it makes no financial changes, and diagnostics stay readable.
5. **Worker states.** `recovering → running`. On stop the worker is `draining`: unsubmitted buys are cancelled and
   their reservations released; open positions and exit obligations persist and resume on the next start.

`/api/health` reports the state, applied schema versions, the backup path, recovered markets and reconciliation.

## Accounts and sleeves

| Account | Purpose |
|---|---|
| `agent` | The strategy with research. |
| `rules` | The same policy on the same opportunity snapshot with research removed: measures research's net value. |
| `shadow` | Every fired setup at 0.1◎: each setup's raw edge. |
| `baseline` | A random hot coin with the same timing and exits: the bar to beat. |
| `follower` | Experiment `wallet_follow_v1`: reacts to tracked wallets' buys with its own quotes and exits. |

`agent` and `rules` partition their cash into sleeves: **fast** 60%, **intraday** 30%, 10% unallocated, while swing and
position stay unfunded until their data contracts qualify. Allocation never changes account cash, and a sleeve can't
borrow another sleeve's cash. Use the `reallocate_cash` command to move unreserved cash.

## Risk and orders

- **R0 (approved_plan_v2):** strictly positive planned risk frozen before submission from the modeled loss at the
  structural stop. R = net PnL ÷ R0. Legacy trades keep their original definition. Legacy R computed from a
  non-positive denominator is flagged unusable, and its cash result is kept.
- **Pre-submission checks:** an entry can't submit after its strategy's TTL, while entries are paused, or once the
  price is at or below the stop. Such orders end with no fill and no fee.
- **Exits:** exits are requested, never assumed. A position without a fresh price waits and stays visible. Each exit
  intent may fail at most 3 times, with backoff of 5s, 10s and 20s. After that, no automatic attempt happens until a
  different intent or an operator request; the budget survives restarts.
- **TP1** counts as done only after its sell fills.
- **Valuation:** a position without a reliable mark makes valuation *incomplete*, never zero and never a loss. Risk
  anchors (peak and daily baseline) move only on complete valuations.

## Operator commands

`POST /api/commands` with `{ commandId, commandType, payload }` (the UI generates the id). An identical retry returns the
recorded result; reusing an id with different content returns 409.

| Command | Effect |
|---|---|
| `pause_entries` | Stops entries and cancels unsubmitted buys; exits continue. |
| `resume_entries` | Lifts the pause only if the risk gates pass; never resets history. |
| `cancel_pending_buys` | Cancels pending buys without pausing. |
| `request_exit` / `request_flatten` | A bounded exit for one position, or for all (flatten also pauses). |
| `reset_risk_anchors` | Explicitly restarts drawdown and daily-loss anchors from current reliable equity. |
| `reallocate_cash` | Moves unreserved cash between sleeves and unallocated capital. |

## Data capabilities

`npm run report:capabilities` and the **System** tab show every route with its zero-cost status, evidence stage
(documented, fixture-checked or live-checked) and state (qualified, degraded or unsupported). Paid or unverified routes
are unsupported and refused before any request. This covers PumpPortal trade subscriptions, Jupiter quotes, and
Helius without a key. The PumpPortal new-token and migration streams are free and live-checked.

## Strategies

| Family | Strategies | Notes |
|---|---|---|
| Reversal (fast sleeve) | new_dump, stretch_deep, stretch_pullback, dev_base, migrated_base | Structural targets. Range setups rarely pass the cost rule and are kept for comparison. |
| Fast experiments | early_momentum, first_shallow_pullback, migration_event, breakout_continuation | Each has a data contract (tape freshness, launch tape, entry TTL). |
| Follower experiment | wallet_follow | Own quote and exits; a leader's sale closes only the follower's own lot. |
| Intraday | intraday_retest | Completed 5-minute bars, frozen range and ATR, trailing on completed bars. |
| Swing | narrative_swing | Unsupported until 24h of continuous coverage plus independent narrative evidence exist. |
| Position | narrative_position | Capability-gated; needs 7 days of complete history. |

`/api/strategies` and the System tab give the exact reason a strategy is unsupported.

## Research, discovery and learning

- **Research jobs** (`/api/jobs`) are typed and persisted. Each records its priority, deadline, input cutoff and
  availability time. A report only affects decisions made after it became available, and overdue jobs expire.
- **Discovery** (`/api/discovery`) runs registered topic searches on the free Treg route. Evidence is deduplicated
  by content and grouped by origin. Candidates come from three routes: market, evidence and wallet. An address in a
  snippet stays unresolved until the token is seen on chain. Discovery only raises attention.
- **Learning** (`/api/learning`): every running strategy is a registered hypothesis with an experiment and a
  comparator. Reviews run every 6 hours: day-block bootstrap, labelled instrumented → provisional → supported within
  observed conditions, or contradicted. The analyst may only *propose* a hypothesis from a lesson you add. It never
  activates one.

## Evidence and evaluation

A positive cumulative line is not evidence. Compare each experiment with its declared comparator on the same
strategy version. Use `rules` vs `agent` for research value, and `shadow`/`follower` vs `baseline` for selection.
Read the review's interval and trading-day count. A strategy version change restarts evidence: old trades keep their
version and remain visible.

## Known limitations

- **Execution model:** a named local AMM approximation that models a fill atomically at the first fresh quote after
  latency. It doesn't capture real inclusion, MEV or failed-transaction fees beyond the modeled ones.
- **Data coverage:** discovery samples bounded pump.fun lists. Live tapes share the free GeckoTerminal cap of
  10 requests/minute, so fast strategies only act when a coin's tape is fresh.
- **Event times:** the PumpPortal stream carries no event time; launches and migrations are stamped on receipt.
- **Holder data** depends on RugCheck. If it is unreachable (for example through a local proxy), coins can't pass
  holder checks, and the System tab shows the route as degraded.
- **Not built:** starting a separate run identity (`start_run`) and management transfer between sleeves (disabled by
  default in the spec).
