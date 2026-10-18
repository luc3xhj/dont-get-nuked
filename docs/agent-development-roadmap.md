# Autonomous Paper Trading Development Roadmap

18 October 2026

The next development cycle should make the agent's evidence, decisions, and simulated results more trustworthy. The application already has five setup detectors, deterministic risk controls, simulated execution, Codex research, and performance reporting. Its largest remaining gaps concern what the data actually proves, whether strategy conditions mean what their labels say, and whether observed results survive realistic costs and independent evaluation.

The objective is to identify supported opportunities, reject or defer unsupported ones, and explain every decision. More trades, more research reports, and more elaborate models are not success measures by themselves. A quiet session can be the correct outcome.

This roadmap translates the useful ideas in the five supplied trading summaries into engineering work. The summaries provide candidate methods and hypotheses; their example thresholds and success claims do not establish trading performance. The work below is proposed development, with the existing implementation distinguished from the intended behavior.

## Scope and existing foundation

Keep the application paper only. Use free external data, the existing Codex login, and the separation between research and execution. Keep all application text, analysis output, and documentation in English.

| Area | Existing foundation | Main development need |
|---|---|---|
| Discovery | New, Final Stretch, and Migrated candidate pools | Correct event ages, explicit venue eligibility, and configurable filters |
| Trading setups | Five alternative setup detectors with entry and exit plans | Evidence requirements and persistent event sequences |
| Wallet risk | Holder concentration, early buyer cohorts, common funders, and developer activity | Coverage, actual balances, and corroborated relationships |
| Research | Contract, name, social, website, and narrative searches; structured Codex reports | Project identity, community evidence, and timely refreshes |
| Decision controls | Research rejection and sizing, market regime, exposure limits, and cooldowns | Explicit treatment of unknown evidence and related exposures |
| Simulation | Fees, impact, latency, failures, partial profit taking, and stops | Size-specific cost checks, lifecycle validation, and reproducible scenarios |
| Evaluation | Main account, shadow trades, random baseline, and performance reports | Comparable experiments, versioning, and evaluation on later unseen periods |
| Explainability | Research sources and report-to-decision attribution | Complete coverage of skipped opportunities, fills, exits, and unresolved outcomes |

## Architecture direction

Keep the worker responsible for collecting data, maintaining state, evaluating strategies, managing risk, and writing the paper ledger. The UI should display that authoritative state. Closing a browser tab must not change the agent's behavior.

The main decision path should remain deterministic:

1. Collect and normalize observations with their timestamps and coverage.
2. Update coin state, wallet evidence, and setup progression.
3. Evaluate setup-specific evidence requirements and entry conditions.
4. Apply portfolio limits, valid research, and costs for the proposed order.
5. Submit an eligible order to the execution simulator.
6. Manage the resulting position and record its outcome.

Research runs alongside this path. Treg gathers evidence, and Codex returns a bounded, structured interpretation. The decision engine decides whether that interpretation is eligible to affect an order. Research must never override missing executable prices, hard risk limits, or paper-only operation.

Use the existing SQLite store for versioned evidence, report, setup, decision, order, fill, and exit records. This chain should support both the UI and deterministic replay. A separate distributed service architecture is unnecessary at the current scale.

## Priority 0 Establish trustworthy decisions

### 1 Make evidence status and coverage explicit

**Current position.** Some unknown information can currently look favorable. A social link can produce an `ok` result without readable community content. Incomplete trade history can understate early-wallet holdings. Previously retrieved reports can remain present after refresh failures.

**Why this is worth doing.** Every strategy and research conclusion depends on the distinction between a checked condition and an unobserved condition. Correcting this prevents false confidence across the entire application.

**Direction.** Give important observations a source, observation time, retrieval time, coverage description, and status such as `verified`, `adverse`, `unknown`, or `stale`. A successful request with partial coverage must remain partial. Define required evidence separately for each setup: a strategy depending on early sellers exiting needs credible launch-cohort coverage; a narrative-dependent strategy needs more than a link. Optional unknown information may reduce confidence, while missing essential information should defer eligibility. Neither treatment should manufacture a fraud finding.

**Completion standard.** The app can explain what was checked, what was unavailable, and why the remaining evidence was sufficient or insufficient for that specific decision. Essential unknowns cannot silently pass.

### 2 Correct event times and market history

