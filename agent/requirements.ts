// Evidence each setup cannot do without (roadmap A1). A missing or stale essential defers the entry:
// "we couldn't check" is never treated as "we checked and it was fine".
import { CONFIG } from "./config";
import type { EssentialCheck } from "./decision";
import type { SetupId } from "./setups";

const FAST = new Set<SetupId>(["early_momentum", "first_shallow_pullback", "migration_event", "breakout_continuation"]);
import type { CoinState } from "./state";

const age = (at: number, now: number) => `${Math.round((now - at) / 60_000)}m old`;

/**
 * Narrative evidence: content we could actually read (a fresh tweet or profile), or a fresh analyst
 * verdict that identified a narrative. A bare link, an unreadable X community or a copycat doesn't count.
 */
export function narrativeSupport(s: CoinState, now = Date.now()): { ok: boolean; detail: string } {
  const a = s.analysis;
  if (a && a.expiresAt > now && a.verdict !== "reject" && !a.copycat && !["none", "unclear", "copycat"].includes(a.narrativeType))
    return { ok: true, detail: `analyst: ${a.narrativeType} narrative (${age(a.at, now)})` };
  const so = s.social;
  if (so && so.error == null && (so.kind === "tweet" || so.kind === "profile")) {
    if (now - so.at > CONFIG.decision.socialMaxAgeMs) return { ok: false, detail: `${so.kind} read ${age(so.at, now)} (stale)` };
    return { ok: true, detail: `readable ${so.kind} by @${so.author}` };
  }
  const links = [s.coin.socials.twitter, s.coin.socials.telegram, s.coin.socials.website].filter(Boolean).length;
  if (!links) return { ok: false, detail: "no links" };
  return { ok: false, detail: so?.kind === "community" ? "X community only (not readable for free)" : `${links} link(s), content not readable` };
}

export function essentialsFor(s: CoinState, setup: SetupId, now = Date.now()): EssentialCheck[] {
  const D = CONFIG.decision;
  const f = s.features;
  const out: EssentialCheck[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string) => out.push({ id, label, ok, detail });

  const h = s.holders;
  add(
    "holders",
    "Holder report",
    !!h && now - h.at <= D.holderReportMaxAgeMs,
    !h ? "not fetched" : now - h.at <= D.holderReportMaxAgeMs ? age(h.at, now) : `stale (${age(h.at, now)})`,
  );
  const fu = s.funding;
  const coverage = fu?.coverage ?? 1;
  const fundingFresh = !!fu && now - fu.at <= D.fundingMaxAgeMs;
  // Fast strategies decide within seconds; top-holder funding is optional for them (a found cluster still
  // vetoes through the risk screens). Every other strategy requires it.
  if (!FAST.has(setup))
    add(
    "funding",
    "Top-holder funding",
    fundingFresh && coverage >= D.minFundingCoverage,
    !fu
      ? "not checked yet"
      : !fundingFresh
        ? `stale (${age(fu.at, now)})`
        : coverage < D.minFundingCoverage
          ? `coverage incomplete: ${(coverage * 100).toFixed(0)}% of top-holder supply checked${
              fu.failed?.length ? `, ${fu.failed.length} lookup${fu.failed.length > 1 ? "s" : ""} failed; retry scheduled` : ""
            }`
          : `${fu.checked}/${fu.requested ?? fu.checked} wallets, ${(coverage * 100).toFixed(0)}% coverage, ${age(fu.at, now)}`,
  );
  if (setup === "new_dump" || setup === "dev_base" || setup === "early_momentum" || setup === "first_shallow_pullback")
    add(
      "cohorts",
      "Launch cohorts",
      !!f?.cohortsReliable,
      f?.cohortsReliable ? "complete tape" : f?.tapeFromLaunch ? `${f.tapeGaps} tape gaps` : "tape doesn't reach launch",
    );
  if (setup === "dev_base") {
    const dv = s.dev;
    add("dev", "Developer history", !!dv && now - dv.at <= D.devMaxAgeMs, !dv ? "not looked up" : now - dv.at <= D.devMaxAgeMs ? age(dv.at, now) : `stale (${age(dv.at, now)})`);
  }
  if (setup === "migrated_base" || setup === "migration_event") {
    const at = s.coin.migratedAt;
    add("migration", "Migration time", at != null, at != null ? `${Math.round((now - at) / 60_000)}m ago (${s.coin.migratedAtSource ?? "?"})` : "unknown");
  }
  if (setup === "stretch_pullback") {
    const n = narrativeSupport(s, now);
    add("narrative", "Narrative", n.ok, n.detail);
  }
  return out;
}
