// Top-holder wallet checks (Setuh's bundle investigation, playbook §3): how old each wallet is and who
// funded it. Fresh wallets and holders sharing a funder suggest one entity posing as many holders.
// Uses Solana RPC: the free public endpoint by default, or Helius if HELIUS_API_KEY is set.
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
};

type Sig = { signature: string; blockTime: number | null };
type ParsedIx = { parsed?: { type?: string; info?: Record<string, unknown> } };
type ParsedTx = {
  transaction: { message: { accountKeys: { pubkey: string }[]; instructions: ParsedIx[] } };
  meta: { innerInstructions?: { instructions: ParsedIx[] }[] } | null;
};

/** Who sent this wallet its first SOL: a system transfer into it, else the fee payer of its first transaction. */
function funderOf(tx: ParsedTx, wallet: string): string | null {
  const ixs = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions)];
  for (const ix of ixs) {
    const info = ix.parsed?.info;
    if (!info) continue;
    if ((info.destination === wallet || info.newAccount === wallet) && typeof info.source === "string") return info.source;
  }
  const payer = tx.transaction.message.accountKeys[0]?.pubkey;
  return payer && payer !== wallet ? payer : null;
}

async function walletInfo(address: string): Promise<WalletInfo> {
  const cached = db.prepare("SELECT data, at FROM wallets WHERE address = ?").get(address) as { data: string; at: number } | undefined;
  if (cached && Date.now() - cached.at < 6 * 3600_000) return JSON.parse(cached.data);
  const sigs = await rpc<Sig[]>(RPC_URL, "getSignaturesForAddress", [address, { limit: SIG_LIMIT }]);
  const info: WalletInfo = { address, at: Date.now(), txCount: sigs.length, full: sigs.length < SIG_LIMIT, firstSeen: null, funder: null };
  if (info.full && sigs.length) {
    const oldest = sigs[sigs.length - 1];
    info.firstSeen = oldest.blockTime ? oldest.blockTime * 1000 : null;
    const tx = await rpc<ParsedTx | null>(RPC_URL, "getTransaction", [oldest.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    if (tx) info.funder = funderOf(tx, address);
  }
  db.prepare("INSERT OR REPLACE INTO wallets (address, at, data) VALUES (?, ?, ?)").run(address, info.at, JSON.stringify(info));
  return info;
}

const isFresh = (w: WalletInfo) => w.full && ((w.firstSeen !== null && Date.now() - w.firstSeen < FRESH_MS) || w.txCount < 5);

async function fundingReport(s: CoinState): Promise<FundingReport> {
  const holders = (s.holders?.top ?? []).slice(0, 10);
  const infos: (WalletInfo & { pct: number })[] = [];
  for (const h of holders) infos.push({ ...(await walletInfo(h.owner)), pct: h.pct });
  const fresh = infos.filter(isFresh);
  const byFunder = new Map<string, typeof infos>();
  for (const w of infos) {
    if (!w.funder || EXCHANGE_FUNDERS.has(w.funder)) continue;
    byFunder.set(w.funder, [...(byFunder.get(w.funder) ?? []), w]);
  }
  const clusters = [...byFunder.entries()]
    .filter(([, ws]) => ws.length >= 2)
    .map(([funder, ws]) => ({ funder, wallets: ws.map((w) => w.address), pct: ws.reduce((a, w) => a + w.pct, 0) }))
    .sort((a, b) => b.pct - a.pct);
  return {
    at: Date.now(),
    checked: infos.length,
    fresh: fresh.length,
    freshPct: fresh.reduce((a, w) => a + w.pct, 0),
    clusters,
    topClusterPct: clusters[0]?.pct ?? 0,
    exchangeFunded: infos.filter((w) => w.funder && EXCHANGE_FUNDERS.has(w.funder)).length,
    unknownFunder: infos.filter((w) => !w.funder).length,
    provider: process.env.HELIUS_API_KEY ? "helius" : "public",
  };
}

let running = false;
const tried = new Map<string, number>();

/** One coin at a time (each needs up to ~20 RPC calls): held first, then firing/armed setups, then the rest. */
export async function walletsTick() {
  if (running) return;
  const now = Date.now();
  const rank = (s: CoinState) => (pinned.has(s.coin.mint) ? 3 : s.setups.some((x) => x.status === "fire") ? 2 : s.setups.length ? 1 : 0);
  const next = [...coins.values()]
    .filter((s) => s.hot && s.holders?.top.length && (!s.funding || now - s.funding.at > 30 * 60_000) && now - (tried.get(s.coin.mint) ?? 0) > 10 * 60_000)
    .sort((a, b) => rank(b) - rank(a) || (b.score ?? 0) - (a.score ?? 0))[0];
  if (!next) return;
  running = true;
  tried.set(next.coin.mint, now);
  try {
    next.funding = await fundingReport(next);
    saveReport(next.coin.mint, "funding", next.funding.at, next.funding);
  } catch (e) {
    journal("funding_error", next.coin.mint, { error: e instanceof Error ? e.message : String(e) });
  } finally {
    running = false;
  }
}