**Current position.** The migrated setup labels its condition as time since migration but evaluates age since creation. Highs, lows, and cohort behavior depend on the retained trade history, whose coverage varies.

**Why this is worth doing.** A recently migrated coin and a coin that migrated hours ago are different trading contexts. Likewise, a decline from the highest observed price is not necessarily a decline from the lifetime high.

**Direction.** Store creation time, observed migration time, first observation time, and data gaps separately. When migration time cannot be established, retain an interval or unknown value. Label price extrema by their observed window. Track pagination completeness, polling gaps, duplicate events, and timestamp ordering. Preserve positions through a curve-to-pool transition using the token mint as identity, while updating the execution venue and marking unavailable quotes honestly.

**Completion standard.** Every age and drawdown label matches the underlying measurement. A restart, late discovery, or migration cannot create an apparently complete history.

### 3 Evaluate costs at the actual proposed order size

**Current position.** The simulator models several execution costs, but the decision calculation estimates round-trip cost at a fixed 0.5 SOL size. That can misrepresent smaller orders, and the target-versus-cost check is not yet explicit.

**Why this is worth doing.** An attractive chart setup can still be unsuitable after entry costs, exit costs, and market impact. This is particularly relevant to small simulated balances and partial exits.

**Direction.** Calculate a provisional position, estimate costs for that position and its planned exits, then resize or reject until the result is internally consistent. Separate protocol fees, network fees, price impact, adverse movement, and any modeled refundable deposits. Treat slippage tolerance as an acceptance limit. Show conservative net reward and loss scenarios; label expectancy as uncertain when outcome probabilities lack sufficient evidence. Use versioned normal and adverse execution assumptions.

**Completion standard.** The decision shows order size, modeled costs, stop loss exposure, and net target proceeds. Orders that fail the configured net reward requirement remain rejected, regardless of analyst conviction.

### 4 Make decisions reproducible

**Current position.** Journals and research attribution exist. A complete replay must also preserve the exact inputs, configurations, and model outputs available at each decision.

**Why this is worth doing.** Without reproducibility, a better result might reflect a different market snapshot, changed thresholds, or random simulated fills rather than an actual improvement.

**Direction.** Save immutable decision snapshots with feature and strategy versions, evidence timestamps, the applicable analyst report, risk state, and execution assumptions. Version retained observations or retain the inputs needed to reconstruct them. Preserve the original Codex output for replay instead of requesting a new interpretation. Use seeded randomness for simulation comparisons. Keep event ingestion and order processing idempotent across restarts.

**Completion standard.** The same recorded inputs and configuration reproduce the same decision and modeled execution. Later research cannot rewrite an earlier decision or claim credit for it.

## Priority 1 Improve the trading evidence

### 5 Corroborate wallet relationships and remaining supply

**Current position.** The agent checks leading holders, wallet history, common funders, and launch-trade cohorts. Funding inspection is limited, and cohort balances inferred from trades do not fully represent transfers or actual current holdings.

**Why this is worth doing.** The useful question from the summaries is how much supply potentially coordinated wallets can still sell. A single shared characteristic does not reliably answer that question.

**Direction.** Investigate the most relevant wallets first: major holders, the developer, early buyers, and large sellers. Where free data permits, collect actual token and SOL balances, funding transfers, amounts, times, and relevant trading overlap. Validate that a funding event is a SOL transfer; a fee payer alone is not a confirmed funder. Exclude known pool and program accounts from ownership measures. Discount shared infrastructure such as exchange funders, and distinguish low activity from recent wallet creation. Combine several independent signals before escalating a suspected relationship.

Track token transfers or explicitly downgrade the reliability of a cohort's estimated holdings. Display checked supply, unresolved supply, and the evidence behind each suspected cluster.

**Completion standard.** A cluster warning explains its supporting observations and coverage. Incomplete histories or an absent detected cluster cannot be presented as proof of independent ownership.

### 6 Define developer quality using observable prior outcomes

**Current position.** Developer history is collected. The current eligibility rule allows two historical successes to qualify a developer regardless of a potentially large number of failures.

**Why this is worth doing.** The established-developer setup depends on repeatable prior behavior. Counting isolated successes can reward a prolific launcher with poor overall outcomes.

**Direction.** Define success using explicit observable outcomes and evaluation windows. Graduation, sustained liquidity, price survival, and retained buyer activity should remain distinct measurements. Include only launches that precede the candidate and only outcomes known at decision time. Treat launches too young to evaluate as unresolved. Show sample size, observation coverage, recency, and uncertainty alongside the success rate. Use conservative estimates for small samples and record repeated harmful behavior separately.

