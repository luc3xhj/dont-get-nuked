# Meme Coin Trading Playbook — what the evidence says

Research notes, 18 Oct 2026, for the autonomous paper-trading agent. Each rule is tagged
**[data]** (backed by a measured study) or **[practice]** (practitioner consensus, not proven).
Sources at the end of each section. Companion to `trading-agent-design.md`.

---

## 1. The game you're actually playing

- **Almost everything dies.** 0.2–0.6% of pump.fun launches graduate; ~82% of pump.fun tokens in a 6.4M-token study were rugs (TVL −99% or idle) within an hour of the first five minutes of trading. **[data]**
- **Value is extremely concentrated.** 12 of ~12.8M pump.fun tokens hold >55% of the platform's total market cap. **[data]**
- **Most traders make little or lose.** Only 0.04% of 13.8M wallets made >$10k; even in the best month (Apr 2026, 73% of wallets in profit), 65% made $1–$500 and 5.4% made >$1k — after a lot of losing wallets had quit. **[data]**
- **Insiders, snipers and MEV take the reliable money.** One sniper earned 27,000 SOL in 30 days; sandwich bots took ~$370–500M from Solana users in 16 months; 96% of measured sandwiches hit pump.fun coins. **[data]**
- **Holding is short.** Median Solana hold time is ~100 seconds. **[data]**

**Implication:** a new coin is guilty until proven innocent. The edge for anyone without insider access or sub-slot speed is **selection and not being exit liquidity**, not speed.

