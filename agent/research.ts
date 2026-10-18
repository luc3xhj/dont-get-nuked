// Evidence for the analyst: what we already know about a coin, plus free web search (Treg).
// Treg policy (user requirement): FREE ONLY. Allowlisted endpoints, catalog price verified as
// $0 before use, X-Treg-Route-Max-Cost: 0, no vendor waterfall, and any reported cost disables it.
import { db } from "./db";
import { laneOf, type CoinState } from "./state";
import type { Coin } from "./types";

const TREG = "https://treg.to";
const ALLOWED = new Set(["tinyfish.web.search"]);

export const tregHealth = {
  configured: !!process.env.TREG_TOKEN,
  calls: 0,
  failures: 0,
  disabled: null as string | null,
  lastError: null as string | null,
  lastCallId: null as string | null,
  lastCostMicro: null as number | null,
  lastSuccessAt: null as number | null,
  lastResultCount: null as number | null,
};

const priceChecked = new Map<string, number>();

async function verifyFree(id: string) {
  if (Date.now() - (priceChecked.get(id) ?? 0) < 3600_000) return;
  const res = await fetch(`${TREG}/catalog/endpoints/${id}`, { signal: AbortSignal.timeout(12_000), redirect: "error" });
  if (!res.ok) throw new Error(`price check ${res.status}`);
  const cost = ((await res.json()) as { endpoint?: { cost?: { type?: string; usd?: number } } }).endpoint?.cost;
  if (cost?.type !== "free" || cost.usd !== 0) throw new Error(`${id} is not listed as free`);
  priceChecked.set(id, Date.now());
}

export type WebResult = { title: string; url: string; snippet: string };