**Completion standard.** Developer eligibility is explainable from a dated history. Two successful launches cannot automatically erase a much larger failure record.

### 7 Verify project identity and community substance

**Current position.** Linked tweets and profiles can provide text and exact contract mentions. The current social adapter identifies X community links without reading the community itself.

**Why this is worth doing.** A coin can borrow an existing meme, name, or community link without belonging to that project. Popularity and identity are separate questions.

**Direction.** Separate link presence, readable content, exact contract mention, and credible project association. When accessible through free sources, collect pinned explanations, recent discussion, distinct contributors, moderation signals, and consistent references across project surfaces. Preserve original quotations and source times. Treat likes, views, visitor counts, follower counts, and banners as contextual observations rather than proof of authenticity or independent demand.

If content is inaccessible, record the gap. An exact contract mention can support a statement that the address appears in the source; it does not automatically establish ownership or endorsement.

**Completion standard.** A narrative-dependent setup cannot satisfy its narrative requirement solely because a social URL exists. The user can inspect the evidence connecting the narrative to the specific contract.

### 8 Extend narrative research with identity and competition checks

**Current position.** Research already combines contract, name, social, website, and narrative searches, with source provenance. Local ticker reuse provides some competition context.

**Why this is worth doing.** Contract-only search misses context, while name-only search can attach another project's reputation to the candidate. Related launches can also compete for the same attention.

**Direction.** Preserve the broader query plan and add explicit questions: What is the narrative? Which project does this source describe? Is the candidate an original launch, a copy, a relaunch, or unresolved? What competing launches were actually observed? Distinguish search snippets from retrieved content, and distinguish an empty search from a failed or skipped search. Timestamp competition observations and report their limited universe. Similar tickers alone should not establish a copycat finding or a claim about capital moving between projects.

Keep evidence gathering separate from interpretation. Codex should cite supplied sources and express uncertainty where identity or chronology is unresolved.

**Completion standard.** Reports explain both narrative context and contract association, with traceable sources. Broader searches add context without falsely verifying the token.

### 9 Schedule research before it becomes too late to use

**Current position.** Research already prioritizes firing or armed setups and held coins needing review. An analysis can still arrive after a short-lived opportunity has passed.

**Why this is worth doing.** Research has limited decision value if it consistently arrives after entry, or remains valid on paper after the facts have changed.

**Direction.** Use a bounded queue for promising developing setups, armed setups, and held positions with material new evidence. Cache shared narrative context while keeping contract identity checks specific to each coin. Define research validity from evidence age as well as report age. Invalidate or refresh reports after meaningful identity changes, contradictions, or new relevant facts. Keep fast price and risk changes in the deterministic engine. Discard stale research jobs without creating an order to compensate for their delay.

**Completion standard.** Measure how often usable research exists at decision time, how long it took, and why it expired or was skipped. A setup can lapse without trading while research is pending.

### 10 Represent the five setups as observable sequences

**Current position.** All five setups have structure and trigger conditions. Their history should more explicitly establish the sequence that the trading idea requires.

**Why this is worth doing.** A snapshot of low price and positive flow may resemble a setup without showing that the relevant sellers exited or that a base formed after the decline.

**Direction.** Persist setup progression, supporting event times, expiration, and invalidation. Keep the five setups as alternatives and resolve overlapping signals into one portfolio decision. Use the following evidence requirements:

| Setup | Sequence to establish | Essential qualification |
|---|---|---|
| New pair selloff | Observed launch impulse, early-cohort selling, declining selling pressure, renewed demand | Sufficient launch and remaining-supply coverage |
| Final Stretch deep selloff | Material seller exit, lower trading range, sustained stabilization, new demand | Evidence the relevant seller reduced exposure |
| Final Stretch ordinary pullback | Supported narrative, pullback, reduced sell pressure, reclaim | Narrative support tied to the candidate contract |
| Established developer base | Qualified prior developer record, sideways trading, supply absorption, demand | Adequate history and credible supply measurements |
| Migrated decline and base | Observed migration, decline, sustained base, renewed demand | Correct migration age and usable post-migration history |

Treat inactivity separately from seller exhaustion, and count distinct addresses without assuming they are independent people. Use structural invalidation and explicit expiry. Video percentages remain configurable hypotheses.

