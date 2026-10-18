// Top-holder wallet checks (Setuh's bundle investigation, playbook §3): how old each wallet is and who
// funded it. Fresh wallets and holders sharing a funder suggest one entity posing as many holders.
// Uses Solana RPC: the free public endpoint by default, or Helius if HELIUS_API_KEY is set.
import { CONFIG } from "./config";
import { db, journal, saveReport } from "./db";
import { rpc } from "./http";
import { coins, pinned, type CoinState } from "./state";
import type { FundingReport } from "./types";

const RPC_URL = process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "https://api.mainnet-beta.solana.com";
const SIG_LIMIT = 1000;
const FRESH_MS = 24 * 3600_000;

/**
 * Exchange hot wallets fund thousands of unrelated users, so a shared exchange funder is not evidence of
 * common control (Setuh's own caveat). Best-effort list of large Solana exchange hot wallets; extend as needed.
 */
const EXCHANGE_FUNDERS = new Set([
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", // Binance
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", // Binance
  "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS", // Coinbase
  "2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm", // Coinbase
  "5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD", // OKX
  "AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2", // Bybit
]);

db.exec("CREATE TABLE IF NOT EXISTS wallets (address TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL)");

export type WalletInfo = {
  address: string;
  at: number;
  /** Signatures found, capped at 1000 ("1000+" means an established, active wallet). */
  txCount: number;
  /** We saw the wallet's whole history (fewer than 1000 transactions). */
  full: boolean;
  firstSeen: number | null;
  funder: string | null;
  /** "transfer" = an actual SOL transfer into the wallet (real evidence); "fee_payer" = someone paid its first fee (weak). */
  funderBasis?: "transfer" | "fee_payer" | null;
};

type Sig = { signature: string; blockTime: number | null };
type ParsedIx = { parsed?: { type?: string; info?: Record<string, unknown> } };
type ParsedTx = {
  transaction: { message: { accountKeys: { pubkey: string }[]; instructions: ParsedIx[] } };
  meta: { innerInstructions?: { instructions: ParsedIx[] }[] } | null;
};

/** Who sent this wallet its first SOL: a system transfer into it, else (weakly) the fee payer of its first transaction. */
function funderOf(tx: ParsedTx, wallet: string): { funder: string; basis: "transfer" | "fee_payer" } | null {
  const ixs = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions)];
  for (const ix of ixs) {
    const info = ix.parsed?.info;
    if (!info) continue;
    if ((info.destination === wallet || info.newAccount === wallet) && typeof info.source === "string") return { funder: info.source, basis: "transfer" };
  }
  const payer = tx.transaction.message.accountKeys[0]?.pubkey;
  return payer && payer !== wallet ? { funder: payer, basis: "fee_payer" } : null;
}

/** Why a wallet lookup failed: a technical failure is never evidence about the token. */
export type LookupFailure = "rate_limited" | "unsupported_transaction" | "history_unavailable" | "network" | "other";

function categorize(e: unknown): LookupFailure {
  const msg = e instanceof Error ? e.message : String(e);
  if (/429|rate/i.test(msg)) return "rate_limited";
  if (/version .* is not supported/i.test(msg)) return "unsupported_transaction";
  if (/long-term storage|not available|missing in long-term/i.test(msg)) return "history_unavailable";
  if (/fetch failed|timeout|aborted|ECONN|socket/i.test(msg)) return "network";
  return "other";
}

const RETRYABLE = new Set<LookupFailure>(["rate_limited", "history_unavailable", "network"]);
/** Highest transaction version we ask the RPC for; raised automatically when the RPC reports a newer one. */
let maxTxVersion = 1;

/** One RPC call with bounded retries (exponential backoff with jitter) for transient failures. */
async function rpcRetry<T>(method: string, params: unknown[], attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await rpc<T>(RPC_URL, method, params);
    } catch (e) {
      const cat = categorize(e);
      // The RPC names the version it needs; adopt it once and retry (the parsed format is unchanged).
      const need = Number((e instanceof Error ? e.message : "").match(/"maxSupportedTransactionVersion":\s*(\d+)/)?.[1]);
      if (cat === "unsupported_transaction" && need > maxTxVersion && need <= 5) {
        maxTxVersion = need;
        const p = params[1] as Record<string, unknown>;
        params = [params[0], { ...p, maxSupportedTransactionVersion: need }];
        continue;
      }
      if (!RETRYABLE.has(cat) || i + 1 >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 1_000 * 2 ** i + Math.random() * 500));
    }
  }
}

async function walletInfo(address: string): Promise<WalletInfo> {
  const cached = db.prepare("SELECT data, at FROM wallets WHERE address = ?").get(address) as { data: string; at: number } | undefined;
  if (cached && Date.now() - cached.at < 6 * 3600_000) return JSON.parse(cached.data);
  const sigs = await rpcRetry<Sig[]>("getSignaturesForAddress", [address, { limit: SIG_LIMIT }]);
  const info: WalletInfo = { address, at: Date.now(), txCount: sigs.length, full: sigs.length < SIG_LIMIT, firstSeen: null, funder: null, funderBasis: null };
  if (info.full && sigs.length) {
    const oldest = sigs[sigs.length - 1];
    info.firstSeen = oldest.blockTime ? oldest.blockTime * 1000 : null;
    const tx = await rpcRetry<ParsedTx | null>("getTransaction", [oldest.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: maxTxVersion }]);
    const f = tx?.transaction?.message ? funderOf(tx, address) : null;
    info.funder = f?.funder ?? null;
    info.funderBasis = f?.basis ?? null;
  }
  db.prepare("INSERT OR REPLACE INTO wallets (address, at, data) VALUES (?, ?, ?)").run(address, info.at, JSON.stringify(info));
  return info;
}

