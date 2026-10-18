// Free data sources. Everything external is untrusted data: parsed defensively, never executed.
import { CONFIG } from "./config";
import { getJson } from "./http";
import { wilsonLower } from "./stats";
import type { Coin, DevReport, HolderReport, Quote, SocialReport, Trade } from "./types";

const PUMP = "https://frontend-api-v3.pump.fun";
const SWAP = "https://swap-api.pump.fun";
const WSOL = "So11111111111111111111111111111111111111112";
const NATIVE_SOL = "11111111111111111111111111111111";
const TOKEN_DECIMALS = 1e6;
const CURVE_SELLABLE = 793_100_000;
const CURVE_END_V_TOKENS = 279_900_000;

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const url = (v: unknown) => (typeof v === "string" && /^https?:\/\//.test(v) ? v : null);

type PumpCoin = Record<string, unknown> & { mint: string };

export async function pumpList(sort: "created_timestamp" | "last_trade_timestamp" | "market_cap", extra = ""): Promise<Coin[]> {
  const json = await getJson<PumpCoin[]>(`${PUMP}/coins/?offset=0&limit=100&sort=${sort}&order=DESC&includeNsfw=false${extra}`, { limit: 2 });
  if (!Array.isArray(json)) return [];
  const now = Date.now();
  const out: Coin[] = [];
  for (const c of json) {
    if (!c?.mint || c.nsfw) continue;
    const quote = c.quote_mint as string | null;
    if (quote && quote !== WSOL && quote !== NATIVE_SOL) continue;
    const vTok = num(c.virtual_token_reserves);
    const realTok = num(c.real_token_reserves);
    // Our pricing model assumes the standard curve; skip variants with other parameters.
    if (Math.abs(vTok - realTok - CURVE_END_V_TOKENS * TOKEN_DECIMALS) > TOKEN_DECIMALS * 1_000_000) continue;
    const complete = !!c.complete;
    out.push({
      mint: c.mint,
      symbol: String(c.symbol ?? "").slice(0, 32),
      name: String(c.name ?? "").slice(0, 64),
      creator: String(c.creator ?? ""),
      curve: String(c.bonding_curve ?? ""),
      pool: (c.pump_swap_pool as string) || null,
      stage: complete ? "migrated" : "curve",
      createdAt: num(c.created_timestamp),
      socials: { twitter: url(c.twitter), telegram: url(c.telegram), website: url(c.website) },
      replies: num(c.reply_count),
      mcapUsd: num(c.usd_market_cap),
      athMcapUsd: c.ath_market_cap == null ? null : num(c.ath_market_cap),
      curveProgress: complete ? null : Math.min(1, Math.max(0, 1 - realTok / TOKEN_DECIMALS / CURVE_SELLABLE)),
      lastTradeAt: num(c.last_trade_timestamp),
      firstSeen: now,
      updatedAt: now,
    });
  }
  return out;
}

type RawTrade = {
  slotIndexId: string;
  tx: string;
  timestamp: string;
  userAddress: string;
  type: string;
  program: string;
  amountSol: string;
  baseAmount: string;
  fillPriceSol?: string;
  priceSol: string;
};

export type TradePage = { trades: Trade[]; nextCursor: string | null; hasMore: boolean };

/** One page of a coin's trades, newest first. Covers both the curve and PumpSwap. */
export async function tradePage(mint: string, cursor: string | null): Promise<TradePage> {
  const json = await getJson<{ trades?: RawTrade[]; pagination?: { nextCursor?: string; hasMore?: boolean } }>(
    `${SWAP}/v2/coins/${mint}/trades?limit=${CONFIG.tape.pageSize}&cursor=${encodeURIComponent(cursor ?? "0")}&minSolAmount=0`,
    { limit: CONFIG.tape.concurrency },
  );
  const trades: Trade[] = [];
  for (const t of json.trades ?? []) {
    if (!t?.slotIndexId || (t.type !== "buy" && t.type !== "sell")) continue;
    trades.push({
      id: t.slotIndexId,
      tx: t.tx,
      mint,
      ts: Date.parse(t.timestamp),
      slot: Number(t.slotIndexId.slice(0, 12)),
      wallet: t.userAddress,
      side: t.type,
      sol: num(t.amountSol),
      tokens: num(t.baseAmount),
      priceSol: num(t.fillPriceSol ?? t.priceSol),
      program: t.program,
    });
  }
  return { trades, nextCursor: json.pagination?.nextCursor ?? null, hasMore: !!json.pagination?.hasMore };
}

type RugReport = {
  topHolders?: { owner: string; pct: number; insider?: boolean }[];
  totalHolders?: number;
  graphInsidersDetected?: number;
  creatorBalance?: number;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  risks?: { name: string }[];
  knownAccounts?: Record<string, { type?: string }>;
  markets?: { pubkey?: string; marketType?: string; lp?: { lpLockedPct?: number; lpLockedUSD?: number; quoteUSD?: number; baseUSD?: number } }[];
  tokenMeta?: { mutable?: boolean };
  insiderNetworks?: { size?: number; type?: string; tokenAmount?: number; currentHolding?: number }[] | null;
  totalMarketLiquidity?: number;
  rugged?: boolean;
};

/**
 * LP lock of the PumpSwap pool created at graduation — the liquidity a developer could pull.
 * Other pools (e.g. Meteora DLMM) are ordinary market makers who can always withdraw; not a rug lever.
 */
function graduationPoolLock(markets: NonNullable<RugReport["markets"]>): number | null {
  const pool = markets.find((m) => m.marketType === "pump_fun_amm" && m.lp);
  return pool ? num(pool.lp?.lpLockedPct) : null;
}

/**
 * % of supply still held by RugCheck's linked insider networks. RugCheck reports amounts in whole
 * tokens for some coins and raw units (6 decimals) for others; anything above the 1B supply must be raw.
 */
function insiderHeldPct(networks: NonNullable<RugReport["insiderNetworks"]>): number {
  const raw = networks.some((n) => num(n.tokenAmount) > CONFIG.totalSupply || num(n.currentHolding) > CONFIG.totalSupply);
  const held = networks.reduce((a, n) => a + num(n.currentHolding), 0) / (raw ? TOKEN_DECIMALS : 1);
  return Math.min(100, (held / CONFIG.totalSupply) * 100);
}

/** RugCheck's free report: top holders, insider graph, authorities, metadata, LP. */
export async function holderReport(coin: Coin): Promise<HolderReport> {
  const r = await getJson<RugReport>(`https://api.rugcheck.xyz/v1/tokens/${coin.mint}/report`, {
    limit: CONFIG.holders.concurrency,
    timeoutMs: 20_000,
  });
  // The curve / pool / lockers hold supply that can't be dumped. The creator is a "known account"
  // too, but very much can dump, so only AMM and locker accounts are excluded.
  const programOwned = new Set<string>(
    [
      coin.curve,
      coin.pool ?? "",
      ...Object.entries(r.knownAccounts ?? {})
        .filter(([, v]) => v.type === "AMM" || v.type === "LOCKER")
        .map(([k]) => k),
    ].filter(Boolean),
  );
  const top = (r.topHolders ?? [])
    .filter((h) => h?.owner && !programOwned.has(h.owner))
    .map((h) => ({ owner: h.owner, pct: num(h.pct), insider: !!h.insider }));
  const creatorPct = r.creatorBalance != null ? (num(r.creatorBalance) / CONFIG.totalSupply / TOKEN_DECIMALS) * 100 : null;
  return {
    at: Date.now(),
    totalHolders: r.totalHolders ?? null,
    top: top.slice(0, 20),
    top10ExPoolPct: top.slice(0, 10).reduce((s, h) => s + h.pct, 0),
    insidersDetected: num(r.graphInsidersDetected),
    insiderPct: insiderHeldPct(r.insiderNetworks ?? []),
    creatorPct,
    mintAuthority: r.mintAuthority ?? null,
    freezeAuthority: r.freezeAuthority ?? null,
    metadataMutable: r.tokenMeta?.mutable ?? null,
    lpLockedPct: coin.stage === "migrated" ? graduationPoolLock(r.markets ?? []) : null,
    rugged: !!r.rugged,
    risks: (r.risks ?? []).map((x) => x.name).slice(0, 10),
  };
}

/** Public X post / profile via FxTwitter (free, keyless). Communities aren't readable this way. */
export async function socialReport(coin: Coin): Promise<SocialReport> {
  const base: SocialReport = {
    at: Date.now(),
    kind: "none",
    url: coin.socials.twitter,
    text: null,
    likes: null,
    views: null,
    postedAt: null,
    author: null,
    authorFollowers: null,
    authorJoinedAt: null,
    mentionsMint: null,
    error: null,
  };
  const link = coin.socials.twitter;
  if (!link) return base;
  const m = link.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(.+?)(?:\?.*)?$/i);
  if (!m) return { ...base, kind: "other" };
  const path = m[1].replace(/\/$/, "");
  if (path.startsWith("i/communities/")) return { ...base, kind: "community" };
  try {
    if (/^[A-Za-z0-9_]+\/status\/\d+/.test(path)) {
      const j = await getJson<{ tweet?: Record<string, unknown> & { author?: Record<string, unknown> } }>(
        `https://api.fxtwitter.com/${path.split("/").slice(0, 3).join("/")}`,
        { limit: CONFIG.socials.concurrency },
      );
      const t = j.tweet;
      if (!t) return { ...base, kind: "tweet", error: "not found" };
      const text = String(t.text ?? "").slice(0, 1000);
      return {
        ...base,
        kind: "tweet",
        text,
        likes: num(t.likes),
        views: t.views == null ? null : num(t.views),
        postedAt: t.created_at ? Date.parse(String(t.created_at)) : null,
        author: String(t.author?.screen_name ?? ""),
        authorFollowers: num(t.author?.followers),
        authorJoinedAt: t.author?.joined ? Date.parse(String(t.author.joined)) : null,
        mentionsMint: text.includes(coin.mint),
      };
    }
    if (/^[A-Za-z0-9_]+$/.test(path)) {
      const j = await getJson<{ user?: Record<string, unknown> }>(`https://api.fxtwitter.com/${path}`, { limit: CONFIG.socials.concurrency });
      const u = j.user;
      if (!u) return { ...base, kind: "profile", error: "not found" };
      const bio = String(u.description ?? "");
      return {
        ...base,
        kind: "profile",
        text: bio.slice(0, 500),
        author: String(u.screen_name ?? ""),
        authorFollowers: num(u.followers),
        authorJoinedAt: u.joined ? Date.parse(String(u.joined)) : null,
        mentionsMint: bio.includes(coin.mint),
      };
    }
    return { ...base, kind: "other" };
  } catch (e) {
    return { ...base, kind: path.includes("/status/") ? "tweet" : "profile", error: e instanceof Error ? e.message : String(e) };
  }
}