**Completion standard.** Each setup explains the observed sequence, what is still missing, and why it expired or qualified. A large decline by itself never establishes a bottom.

### 11 Make discovery and market context configurable

**Current position.** Discovery uses separate stages and fixed USD bands. Market-regime controls already affect trading.

**Why this is worth doing.** Useful filtering depends on market conditions, liquidity, and observation capacity. Fixed nominal bands can become unsuitable even when their original rationale was reasonable.

**Direction.** Record market capitalization in both SOL and USD using time-aligned prices. Make stage filters and liquidity requirements versioned configuration. Evaluate how they behave across SOL price levels and observed market activity before changing them. Make venue compatibility and special launch-mode eligibility explicit rather than inferring them only from reserve shape. Adapt polling effort within free quotas, with priority for positions and developing setups. Report how much of the eligible universe was observed.

**Completion standard.** Every candidate inclusion or exclusion has a reason. Filter changes can be compared on recorded periods and are never loosened merely to produce activity.

### 12 Strengthen position management and related exposure controls

**Current position.** Structural stops, partial profit taking, trailing stops, time limits, thesis exits, daily loss controls, and cooldowns already exist.

**Why this is worth doing.** Several individually small positions can share the same narrative, developer, or liquidity risk. Exit rules also need reliable execution state to make their simulated results meaningful.

**Direction.** Preserve the existing discipline and add limits for evidenced related exposures where practical. Apply the configured hard loss and exposure limits after analyst sizing adjustments, costs, and gap assumptions. Recheck executable exit size and liquidity during the position. Distinguish an exit decision, a submitted exit, and a confirmed simulated fill; update position accounting from fills. Retain unresolved positions when no credible executable quote exists instead of inventing a favorable exit. Test migration, partial fills or failures, repeated callbacks, and restarts. Compare alternative stop and profit-taking rules in shadow experiments before changing the main policy.

**Completion standard.** The ledger reconciles cash, tokens, fees, pending orders, and realized outcomes. Related positions cannot bypass portfolio limits, and execution failure cannot masquerade as a completed exit.

## Priority 2 Prove value and make it visible

### 13 Complete attribution from research to outcomes

**Current position.** The app already compares a decision with and without the applicable analysis and links reports to trading activity.

**Why this is worth doing.** Users need to know whether research changed a rejection, position size, or exit. Report volume does not answer that question.

**Direction.** Preserve stable links from evidence to report, decision, order, fill, and exit. Show distinct outcomes for no report, expired report, unchanged decision, analysis rejection, size change, and a decision already blocked by another rule. Record the policy defining the comparison without research, including its default size. Separate an order decision from an actual fill and a local decision comparison from a hypothetical alternative portfolio path.

Track analytical involvement in exits as well as entries. For an avoided trade, show any shadow result as a modeled comparison with its assumptions. Do not present it as guaranteed avoided loss or add it to realized account profit.

**Completion standard.** A user can inspect exactly what changed because of a report, what other rules applied, and what happened afterward. Research receives no retroactive credit.

### 14 Evaluate strategies and Codex on comparable opportunities

**Current position.** Shadow trades, a random baseline, and grouped performance statistics exist. Samples are concentrated in a subset of setups, leaving the others largely untested.

**Why this is worth doing.** Good-looking aggregate results can come from selection bias, a few exceptional winners, different execution assumptions, or repeated tuning on the same observations.

**Direction.** Record sampled candidates and rejected opportunities as well as trades, with the sampling method and missing-data reasons. Freeze strategy and execution versions for each comparison. Evaluate on later unseen periods and, where available, different market conditions. Account for repeated observations from the same coin, developer, narrative, or market period. Use reproducible normal and adverse execution assumptions across variants.

Compare the existing policy with a policy without analyst input, with narrative qualification, and with stronger wallet evidence. Keep these experiments bounded and change a small number of variables at a time. Separate the main portfolio from shadow experiments so their order processing cannot mutate its cash, cooldowns, or positions. Any shadow performance metric used by the main policy must be an explicit, versioned input, including its observation cutoff.

Report net expectancy, drawdown, failure and fill rates, time in positions, concentration of profits, and uncertainty. Distinguish realized profit from estimated liquidation value. A fixed trade count is an operational milestone, not automatic proof of an edge.