const isFresh = (w: WalletInfo) => w.full && ((w.firstSeen !== null && Date.now() - w.firstSeen < FRESH_MS) || w.txCount < 5);

/**
 * Checks each top holder independently: one failed lookup never discards the others. The report
 * keeps what succeeded, what failed and why, and how much of the top holders' supply was covered.
 */
export async function fundingReport(s: CoinState, lookup: (address: string) => Promise<WalletInfo> = walletInfo): Promise<FundingReport> {
  const holders = (s.holders?.top ?? []).slice(0, 10);
  const infos: (WalletInfo & { pct: number })[] = [];
  const failed: FundingReport["failed"] = [];
  for (const h of holders) {
    try {
      infos.push({ ...(await lookup(h.owner)), pct: h.pct });
    } catch (e) {
      failed.push({ address: h.owner, pct: h.pct, category: categorize(e), error: (e instanceof Error ? e.message : String(e)).slice(0, 160) });
    }
  }
  const fresh = infos.filter(isFresh);
  const byFunder = new Map<string, typeof infos>();
  // Cached entries from before funderBasis existed are treated as weak (fee payer) evidence.
  const byTransfer = (w: WalletInfo) => !!w.funder && w.funderBasis === "transfer";
  for (const w of infos) {
    if (!byTransfer(w) || EXCHANGE_FUNDERS.has(w.funder!)) continue;
    byFunder.set(w.funder!, [...(byFunder.get(w.funder!) ?? []), w]);
  }
  const clusters = [...byFunder.entries()]
    .filter(([, ws]) => ws.length >= 2)
    .map(([funder, ws]) => ({ funder, wallets: ws.map((w) => w.address), pct: ws.reduce((a, w) => a + w.pct, 0) }))
    .sort((a, b) => b.pct - a.pct);
  const requestedPct = holders.reduce((a, h) => a + h.pct, 0);
  const checkedPct = infos.reduce((a, w) => a + w.pct, 0);
  const now = Date.now();
  const failureCounts: Partial<Record<LookupFailure, number>> = {};
  for (const f of failed) failureCounts[f.category] = (failureCounts[f.category] ?? 0) + 1;
  return {
    at: now,
    expiresAt: now + CONFIG.decision.fundingMaxAgeMs,
    requested: holders.length,
    checked: infos.length,
    fresh: fresh.length,
    freshPct: fresh.reduce((a, w) => a + w.pct, 0),
    clusters,
    topClusterPct: clusters[0]?.pct ?? 0,
    exchangeFunded: infos.filter((w) => w.funder && EXCHANGE_FUNDERS.has(w.funder)).length,
    unknownFunder: infos.filter((w) => !w.funder).length,
    payerOnly: infos.filter((w) => w.funder && !byTransfer(w)).length,
    transferBacked: infos.filter(byTransfer).length,
    requestedPct,
    checkedPct,
    coverage: requestedPct ? checkedPct / requestedPct : 0,
    unresolvedPct: infos.filter((w) => !byTransfer(w)).reduce((a, w) => a + w.pct, 0) + failed.reduce((a, f) => a + f.pct, 0),
    failed,
    failureCounts,
    provider: process.env.HELIUS_API_KEY ? "helius" : "public",
  };
}

let running = false;
const tried = new Map<string, number>();

/** Armed setups nearest their trigger first (share of trigger checks passing). */
const triggerProximity = (s: CoinState) => Math.max(0, ...s.setups.map((x) => x.trigger.filter((k) => k.ok).length / Math.max(1, x.trigger.length)));

/**
 * One coin at a time (each needs up to ~20 RPC calls): held positions first, then firing setups, then
 * armed setups closest to their trigger, then the rest. Incomplete reports are retried after 2 minutes.
 */
export async function walletsTick() {
  if (running) return;
  const now = Date.now();
  const rank = (s: CoinState) =>
    (pinned.has(s.coin.mint) ? 30 : s.setups.some((x) => x.status === "fire") ? 20 : s.setups.length ? 10 + triggerProximity(s) * 5 : 0);
  const due = (s: CoinState) => {
    const f = s.funding;
    if (!f) return now - (tried.get(s.coin.mint) ?? 0) > 2 * 60_000;
    const incomplete = (f.coverage ?? 1) < 1;
    return now - f.at > (incomplete ? 2 * 60_000 : 30 * 60_000) && now - (tried.get(s.coin.mint) ?? 0) > 2 * 60_000;
  };
  const next = [...coins.values()]
    .filter((s) => s.hot && s.holders?.top.length && due(s))
    .sort((a, b) => rank(b) - rank(a) || (b.score ?? 0) - (a.score ?? 0))[0];
  if (!next) return;
  running = true;
  tried.set(next.coin.mint, now);
  try {
    const report = await fundingReport(next);
    next.funding = report;
    saveReport(next.coin.mint, "funding", report.at, report);
    if (report.failed?.length)
      journal("funding_partial", next.coin.mint, { checked: report.checked, requested: report.requested, coverage: report.coverage, failureCounts: report.failureCounts });
  } catch (e) {
    journal("funding_error", next.coin.mint, { error: e instanceof Error ? e.message : String(e) });
  } finally {
    running = false;
  }
}
