// Free-only Treg research with per-query provenance. The worker owns collection and cost limits.
import { db } from "./db";
import { laneOf, type CoinState } from "./state";
import type { Coin } from "./types";
import type { ResearchBundle, ResearchQuery, ResearchSource, SearchTrace } from "../src/lib/research-types";
import { mergeSources, publicUrl, researchPlan, type ResearchInput } from "./research-plan";

const TREG = "https://treg.to";
const ENDPOINT = "tinyfish.web.search";
export const tregHealth = {
  configured: !!process.env.TREG_TOKEN,
  calls: 0, failures: 0,
  disabled: null as string | null, lastError: null as string | null,
  lastCallId: null as string | null, lastCostMicro: null as number | null,
  lastSuccessAt: null as number | null, lastResultCount: null as number | null,
};
let priceCheckedAt = 0;
const starts: number[] = [];

async function verifyFree() {
  if (Date.now() - priceCheckedAt < 3600_000) return;
  const res = await fetch(`${TREG}/catalog/endpoints/${ENDPOINT}`, { signal: AbortSignal.timeout(12_000), redirect: "error" });
  if (!res.ok) throw new Error(`Price check HTTP ${res.status}`);
  const cost = ((await res.json()) as { endpoint?: { cost?: { type?: string; usd?: number } } }).endpoint?.cost;
  if (cost?.type !== "free" || cost.usd !== 0) throw new Error(`${ENDPOINT} is not listed as free`);
  priceCheckedAt = Date.now();
}
export type WebResult = { title: string; url: string; snippet: string };

export async function searchWithTrace(query: ResearchQuery): Promise<{ trace: SearchTrace; results: WebResult[] }> {
  const trace: SearchTrace = { ...query, at: Date.now(), status: "skipped", callId: null, costMicro: null, error: null, resultUrls: [] };
  const token = process.env.TREG_TOKEN;
  while (starts.length && starts[0] < Date.now() - 60_000) starts.shift();
  if (!token || tregHealth.disabled || starts.length >= 24) {
    trace.error = !token ? "Treg is not configured" : tregHealth.disabled ?? "Local search rate limit reached";
    return { trace, results: [] };
  }
  starts.push(Date.now());
  try {
    await verifyFree();
    const url = new URL(`${TREG}/call/${ENDPOINT}`);
    url.searchParams.set("query", query.query);
    url.searchParams.set("domain_type", "web");
    url.searchParams.set("purpose", query.purpose);
    for (const d of query.domains ?? []) url.searchParams.append("include_domains", d);
    tregHealth.calls++;
    const res = await fetch(url, {
      headers: { "X-Treg-Token": token, "X-Treg-Route-Max-Cost": "0", "X-Treg-Route-Waterfall": "0" },
      signal: AbortSignal.timeout(20_000), redirect: "error",
    });
    const cost = res.headers.get("X-Treg-Cost-Micro");
    trace.callId = res.headers.get("X-Treg-Call-Id");
    trace.costMicro = cost !== null && cost.trim() !== "" && Number.isFinite(Number(cost)) ? Number(cost) : null;
    tregHealth.lastCallId = trace.callId;
    tregHealth.lastCostMicro = trace.costMicro;
    if (cost !== null && trace.costMicro !== 0) {
      tregHealth.disabled = "A call reported a cost or invalid charge metadata; Treg disabled until restart";
      throw new Error(tregHealth.disabled);
    }
    if (!res.ok) throw new Error(`Treg HTTP ${res.status}`);
    if (res.headers.has("X-Treg-Upstream-Failed")) throw new Error("Treg upstream reported a failed search");
    const json = await res.json();
    const list = json?.results ?? json?.data ?? json?.items;
    if (!Array.isArray(list)) throw new Error("Treg returned an unexpected search response");
    if (list.some((r) => !r || typeof r !== "object")) throw new Error("Treg returned an invalid search result");
    const results: WebResult[] = list.slice(0, 8).map((r) => ({
      title: String(r.title ?? "").slice(0, 200), url: String(r.url ?? r.link ?? ""),
      snippet: String(r.snippet ?? r.description ?? r.content ?? "").slice(0, 600),
    })).filter((r) => publicUrl(r.url)).map((r) => ({ ...r, url: publicUrl(r.url)! }))
      .filter((r) => !query.domains?.length || query.domains.some((domain) => {
        const host = new URL(r.url).hostname;
        return host === domain || host.endsWith(`.${domain}`);
      }));
    trace.resultUrls = results.map((r) => r.url);
    trace.status = results.length ? "ok" : "empty";
    tregHealth.lastError = null;
    tregHealth.lastSuccessAt = Date.now();
    tregHealth.lastResultCount = results.length;
    return { trace, results };
  } catch (e) {
    trace.status = "error";
    trace.error = e instanceof Error ? e.message : String(e);
    tregHealth.failures++;
    tregHealth.lastError = trace.error;
    return { trace, results: [] };
  }
}

/** Compatibility helper for the standalone connectivity diagnostic. */
export async function webSearch(query: string, opts: { domains?: string[]; purpose?: string } = {}): Promise<WebResult[] | null> {
  const result = await searchWithTrace({ kind: "identity", query, purpose: opts.purpose ?? "Find supporting sources", domains: opts.domains });
  return result.trace.status === "ok" || result.trace.status === "empty" ? result.results : null;
}

export async function collectResearch(input: ResearchInput): Promise<ResearchBundle> {
  const at = Date.now();
  const searches: SearchTrace[] = [];
  const sources: ResearchSource[] = [];
  if (input.social?.text && !input.social.error && publicUrl(input.social.url)) sources.push({
    url: input.social.url!, title: input.social.author ? `Linked social: @${input.social.author}` : "Linked social",
    snippet: input.social.text.slice(0, 1600), via: "linked_social", queryKinds: [],
    mentionsContract: input.social.text.slice(0, 1600).includes(input.mint),
  });
  for (const query of researchPlan(input)) {
    if (Date.now() - at > 60_000) {
      searches.push({ ...query, at: Date.now(), status: "skipped", callId: null, costMicro: null, error: "Research time budget reached", resultUrls: [] });
      continue;
    }
    const { trace, results } = await searchWithTrace(query);
    searches.push(trace);
    for (const r of results.slice(0, 4)) sources.push({
      ...r, via: "search_snippet", queryKinds: [query.kind], mentionsContract: `${r.title} ${r.snippet}`.includes(input.mint),
    });
  }
  return { at, searches, sources: mergeSources(sources) };
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
  const researchPromise = collectResearch({ ...c, social: s.social });
  return {
    evidenceAsOf: now,
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
    research: await researchPromise,
  };
}