Sources: [Pangolith market-structure review](https://pangolith.substack.com/p/memecoin-trading-strategy-market) · [Catching the Rug, arXiv 2608.20271](https://arxiv.org/html/2608.20271v1) · [Kamat 2026](https://arxiv.org/abs/2607.02823) · [CoinGecko: pump.fun traders](https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback) · [Mitrade/Dune: 0.04% make $10k+](https://www.mitrade.com/insights/news/live-news/article-3-565219-20250111)

## 2. How the profitable players actually trade

PANews' review of the top OKX-wallet leaderboard traders shows three archetypes **[data, one source]**:

| Archetype | Example | How | Lesson for us |
|---|---|---|---|
| **High-frequency launch sniper** | Cupsey: ~95k trades/month, 67.7% win rate | Fixed ~3 SOL in the first minutes, out in seconds to minutes, tens to ~$200 per trade, likely a private API | Pure speed game. We can't win it with 2–40 s data, so we shouldn't try. |
| **Swing / value trader** | gake: ~23 trades/day, **42% win rate** | Coins >$100k (mostly >$1M) with a strong narrative; buys bottoms or catalyst breakouts; takes a bit of principal off early and lets winners run | **Low win rate is fine if winners are much bigger than losers.** Closest to what our setups do. |
| **Stats farmer** | Cented (suspected) | Buys and sells in seconds, often on coins from scam-linked creators; suspected wash trading between own wallets | Leaderboards can be manufactured. Never copy blindly. |

Further lessons:
- Even the best lost big by **increasing size after a loss** (Cupsey's worst trade). **[data]**
- "Smart money" buying a new coin is a reason for due diligence, not a buy signal. Copying gives you their entries but not their speed, exits or information, and the wallet may be selling into you. **[practice]**
- Better signal than one wallet: **several independently profitable wallets** buying the same coin in the same window, plus holder-count growth and organic volume. Vet wallets on 7- and 30-day results, hold time and funding source; distrust round trips lasting seconds (farmers). **[practice]**

Sources: [PANews via Gate: meme whale strategies](https://www.gate.com/learn/articles/meme-whale-trading-secrets-high-frequency-gaming-and-covert-manipulation-behind-high-returns/10966) · [Pangolith](https://pangolith.substack.com/p/memecoin-trading-strategy-market)

## 3. Rug & scam catalogue — and how to detect each

| Scam | What happens | Detection | Free data |
|---|---|---|---|
| **Mint authority left open** | Dev prints new supply and sells it | Mint authority must be `None` | RugCheck |
| **Freeze authority (honeypot)** | You can buy but can't sell | Freeze authority must be `None` | RugCheck |
| **LP pull** (after migration) | Dev withdraws the pool's SOL | LP burned/locked; watch liquidity vs entry | RugCheck markets, DexScreener |
| **Mutable metadata** | Name, image or socials swapped after you buy | Metadata immutable | RugCheck token meta |
| **Bundled launch** | One entity buys 20–90% of supply across many wallets in block 0 and unloads later (PEPE ~30%, DADDY 30%/21 wallets, MYSTERY 90 fresh wallets/90%) | Same-block multi-wallet buys at launch; % still held | Trade tape ✓ |
| **Insider cluster** | Wallets linked by funding hold a big share (LIBRA 82%, Atlas ~50%/68 wallets) | Common funder + similar amounts + close funding times; fresh wallets in top 10 | RugCheck insider graph; RPC for funding |
| **Snipers** | Early bots hold supply = pre-programmed sell pressure | Buys in the first slots; % still held | Trade tape ✓ |
| **Serial-rug developer** | Same deployer launched coins that died in 1–2 weeks | Creator's past launches and outcomes | pump.fun / our own history |
| **Soft rug** | No single exit: insiders sell gradually, team abandons | Dev/insider steady selling; liquidity bleed; socials go quiet | Trade tape ✓, liquidity |
| **Fake volume / wash trading** | Bots trade with themselves to look hot (one funder seeded 200 bots × exactly 0.5 SOL; 40k trades, $532k volume in 12 h; 96% of wallets traded both sides; round-trip ratio 0.95–1.00). Bots are 60–80% of volume on some coins | High trades per trader, small average trade, high two-sided wallet share, round-trip ratio ≈ 1, ≥ 60% of volume from 5–10 wallets, common funder | Trade tape ✓ (funder needs RPC) |
| **Price pinning** | Tiny two-sided trades hold the price steady | Many micro trades, flat price, same wallets | Trade tape ✓ |
| **Paid KOL pump** | Influencers shill in a tight window, then dump | Several posts with similar wording at once, urgency; big-account calls do worst | X / web search |
| **Cabal fast-fill** | Coordinated buying fills the curve in < 30 min, then dumps on graduation | Very fast curve fill with concentrated buyers | Trade tape ✓ |

**Decision rule** used by one checklist: 3+ red flags means pass; 1–2 amber flags means smaller size; all green still isn't safe. **[practice]**

**Holder concentration thresholds (top 10, excluding pool/curve):** < 30% healthy · 30–50% watch · 50%+ high risk · 70%+ one sale can crash it. **[practice]**

Sources: [j.tools: 8 checks](https://j.tools/en/blog/solana-rugpull-detection-8-checks) · [Bitquery: Solana volume numbers are a lie](https://bitquery.io/blog/solana-volume-numbers-are-a-lie) · [Bubblemaps cases: PEPE](https://cointelegraph.com/news/pepe-memecoin-launch-insider-wallet-concentration-bubblemaps), [LIBRA](https://yellow.com/news/bubblemaps-investigation-reveals-dollar100m-libra-token-scheme), [MYSTERY](https://cryptorank.io/news/feed/1f890-bubblemaps-mystery-memecoin-sniping-price-manipulation), [Atlas](https://www.cryptopolitan.com/bubblemaps-flags-risks-atlas-meme/) · [Bot volume on pump.fun](https://www.itiger.com/news/2536692822) · [SolanaHub: bot detection](https://solanahub.de/en/knowledge/detecting-solana-bots/)

## 4. Signals that predict outcomes

- **First five minutes predict rugs.** Gradient-boosted models on 23 early-trade features (tx count, unique buyers/sellers, SOL volumes, buy/sell ratios, early price change, price volatility, time to first buy/sell, drop after the early max) reached AUCPRC ~0.76–0.80 on pump.fun. Models don't transfer between venues, so train on our own venue's data. **[data, preprint]**
- **Social presence:** a Telegram link correlates with ~9× graduation; all three socials vs none ~17×. Launch size is the strongest single predictor. **[data, not causal]**
- **KOL calls are mostly bad:** two-thirds of influencer-promoted memecoins were "dead" (−90%); one week after a call, 80% had lost 70%. **Calls from 200k+ follower accounts did worst**; smaller accounts did better. **[data, one study]**
- **Curve position:** a curve 70%+ filled has limited upside to graduation but full downside, and graduation is often a *fade* on insider-heavy coins. **[practice]**
- **Hot narratives aren't profitable by default:** memecoins averaged −31.6% in 2025 even while being the hottest narrative. Buy the inflection, not the confirmation; attention decays in hours. **[data + practice]**

Sources: [Catching the Rug](https://arxiv.org/html/2608.20271v1) · [Kamat 2026](https://arxiv.org/html/2607.02823v3) · [PANews: KOL memes](https://www.panewslab.com/en/articles/rmpr0tel) · [CoinGecko narratives 2025](https://www.coingecko.com/research/publications/most-profitable-crypto-narratives)

## 5. Risk, sizing, exits, execution **[practice]**

- **Size:** risk ~1–2% of the account per trade (a run of losses at 1% costs single digits; at 10% it's ruin). Never add size after a loss.
- **Liquidity:** be able to exit the full position within ~2% of price; daily volume ≥ ~10× position.
- **Exits are set before entry:** an invalidation level plus a profit ladder (recover principal early, scale out, trail the rest). With a 35–45% win rate, expectancy lives in the right tail, so the ladder must let winners run.
- **Hard daily loss limit.**
- **Execution:** tight slippage and MEV protection (wide slippage is the strongest predictor of getting sandwiched), and avoid the first minutes of a launch unless that's the tested strategy.
- **Costs:** model the 1.25% curve fee each way, ~1% terminal fee, priority tips and slippage under low, medium and harsh assumptions. If a small degradation kills the edge, there is no edge.

## 6. Proving it works **[practice]**

- Test on **every** launch in a window, not just survivors.
- Evaluate by **regime** and have a "don't trade now" filter (sector volume, share of profitable wallets).
- Paper trade over a statistically meaningful sample; scale only after results hold across at least one full sentiment regime.
- **Journal** thesis, screens and exit reason for every trade.

Sources: [Pangolith](https://pangolith.substack.com/p/memecoin-trading-strategy-market) · [Thrive: sizing & exits](https://thrive.fi/blog/trading/memecoin-trading-strategy-risk-management-guide) · [Altrady: risk & execution](https://www.altrady.com/blog/crypto-trading-strategies/how-to-trade-memecoins)

---

## 7. How our agent measures up

### Already aligned
- Doesn't compete on speed; trades post-dump setups after sniper and insider supply has left (Setuh, plus "don't be exit liquidity").
- Bundle and sniper cohorts from the tape; RugCheck insiders, concentration and authorities; hollow-liquidity screen; dev-selling exit.
- 1% risk per trade, half off at TP1 then trailing, structural stops, time stops, daily loss and drawdown limits, cooldown after a losing streak, **never adds after a loss**.
- Full cost model (curve 1.25%, pool fee, 1% adverse slippage, failures); test against **every** setup (shadow) and a random control; full journal.

### Built (18 Oct 2026)
1. ✅ **Volume-quality screen** — wash score from trades/wallet, average trade, two-sided wallets, round-trip ratio of the top 10, top-5/10 volume share, repeat buys; veto at a high score or concentrated two-sided volume.
2. ✅ **Early-life rug dataset** — the paper's first-five-minute features plus launch-cohort extras, for hot coins and a random sample of launches, labeled at 1 h; CSV export on the Performance page. Training a classifier waits for a few thousand rows.
3. ✅ **Authorities, metadata & LP** — mutable metadata and RugCheck "rugged" veto; graduation-pool LP must be ≥ 90% locked/burned (other pools are ordinary market makers). Insider-network veto now depends on supply the networks still hold (≥ 10%), not just their existence.
4. ✅ **Curve position & fast fill** — Final Stretch setups won't buy above 90% curve with heavy insiders/top-10; "fast curve fill" warns (vetoes when the top-10 buyers paid ≥ 50%).
5. ✅ **Regime gate** — SOL 1h move, observed graduations in 2 h, and the every-setup benchmark's last 20 trades: bad = no entries, caution = half size.
8. ✅ **KOL-call awareness** — screen for fresh contract-promoting posts by 200k+ accounts; analyst evidence distinguishes promotional calls from narrative sources and knows the call research.

### Still open
6. **Fresh-wallet & funding clusters** — needs per-wallet history (RPC; a free Helius key makes it practical).
7. **Creator history** — deployer's past launches and outcomes.
9. **Multi-wallet confirmation** — a vetted list of profitable wallets, used as evidence, never copied.