**Completion standard.** A promoted change has an explainable improvement on previously unseen observations, appropriate uncertainty, and acceptable behavior under adverse assumptions. Insufficient evidence remains a valid result.

### 15 Build the UI around evidence and decisions

**Current position.** Market, research, coin, and performance views already expose much of the pipeline.

**Why this is worth doing.** An autonomous simulator is only useful if the user can understand what it observed, why it acted, and what remains uncertain without reading worker logs.

**Direction.** Make five questions easy to answer: Why is this coin being watched? Which setup is developing? What evidence is missing? Why was this decision taken? What happened after it?

Show setup progression, data age and coverage, research sources, competing reasons, order and fill state, and outcome attribution. Keep historical analysis tied to the relevant decision snapshot rather than substituting the newest report. On Performance, separate the main account, shadow experiments, and random baseline; show per-setup results and sample sizes. Display pauses and periods without trading with their actual reasons. Provide clear paper-account controls for pausing entries and requesting exits, including pending or failed outcomes.

**Completion standard.** A user can reconstruct a trade or a skipped opportunity from the UI. Missing information, unfilled orders, and small samples remain visible.

### 16 Keep free operation reliable and bounded

**Current position.** Treg search already enforces the project's zero-cost policy. The worker combines multiple free sources with their own availability and rate limits.

**Why this is worth doing.** Free operation needs explicit resource management. Quietly stale data or repeated failed requests can undermine every downstream result.

**Direction.** Centralize per-source budgets, caching, retry backoff, health reporting, and timeouts. Retain the explicit free catalog check and both zero-cost Treg routing headers. Never substitute a paid route. Prioritize position monitoring and necessary market data over optional enrichment during quota pressure. Bound Codex concurrency and retries, and expose login or quota problems as analyst availability states.

Validate structured analyst output, source references, and field bounds before it enters decisions. Treat retrieved content as evidence rather than instructions. Keep credentials outside UI payloads and logs. Preserve observation age during failures; an unsuccessful refresh must not make old data fresh. Test restart recovery and provide enough retained state for audit and replay within a defined storage budget.

**Completion standard.** Cost-policy failures cannot start a paid request. Feed or analyst failures produce visible degraded behavior, with entry decisions governed by their required evidence and execution needs.

## Conditional work after the foundation

### 17 Add a small research wallet watchlist

**Why it may be worth doing.** Repeated wallet behavior can help explain crowded ownership, recurring participants, or selling pressure. It can add context once basic wallet coverage is trustworthy.

**Direction.** Start with a small, justified watchlist and reconstruct entry and exit behavior over explicit periods. Distinguish observed trading returns from transfers, incomplete histories, and unrealized holdings. Check common funding before treating several wallets as independent confirmation. Measure the incremental information gained relative to RPC and storage cost.

**Proceed when.** The free data budget supports reliable histories and the watchlist adds measurable context. It remains a research input; it must not create automatic copy trades.

### 18 Consider statistical ranking only after the dataset is reliable

**Why it may be worth doing.** A compact statistical model might rank observations more consistently than many manually tuned thresholds. Its value depends on the quality of its labels and evaluation.

**Direction.** First fix event times, evidence coverage, observation sampling, and outcome labels. Train a simple baseline on inputs available at decision time, evaluate it on later periods, and compare it with the existing rules. Keep risk limits deterministic and retain interpretable features. Evaluate missing-data behavior and performance drift. A model's training schedule must not optimize for recent trading frequency.

**Proceed when.** There are enough sufficiently independent and representative observations to support evaluation. An arbitrary row count alone is insufficient, and training a model is not required to complete the core roadmap.

## Delivery order and release criteria

| Stage | Work | Reason for the order | Release criterion |
|---|---|---|---|
| A Correctness | Items 1–4 | Later features depend on accurate evidence, accounting, and reproducibility | Unknown data stays unknown; ages are correct; costs match size; decisions replay |
| B Evidence and strategy | Items 5–12 | Improves the information and conditions behind actual decisions | Wallet, narrative, developer, and setup conclusions have inspectable support |
| C Evaluation and product | Items 13–16 | Establishes whether improvements help and makes operation understandable | Comparable results, complete attribution, visible degradation, and enforced free operation |
| D Optional extensions | Items 17–18 | Adds complexity only after the core system can evaluate it | Demonstrated incremental value within the existing constraints |

Some work spans stages: preserve provenance and attribution in every new feature, enforce free operation throughout, and test execution and restart behavior whenever the relevant logic changes. The table expresses dependencies rather than postponing operational correctness until Stage C.