/** DexScreener snapshots for up to 30 pair addresses (curve or pool) in one call. */
export async function dsQuotes(addresses: string[]): Promise<Record<string, Quote>> {
  if (!addresses.length) return {};
  const json = await getJson<{ pairs?: Record<string, unknown>[] | null }>(
    `https://api.dexscreener.com/latest/dex/pairs/solana/${addresses.slice(0, 30).join(",")}`,
    { limit: 2 },
  );
  const out: Record<string, Quote> = {};
  for (const p of json.pairs ?? []) {
    const quote = (p.quoteToken as { address?: string } | undefined)?.address;
    if (quote !== WSOL) continue;
    out[String(p.pairAddress)] = {
      at: Date.now(),
      priceSol: num(p.priceNative),
      priceUsd: num(p.priceUsd),
      liquidityUsd: num((p.liquidity as { usd?: number } | undefined)?.usd),
      mcapUsd: num(p.marketCap) || num(p.fdv),
      reserveTokens: num((p.liquidity as { base?: number } | undefined)?.base),
      reserveSol: num((p.liquidity as { quote?: number } | undefined)?.quote),
      pairCreatedAt: num(p.pairCreatedAt) || null,
    };
  }
  return out;
}

const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
/** Any URL on GeckoTerminal, for budget checks. */
export const GT_URL = `${GT}/pools`;