/** Free web search via Treg/TinyFish. Returns null when unavailable (unconfigured, not free, error). */
export async function webSearch(query: string, opts: { domains?: string[]; purpose?: string } = {}): Promise<WebResult[] | null> {
  const token = process.env.TREG_TOKEN;
  const id = "tinyfish.web.search";
  if (!token || !ALLOWED.has(id) || tregHealth.disabled) return null;
  try {
    await verifyFree(id);
    const url = new URL(`${TREG}/call/${id}`);
    url.searchParams.set("query", query);
    url.searchParams.set("domain_type", "web");
    if (opts.purpose) url.searchParams.set("purpose", opts.purpose);
    for (const d of opts.domains ?? []) url.searchParams.append("include_domains", d);
    tregHealth.calls++;
    const res = await fetch(url, {
      headers: { "X-Treg-Token": token, "X-Treg-Route-Max-Cost": "0", "X-Treg-Route-Waterfall": "0" },
      signal: AbortSignal.timeout(25_000),
      redirect: "error",
    });
    const cost = res.headers.get("X-Treg-Cost-Micro");
    tregHealth.lastCallId = res.headers.get("X-Treg-Call-Id");
    tregHealth.lastCostMicro = cost !== null && Number.isFinite(Number(cost)) ? Number(cost) : null;
    if (cost !== null && Number(cost) !== 0) {
      tregHealth.disabled = `A call reported a cost (${cost} micro-USD); Treg disabled until restart`;
      throw new Error(tregHealth.disabled);
    }
    if (!res.ok) throw new Error(`Treg ${res.status}${tregHealth.lastCallId ? ` (call ${tregHealth.lastCallId})` : ""}`);
    if (res.headers.has("X-Treg-Upstream-Failed")) throw new Error("Treg upstream reported a failed search");
    const json = (await res.json()) as Record<string, unknown>;
    // TinyFish returns { results: [{ title, url, snippet|description|content }] }; be tolerant of shape.
    const list = json.results ?? json.data ?? json.items;
    if (!Array.isArray(list)) throw new Error("Treg returned an unexpected search response");
    if (list.some((r) => !r || typeof r !== "object")) throw new Error("Treg returned an invalid search result");
    tregHealth.lastError = null;
    tregHealth.lastSuccessAt = Date.now();
    const results = list.slice(0, 8).map((r) => ({
      title: String(r.title ?? "").slice(0, 200),
      url: String(r.url ?? r.link ?? ""),
      snippet: String(r.snippet ?? r.description ?? r.content ?? "").slice(0, 400),
    })).filter((r) => /^https?:\/\//i.test(r.url));
    tregHealth.lastResultCount = results.length;
    return results;
  } catch (e) {
    tregHealth.failures++;
    tregHealth.lastError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

/** Other coins with the same ticker we've seen in the last day: copycats, relaunches, or the original. */
function tickerReuse(c: Coin) {
  const rows = db
    .prepare("SELECT data FROM coins WHERE lower(json_extract(data, '$.symbol')) = lower(?) AND updated_at > ?")
    .all(c.symbol, Date.now() - 24 * 3600_000) as { data: string }[];
  const others = rows.map((r) => JSON.parse(r.data) as Coin).filter((x) => x.mint !== c.mint);
  const leader = [...others].sort((a, b) => (b.athMcapUsd ?? b.mcapUsd) - (a.athMcapUsd ?? a.mcapUsd))[0];
  return {
    sameTickerLast24h: others.length,
    olderCopies: others.filter((x) => x.createdAt < c.createdAt).length,
    largestOther: leader
      ? {
          symbol: leader.symbol,
          name: leader.name,
          ageMin: Math.round((Date.now() - leader.createdAt) / 60_000),
          athMcapUsd: Math.round(leader.athMcapUsd ?? leader.mcapUsd),
        }
      : null,
  };
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** Compact, factual evidence pack. Everything inside is data, never instructions. */
export async function buildEvidence(s: CoinState) {
  const c = s.coin;
  const f = s.features;
  const now = Date.now();
  const web = await webSearch(`"${c.mint}"`, { purpose: "Find posts and pages mentioning this exact Solana token contract address" });
  return {
    coin: {
      symbol: c.symbol,
      name: c.name,
      mint: c.mint,
      ageMin: Math.round((now - c.createdAt) / 60_000),
      pool: laneOf(c, now),
      stage: c.stage,
      curveProgressPct: c.curveProgress === null ? null : Math.round(c.curveProgress * 100),
      mcapUsd: Math.round(s.quote?.mcapUsd ?? c.mcapUsd),
      athMcapUsd: c.athMcapUsd === null ? null : Math.round(c.athMcapUsd),
      pumpReplies: c.replies,
      links: c.socials,
    },
    linkedPost: s.social && {
      kind: s.social.kind,
      text: s.social.text,
      author: s.social.author,
      authorFollowers: s.social.authorFollowers,
      authorAccountAgeDays: s.social.authorJoinedAt ? Math.round((now - s.social.authorJoinedAt) / 86_400_000) : null,
      postAgeHours: s.social.postedAt ? round((now - s.social.postedAt) / 3_600_000, 1) : null,
      likes: s.social.likes,
      views: s.social.views,
      mentionsThisContract: s.social.mentionsMint,
      error: s.social.error,
      // Is this a promotional call (mentions the contract) or the narrative source (doesn't)?
      readAs:
        s.social.kind !== "tweet"
          ? s.social.kind
          : s.social.mentionsMint
            ? (s.social.authorFollowers ?? 0) >= 200_000
              ? "promotional call by a very large account (historically the worst post-call returns)"
              : "promotional call"
            : "narrative source (post doesn't mention this contract)",
    },
    tickerReuse: tickerReuse(c),
    developer: s.dev && {
      priorLaunches: s.dev.launches,
      moreThanShown: s.dev.capped,
      launchesLast24h: s.dev.launches24h,
      graduated: s.dev.graduated,
      successRate: round(s.dev.successRate),
      bestAthUsd: Math.round(s.dev.bestAthUsd),
      died: s.dev.died,
    },
    topHolderWallets: s.funding && {
      checked: s.funding.checked,
      underADayOld: s.funding.fresh,
      freshWalletsHoldPct: round(s.funding.freshPct, 1),
      largestSharedFunderClusterPct: round(s.funding.topClusterPct, 1),
      exchangeFunded: s.funding.exchangeFunded,
    },
    holders: s.holders && {
      totalHolders: s.holders.totalHolders,
      top10ExPoolPct: round(s.holders.top10ExPoolPct, 1),
      insiderWalletsFlagged: s.holders.insidersDetected,
      insiderNetworksHoldPct: round(s.holders.insiderPct ?? 0, 1),
      metadataMutable: s.holders.metadataMutable,
      lpLockedPct: s.holders.lpLockedPct ?? null,
      risks: s.holders.risks,
    },
    market: f && {
      drawdownFromAthPct: Math.round(f.drawdown * 100),
      minutesSinceAth: round(f.minSinceAth, 1),
      bounceFromLowPct: Math.round(f.bounceFromLow * 100),
      flow60s: {
        netSol: round(f.flow60s.netSol),
        buyers: f.flow60s.buyers,
        sellers: f.flow60s.sellers,
        newBuyerShare: round(f.flow60s.newBuyerShare),
      },
      flow5m: { netSol: round(f.flow5m.netSol), buyers: f.flow5m.buyers, sellers: f.flow5m.sellers, roundTripShare: round(f.flow5m.roundTripShare) },
      insidersHeldPct: round(f.cohorts.insiders.heldPct, 1),
      devHeldPct: round(f.cohorts.dev.heldPct, 1),
      repeatBuyShare: round(f.repeatBuyShare),
      volumeQuality: {
        washScore: f.volume.washScore === null ? null : round(f.volume.washScore),
        top10WalletVolumeShare: round(f.volume.top10VolShare),
        twoSidedWalletShare: round(f.volume.twoSidedShare),
        tradesPerWallet: round(f.volume.tradesPerTrader, 1),
      },
      launchBuyConcentrationTop10: f.launchBuyConcentration === null ? null : round(f.launchBuyConcentration),
      launchCohortsKnown: f.tapeFromLaunch,
    },
    screens: s.screens.filter((x) => x.level !== "ok").map((x) => `${x.level}: ${x.label} — ${x.detail}`),
    setups: s.setups.map((x) => ({
      setup: x.setup,
      status: x.status,
      failing: [...x.structure, ...x.trigger].filter((k) => !k.ok).map((k) => `${k.label} (${k.value})`),
    })),
    webSearchForContract: web === null ? "unavailable (search not configured or failed)" : web,
  };
}
