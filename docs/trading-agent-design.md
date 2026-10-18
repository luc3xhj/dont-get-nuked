# Autonomous Paper-Trading Agent — Research & Design

Status: proposal (18 Oct 2026). Paper trading only: no keys, no signing, no real funds.

---

## 1. What the evidence says (base rates we must respect)

| Fact | Source | What it means for us |
|---|---|---|
| Only **0.2–0.6%** of pump.fun launches graduate (0.198% in May–Jun 2026; 0.63% in Sep–Oct 2025). | [Kamat 2026, arXiv 2607.02823](https://arxiv.org/abs/2607.02823); Marino et al. 2026 cited there | The default outcome of any random new coin is death. A buy is a bet against a ~99% base rate, so entries need *evidence*, not just a pattern. |
| ~**98.6%** of pump.fun tokens end with < $1k liquidity (liquidity-based label, not proven fraud). | [Solidus Labs via CryptoPotato](https://cryptopotato.com/98-of-tokens-on-pump-fun-are-rug-pulls-or-fraud-report/) | Holding is the enemy. We scalp bounded moves and exit; we never "bag hold". |
| Telegram link → **8.9×** graduation rate (HR 5.4); all three socials vs none → **17×**. Initial market cap is the strongest single predictor. Concordance 0.858. | [Kamat 2026](https://arxiv.org/html/2607.02823v3) (fast-regime, not causal, author says not a trading signal) | Social presence and launch size are real priors. Use them to *rank attention*, not as buy triggers. |
| Bundlers: ~5–50 wallets buying in first seconds, funded 0.1–0.5 SOL each, often 7/10 first buyers funded within the hour, 9/10 sharing one funder. | [SolanaHub bot detection](https://solanahub.de/en/knowledge/detecting-solana-bots/) | Same-slot early buys + shared funding = hidden supply that can dump together. This is Setuh's "bundles" concern made measurable. |
| Staged exits (sell a portion to recover cost, trail the rest) are the dominant practitioner exit. | [Definitive](https://www.definitive.fi/blog/how-to-trade-memecoins-onchain), [fomo.family](https://fomo.family/answers/when-to-sell-a-memecoin), [madeonsol](https://madeonsol.com/blog/solana-memecoin-exit-strategy-guide) | Exits are planned before entry and executed by the machine, not by feel. |
| Most "pro" content online is vendor marketing for bots/bundlers with no verified performance. | [rpcfast](https://rpcfast.com/blog/top-solana-sniper-bot), [parasol](https://parasol.so/blog/best-solana-memecoin-bot-2026) | We trust measured outcomes from our own paper ledger, not claims. |

### What professional discretionary traders actually do (synthesis)
1. **Filter attention, not coins.** Thousands of launches/day; pros watch a few dozen that show real, independent demand.
2. **Read who holds and who can sell.** Dev wallet, snipers, bundles, insiders, top-10 concentration (excluding the curve/pool account). Overhead supply that hasn't sold yet is future selling pressure.
3. **Read order flow, not just candles.** Net SOL bought, number of distinct buyers, buy size distribution, repeat/round-trip wallets, whether early cohorts are still exiting.
4. **Trade a narrative with a reason to exist now** (a fresh tweet/news/community), and avoid crowded copycats/relaunches.
5. **Enter on pullbacks after supply flushes**, not on green candles: first dev/sniper dump, Final-Stretch retrace, post-migration bleed then base.
6. **Scalp, size small, cut fast.** Bounded targets, predefined invalidation, fees always counted.

---

## 2. Setuh's method → machine components

Source material: the five study summaries in `meme-paper-trader/exports/five-video-english-summaries/`. Summaries are lossy (see §8, decision 3).

### 2.1 Candidate pools (his discovery filters)
- New Pump pairs, Final-Stretch (near graduation, lower caps), Migrated (1–3 h old). Excludes non-standard launchpads ("Mayhem"). → Our existing **New / Final Stretch / Migrated** feeds.
- Filters re-based to SOL price: thresholds are expressed in **SOL market cap**, not USD, so they survive SOL moves (Day 4 lesson).

### 2.2 Screens (run before any setup is considered)
| His check | How we measure it (free data) | Use |
|---|---|---|
| Top holders' SOL balance, funding source and timing | Top-20 holders (RugCheck) → each wallet's first funding tx (public RPC / optional free Helius key) | Cluster score: shared funder + funded within same window + similar amounts |
| Bundles | Trade tape from launch (pump.fun `swap-api`): ≥3 distinct wallets buying in the same slot in the first slots | Bundle supply % still held |
| Dev holding / dev selling | Creator address (pump.fun) + tape | Dev % held, dev sold yes/no, dev sold *into* our setup = veto |
| Insiders | RugCheck `insiderNetworks`, `graphInsidersDetected` | Strong negative |
| "Abrupt launch candle then controlled advance" | 1-min candles + tape: one huge first candle, then smooth staircase with low distinct-buyer count | Manipulation flag |
| Several influential wallets in very early | Optional tracked-wallet list | *Warning* (overhead supply), not endorsement |
| Community: exact CA, pinned explanation, moderated, recent engagement | Social links (pump.fun) → FxTwitter post/profile (text, likes, views, author followers, age); Treg web search for the exact CA | Social score + CA verification |
| Tweet-based vs community vs profile coin | LLM classification of linked post/profile | Context for narrative quality |
| Recycled ticker / competing relaunch | pump.fun search for same ticker: how many, how recent, which leads | Penalise copies of an existing leader |
| Crowded news launches | Count of same-narrative launches in last hour | Penalise |

### 2.3 Setups — the five trading contexts as state machines
Each setup is a **phase machine fed by order flow**, not a static threshold. Numbers below are *priors to calibrate*, taken from his examples.

| # | Setup | Phases (all must be observed in sequence) | Entry | Invalidation (stop) |
|---|---|---|---|---|
| P1 | **New pair, first dump** | impulse from launch → dev/sniper/bundle cohort sells (≈50–60% off high) → **seller exhaustion** (cohort sell rate ↓, sell size ↓) → **reclaim** (buy share > 60% over 30–60 s, distinct new buyers ↑, higher low) | On reclaim confirmation | Below exhaustion low; hard cap ≈ his "mental loss limit" |
| P2 | **Final Stretch, deep selloff** | curve ≥50% → a concentrated holder dumps → price finds a lower range → renewed buying from *new* wallets | First higher low after the dumper is out | Below range low |
| P3 | **Final Stretch, ordinary pullback** | curve ≥50% + good narrative → 40–50% retrace on falling volume → buyers step in | Reclaim of retrace midpoint | Below swing low |
| P4 | **Established developer base** | dev with *observed* prior successes → sideways while early supply absorbed (cohort % ↓, range tight) | Range low with positive flow | Range breakdown |
| P5 | **Migrated bleed → base** | graduated 1–3 h ago → large decline → ≥10 min consolidation (≈$20–50k cap as context) with sellers exhausted | Range low / breakout of base | Below base |

Critical notes we keep from the summaries: a big drop is **not** a bottom; consolidation does **not** cap downside; these are *alternative* hypotheses, never required together; claimed success rates are unverified. Things we deliberately **do not** copy: high slippage settings, disabling MEV protection, private-key export.

### 2.4 Exits and sizing (his discipline)
- Bounded scalps: take profit quickly; don't marry the coin.
- Size relative to portfolio; fees can overwhelm small balances → our sizing enforces **expected move ≫ round-trip cost**.

---

## 3. Lessons from the existing `meme-paper-trader` (v6.1) run

Observed over ~2 h live (18 Oct 2026): rule account 9 closes (2 TP, 7 SL, net ≈ −0.015 SOL); Codex account 2 closes (both SL, ≈ −0.03 SOL); most stops hit in **4–50 seconds**. Too few trades to judge, but structural problems are visible:

1. **Cost drag**: 0.1 SOL orders with ~1.25% fee/side + 1% slippage/side + 0.004 SOL rent ≈ **6–7% round trip**. Every trade starts deeply negative. (Rent for a token account is ~0.002 SOL and is *refundable* on close — should not be a sunk cost.)
2. **Stops inside the noise**: 8–25% stops on coins that swing 20% in seconds → stopped out by noise before the thesis plays. Stops must be **structural** (below the setup's low) and size must shrink to fit them.
3. **LLM in the trigger path**: 30–180 s model latency + 90 s validity means the setup is gone when the order lands. The LLM should **pre-approve** coins; a fast deterministic engine should **time** entries.
4. **Template thresholds** (five fixed numeric patterns) produced 0 ready candidates for long stretches — real setups don't match exact numbers.
5. Good ideas to keep: forward-only fills on later quotes, explicit unknowns, free-only web policy, ledger versioning, stress replay.

---

## 4. Architecture

```
        ┌─────────────────────────── DATA (free) ────────────────────────────┐
        │ pump.fun lists · swap-api trades & candles · DexScreener · RugCheck │
        │ FxTwitter (X posts/profiles) · Treg web search ($0 cap) · public RPC│
        └───────────────┬────────────────────────────────────────────────────┘
                        ▼
   ① Universe & attention ranker  ──►  ② Coin state (tape, candles, holders, socials)
                                                  │
                     ┌────────────────────────────┼─────────────────────────┐
                     ▼                            ▼                         ▼
          ③ Feature engine (every tick)   ④ Risk screens (vetoes)   ⑤ Analyst agent (LLM, slow lane)
             price structure, flow,          bundles, insiders,          narrative, CA verification,
             cohorts, exhaustion             dev, concentration          recycled ticker, verdict + TTL
                     │                            │                         │
                     └──────────────► ⑥ Setup detectors P1–P5 (phase machines) ◄┘
                                                  │ setup event: entry, stop, targets, evidence
                                                  ▼
                                   ⑦ Decision: EV after costs, R:R, sizing
                                                  ▼
                       ⑧ Execution sim (latency, AMM fills on later tape, fees, failures)
                                                  ▼
                       ⑨ Position manager (structural stop, partial TP, trail, time, thesis exits)
                                                  ▼
                       ⑩ Portfolio risk (limits, cooldowns)   ⑪ Journal + shadow book + calibration
```

### ① Universe & attention ranker
Pulls the New / Final-Stretch / Migrated / Trending universes we already have. Ranks by priors (social presence, launch size, distinct buyers last 60 s, net SOL flow, curve velocity). Keeps **~25–40 coins hot** (full tape, 2–3 s refresh) and the rest warm (10–30 s snapshots). This respects free rate limits.

### ② Coin state
Per hot coin: full trade tape since launch (paginated `swap-api`), 1-min candles, holder snapshot (RugCheck, refreshed every few minutes), social snapshot, cohorts (dev, first-N-slot snipers, same-slot bundles, top-10).

### ③ Feature engine (deterministic, every tick)
- **Structure**: ATH, drawdown from peak, swing highs/lows, range width & duration, higher-low detection, curve %, age.
- **Flow (15 s / 60 s / 5 m)**: net SOL, buy share, distinct buyers, new-wallet share, median & max buy size, round-trip/wash share, whale prints.
- **Cohorts**: % supply still held by dev / snipers / bundles / top-10 (ex-pool), their sell rate → **exhaustion** = cohort sell rate falling while price holds.
- **Social**: link type, post age/engagement, author followers/account age, CA mentioned, ticker reuse count.

### ④ Risk screens (hard vetoes, explainable)
Insider network detected · bundle supply still held > X% · dev holds > X% or is selling now · top-10 ex-pool > X% · wash share > X% · mint/freeze authority present · liquidity too thin for our size. All X are config, calibrated later.

### ⑤ Analyst agent (LLM, slow lane — never times entries)
Called only for coins that passed screens and are in or near a setup. Gets a compact evidence pack (features + social posts + search hits). Returns structured JSON: narrative type & quality, CA verified?, recycled/crowded?, red flags, **conviction multiplier 0–1.5**, **approval TTL** (e.g. 10 min), and what would change its mind. All external text is treated as untrusted data. Budgeted (e.g. ≤ 30 calls/hour), cached per coin.

### ⑥ Setup detectors
P1–P5 as phase machines (§2.3). Emits a **setup event**: entry trigger price/zone, structural stop, targets (e.g. retrace levels of the dump, prior range high), evidence list, and expected R.

### ⑦ Decision
Trade only if: screens pass, analyst approval live (or setup allows small "unverified" size), **reward/risk ≥ 1.8**, and modelled **EV after full costs > 0** using the calibrated win-rate for that setup (initial priors conservative). Size = equity × risk% ÷ stop distance, capped by price impact ≤ 1% and per-coin max.

### ⑧ Execution simulator (honest fills)
Decision → 1–3 s latency → fill against pool/curve reserves **from the tape after the decision time** (no look-ahead), protocol fees, priority fee, refundable account rent, slippage tolerance as a *reject limit* (not a cost), random fail rate.

### ⑨ Position manager
Structural stop · TP1 sells ~40–50% at a level that recovers cost · trailing stop on the rest · time stop per setup · **thesis exits** from flow: dev sells, cohort dump resumes, buy share collapses, liquidity pulled, social post deleted. Migration handled (already built).

### ⑩ Portfolio risk
Risk per trade 0.5–1% of equity · max 3–5 concurrent · daily loss limit · cooldown after 3 straight losses · no same-coin re-entry for N min unless a new setup · max exposure per narrative.

### ⑪ Learning loop (how we find out if it makes money)
- **Journal** every candidate, screen result, analyst verdict, setup event and decision with full features.
- **Shadow book**: every setup event is also paper-traded counterfactually (taken or not), so we learn which filters help.
- **Controls**: a random-entry baseline account with the same exits and costs. If we can't beat random, we have no edge.
- **Champion/challenger**: variants run as separate paper accounts on the same live feed.
- **Calibration**: per-setup win rate, average R, expectancy after costs, drawdown, dependence on outliers; logistic model on features once we have a few hundred events.
- **"Makes money" bar**: ≥ 200 closed trades over ≥ 2 weeks, positive expectancy after costs with a confidence interval above zero, beats the random baseline, max drawdown within limits, profit not from 1–2 outliers.

---

## 5. Runtime & storage
- A **server-side agent worker** (Node, runs continuously, independent of the browser) inside this repo, sharing code with the Next app.
- **SQLite** (Node 24 built-in `node:sqlite`) for coin state, journal, accounts, trades. The human paper wallet stays as is; agent accounts live server-side.
- **Agent console** page: pipeline (watching → setup → approved → in position), live reasoning per coin, positions, equity curves per account, per-setup stats, controls (pause, flatten, change variant).

## 6. Free data budget (per minute, approximate)
| Source | Use | Budget |
|---|---|---|
| pump.fun lists | universe | 6–10 calls |
| pump.fun swap-api trades | tape for ~30 hot coins | ≤ 120 calls (incremental cursors) |
| DexScreener | snapshots for warm coins | ≤ 60 calls |
| RugCheck | holders/insiders | ≤ 10 calls |
| FxTwitter | social | ≤ 10 calls |
| Treg (TinyFish only, max-cost 0, waterfall 0) | CA/web search | ≤ 5 calls |
| Public RPC / free Helius | wallet funding | ≤ 30 calls |

## 7. Build phases
1. **Data & features**: worker, SQLite, tape ingestion, features, screens; console showing live features per coin.
2. **Setups + execution sim + position manager + risk**, with journal, shadow book and random baseline.
3. **Analyst agent** (LLM) + Treg/FxTwitter research tools.
4. **Calibration & reports**; then iterate on evidence.

## 8. Decisions needed from you
1. **The analyst's brain** (LLM): Claude Code headless (`claude -p`, your subscription), Claude API key (pay per token), Codex CLI (your ChatGPT login, like the old system), or no LLM.
2. **The old `meme-paper-trader` service**: keep it running alongside (both share the same free rate limits from your IP), or stop it once ours runs.
3. **Full captions**: allow fetching the five videos' full auto-captions for a deeper study than the summaries allow.
4. **Credentials you provide yourself** (never pasted into chat): a Treg token (sign in at treg.to) and optionally a free Helius RPC key, both in `.env.local`.