type GtTrade = {
  attributes: {
    block_number: number;
    block_timestamp: string;
    kind: string;
    tx_hash: string;
    tx_from_address: string;
    from_token_address: string;
    from_token_amount: string;
    to_token_amount: string;
  };
};

/** Last 300 trades of a pool (curve or PumpSwap) from GeckoTerminal; no paging. */
export async function gtTrades(mint: string, pool: string): Promise<Trade[]> {
  const json = await getJson<{ data?: GtTrade[] }>(`${GT}/pools/${pool}/trades`, { limit: 2 });
  const out: Trade[] = [];
  for (const d of json.data ?? []) {
    const a = d.attributes;
    if (a.kind !== "buy" && a.kind !== "sell") continue;
    // Buys pay SOL for tokens; sells pay tokens for SOL.
    const sol = num(a.kind === "buy" ? a.from_token_amount : a.to_token_amount);
    const tokens = num(a.kind === "buy" ? a.to_token_amount : a.from_token_amount);
    if (!sol || !tokens) continue;
    out.push({
      id: String(a.block_number).padStart(12, "0") + "gt" + a.tx_hash.slice(0, 8),
      tx: a.tx_hash,
      mint,
      ts: Date.parse(a.block_timestamp),
      slot: a.block_number,
      wallet: a.tx_from_address,
      side: a.kind,
      sol,
      tokens,
      priceSol: sol / tokens,
      program: "gt",
    });
  }
  return out;
}