Start Stage A with the observed semantic defects: link presence treated as narrative support, incomplete cohort history treated as low remaining supply, migration age derived from creation time, and costs estimated at a fixed order size. These changes improve the meaning of existing decisions before adding more strategies or increasing research volume.

For implementation releases, use targeted regression and integration tests, followed by the repository's required test, lint, type-check, and build checks. Use recorded fixtures for normal verification. Any live research diagnostic must retain the free-only constraints and remain separate from paper trading.

## Ideas to exclude or defer

- Real wallet signing, private-key import, live orders, paid data fallbacks, and metered model APIs are outside the current scope.
- Automatic copying of influential wallets would bypass the evidence and risk process.
- Shared balances, shared funders, similar candles, or the absence of detected clusters do not independently establish common control or safety.
- Banners, visitor counts, likes, views, and follower totals should not become standalone entry rules.
- A large price decline, a flat base, a known developer, or a compelling narrative must not override missing execution data or portfolio limits.
- Wider slippage, weaker thresholds, forced exploration, or extra orders should not be used to make the agent appear active or to make research attribution look successful.
- Video success rates and example dollar ranges should not become validated performance claims or permanent parameters.
- Large models, extensive wallet graphs, and additional infrastructure should wait until simpler methods expose a specific unmet need.

## Source and implementation references

The five summaries contribute different parts of the roadmap:

| Supplied summary | Useful contribution | Roadmap items |
|---|---|---|
| [Scalping guide](/Users/luc3xhj/Desktop/meme-paper-trader/exports/five-video-english-summaries/01-scalping-guide.txt) | Candidate filtering, seller behavior, community checks, portfolio-relative sizing, and costs | 1–3, 5, 7, 10–12 |
| [Blueprint Day 1](/Users/luc3xhj/Desktop/meme-paper-trader/exports/five-video-english-summaries/02-blueprint-day-1.txt) | Clear operating context, market eligibility, and useful interface information | 11, 15–16 |
| [Blueprint Day 2](/Users/luc3xhj/Desktop/meme-paper-trader/exports/five-video-english-summaries/03-blueprint-day-2.txt) | Wallet funding, coordinated supply, limits of simple heuristics, and execution costs | 1, 3, 5, 12 |
| [Blueprint Day 3](/Users/luc3xhj/Desktop/meme-paper-trader/exports/five-video-english-summaries/04-blueprint-day-3.txt) | Community identity, narrative type, competing launches, and wallet research | 7–9, 17 |
| [Blueprint Day 4](/Users/luc3xhj/Desktop/meme-paper-trader/exports/five-video-english-summaries/05-blueprint-day-4.txt) | Five alternative setups, developer history, changing filters, and bounded exits | 2, 6, 10–12 |

Relevant implementation entry points:

- [Setup conditions](/Users/luc3xhj/Desktop/dont-get-nuked/agent/setups.ts) and [feature computation](/Users/luc3xhj/Desktop/dont-get-nuked/agent/features.ts).
- [Discovery and state](/Users/luc3xhj/Desktop/dont-get-nuked/agent/state.ts), [risk screens](/Users/luc3xhj/Desktop/dont-get-nuked/agent/screens.ts), and [wallet evidence](/Users/luc3xhj/Desktop/dont-get-nuked/agent/wallets.ts).
- [Source adapters](/Users/luc3xhj/Desktop/dont-get-nuked/agent/sources.ts), [research query planning](/Users/luc3xhj/Desktop/dont-get-nuked/agent/research-plan.ts), [evidence collection](/Users/luc3xhj/Desktop/dont-get-nuked/agent/research.ts), and [analyst integration](/Users/luc3xhj/Desktop/dont-get-nuked/agent/analyst.ts).
- [Portfolio decisions and exits](/Users/luc3xhj/Desktop/dont-get-nuked/agent/portfolio.ts), [execution simulation](/Users/luc3xhj/Desktop/dont-get-nuked/agent/execution.ts), and [analysis attribution](/Users/luc3xhj/Desktop/dont-get-nuked/agent/analysis-impact.ts).
- [Evaluation statistics](/Users/luc3xhj/Desktop/dont-get-nuked/agent/evidence.ts) and [early observation dataset](/Users/luc3xhj/Desktop/dont-get-nuked/agent/dataset.ts).