/** The creator's other pump.fun launches (newest 50), summarised. */
export async function devReport(coin: Coin): Promise<DevReport> {
  const json = await getJson<PumpCoin[]>(
    `${PUMP}/coins/?offset=0&limit=50&creator=${coin.creator}&includeNsfw=true&sort=created_timestamp&order=DESC`,
    { limit: 2 }
  );
  const now = Date.now();
  const all = Array.isArray(json) ? json.filter((c) => c?.creator === coin.creator) : [];
  // Only launches before this one; only resolved ones (old enough that the outcome is known) count toward quality.
  const others = all.filter((c) => c.mint !== coin.mint && num(c.created_timestamp) < coin.createdAt);
  const resolved = others.filter((c) => now - num(c.created_timestamp) >= CONFIG.developer.resolveAfterMs);
  const ath = (c: PumpCoin) => num(c.ath_market_cap) || num(c.usd_market_cap);
  const athSorted = others.map(ath).sort((a, b) => a - b);
  const successes = resolved.filter((c) => c.complete || ath(c) >= 100_000).length;
  return {
    at: now,
    launches: others.length,
    capped: all.length >= 50,
    launches24h: others.filter((c) => now - num(c.created_timestamp) < 24 * 3600_000).length,
    graduated: others.filter((c) => c.complete).length,
    resolved: resolved.length,
    successes,
    successRate: resolved.length ? successes / resolved.length : 0,
    successLowerBound: wilsonLower(successes, resolved.length),
    bestAthUsd: athSorted.at(-1) ?? 0,
    medianAthUsd: athSorted.length ? athSorted[athSorted.length >> 1] : 0,
    died: others.filter((c) => now - num(c.created_timestamp) > 3600_000 && ath(c) < 10_000).length,
  };
}
