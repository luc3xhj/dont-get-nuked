// Risk screens: explainable vetoes and warnings run before any setup is considered.
import { CONFIG } from "./config";
import type { CoinState } from "./state";
import type { ScreenResult } from "./types";

const pct = (v: number) => `${v.toFixed(1)}%`;

export function runScreens(s: CoinState): ScreenResult[] {
  const f = s.features;
  const h = s.holders;
  const so = s.social;
  const t = CONFIG.screens;
  const out: ScreenResult[] = [];
  const add = (id: string, label: string, level: ScreenResult["level"], detail: string, observedAt: number | null = null) =>
    out.push({ id, label, level, detail, observedAt, status: level === "ok" ? "verified" : level === "unknown" ? "unknown" : "adverse" });

  // Holders (RugCheck)
  if (!h) add("holders", "Top holders", "unknown", "No holder report yet");
  else {
    const top = h.top10ExPoolPct;
    add(
      "top10",
      "Top-10 concentration",
      top >= t.top10ExPoolVetoPct ? "veto" : top >= t.top10ExPoolWarnPct ? "warn" : "ok",
      `${pct(top)} of supply (excl. curve/pool)`,
      h.at,
    );
    add(
      "insiders",
      "Insider network",
      // What matters is how much supply linked insiders control, not that any linked wallets exist.
      (h.insiderPct ?? 0) >= t.insiderVetoPct ? "veto" : h.insidersDetected > 0 ? "warn" : "ok",
      h.insidersDetected > 0
        ? `${h.insidersDetected} linked wallets still hold ${(h.insiderPct ?? 0).toFixed(1)}% of supply`
        : "None detected by RugCheck",
      h.at,
    );
    if (h.mintAuthority || h.freezeAuthority) add("authority", "Mint/freeze authority", "veto", "Authority not revoked", h.at);
    if (h.rugged) add("rugged", "Rugged", "veto", "RugCheck marks this token as rugged", h.at);
    // pump.fun coins launch immutable; mutable metadata means it can be rebranded after you buy.
    if (h.metadataMutable) add("metadata", "Mutable metadata", "veto", "Name, image and links can still be changed", h.at);
    // `!= null`: reports saved before this field existed don't have it.
    if (h.lpLockedPct != null)
      add("lp", "LP locked/burned", h.lpLockedPct < 90 ? "veto" : "ok", `${h.lpLockedPct.toFixed(0)}% of the graduation pool's LP is locked or burned`, h.at);
  }

  if (!f) {
    add("tape", "Trade tape", "unknown", "Not enough trades yet");
    return out;
  }

  // Cohorts from the tape. Without the whole launch history (or with gaps since), holdings would look
  // smaller than they are, so they're reported unknown rather than low.
  if (!f.tapeFromLaunch) add("cohorts", "Launch cohorts", "unknown", "Tape doesn't reach launch; snipers/bundles unknown");
  else if (!f.cohortsReliable)
    add("cohorts", "Launch cohorts", "unknown", `${f.tapeGaps} gap${f.tapeGaps > 1 ? "s" : ""} in the tape since launch; holdings may be understated`);
  else {
    const b = f.cohorts.bundles;
    add(
      "bundles",
      "Bundled supply",
      b.heldPct >= t.bundleHeldVetoPct ? "veto" : b.heldPct >= t.bundleHeldWarnPct ? "warn" : "ok",
      b.wallets
        ? `${b.wallets} same-slot launch wallets still hold ${pct(b.heldPct)} (sold ${(b.soldFraction * 100).toFixed(0)}%)`
        : "No same-slot launch buys",
    );
    const sn = f.cohorts.snipers;
    add(
      "snipers",
      "Sniper supply",
      sn.heldPct >= t.sniperHeldWarnPct ? "warn" : "ok",
      `${sn.wallets} snipers hold ${pct(sn.heldPct)} (sold ${(sn.soldFraction * 100).toFixed(0)}%)`,
    );
  }
  const d = f.cohorts.dev;
  const devSellingNow = d.sellSol60s > 0.05;
  add(
    "dev",
    "Developer",
    devSellingNow ? "warn" : d.heldPct >= t.devHeldWarnPct ? "warn" : "ok",
    devSellingNow
      ? `Dev sold ${d.sellSol60s.toFixed(2)} SOL in the last minute`
      : `Dev holds ${pct(d.heldPct)} (sold ${(d.soldFraction * 100).toFixed(0)}%)`,
  );

  // A market cap the pool can't back is a fake price: you can't sell into it.
  if (f.liquidityUsd !== null && s.quote) {
    const ratio = s.quote.mcapUsd ? f.liquidityUsd / s.quote.mcapUsd : 0;
    add(
      "liquidity",
      "Pool liquidity",
      f.liquidityUsd < 5_000 || ratio < 0.02 ? "veto" : f.liquidityUsd < 10_000 || ratio < 0.05 ? "warn" : "ok",
      `$${Math.round(f.liquidityUsd).toLocaleString()} backing a $${Math.round(s.quote.mcapUsd).toLocaleString()} market cap (${(ratio * 100).toFixed(1)}%)`,
    );
  }

  // Top-holder wallets: fresh wallets and shared funders = one entity posing as many holders.
  const fu = s.funding;
  if (fu && fu.checked) {
    add(
      "fresh",
      "Fresh wallets",
      fu.fresh >= 3 || fu.freshPct >= t.freshWalletPct ? "warn" : "ok",
      `${fu.fresh} of ${fu.checked} top holders are under a day old (${fu.freshPct.toFixed(1)}% of supply)`,
      fu.at,
    );
    const top = fu.clusters[0];
    add(
      "funding",
      "Funding cluster",
      fu.topClusterPct >= t.fundingClusterVetoPct ? "veto" : fu.topClusterPct >= t.fundingClusterWarnPct ? "warn" : "ok",
      top
        ? `${top.wallets.length} top holders funded by ${top.funder.slice(0, 4)}…${top.funder.slice(-4)} hold ${top.pct.toFixed(1)}%`
        : `No shared funders among ${fu.checked} top holders${fu.exchangeFunded ? ` (${fu.exchangeFunded} exchange-funded)` : ""}${
            fu.unresolvedPct != null && fu.unresolvedPct > 0 ? ` · ${fu.unresolvedPct.toFixed(1)}% of supply with no traceable SOL transfer` : ""
          }`,
      fu.at,
    );
  } else if (s.holders) add("funding", "Funding cluster", "unknown", "Wallet checks pending");

  // Developer history (pump.fun): serial launchers and creators whose coins all died.
  const dv = s.dev;
  if (!dv) add("devhistory", "Developer history", "unknown", "Not looked up yet");
  else if (dv.launches24h >= t.serialLaunches24h)
    add("devhistory", "Developer history", "warn", `Serial launcher: ${dv.launches24h} launches in 24h (${dv.successes} of ${dv.launches}${dv.capped ? "+" : ""} ever succeeded)`, dv.at);
  else if (dv.launches >= 5 && dv.successes === 0)
    add("devhistory", "Developer history", "warn", `All ${dv.launches}${dv.capped ? "+" : ""} prior launches failed (best ATH $${Math.round(dv.bestAthUsd / 1000)}k)`);
  else
    add(
      "devhistory",
      "Developer history",
      "ok",
      dv.launches ? `${dv.launches}${dv.capped ? "+" : ""} prior launches · ${dv.graduated} graduated · best ATH $${Math.round(dv.bestAthUsd / 1000)}k` : "First launch"
    );

  // Volume quality: fake volume (wash trading, bump bots) makes a coin look hot without real demand.
  const v = f.volume;
  if (v.washScore === null) add("volume", "Volume quality", "unknown", `Only ${v.trades} trades in 5m`);
  else {
    const concentrated = v.top10VolShare >= 0.6;
    add(
      "volume",
      "Volume quality",
      v.washScore >= t.washVeto || (concentrated && v.twoSidedShare >= 0.5) ? "veto" : v.washScore >= t.washWarn || concentrated ? "warn" : "ok",
      `wash score ${(v.washScore * 100).toFixed(0)} · top-10 wallets ${(v.top10VolShare * 100).toFixed(0)}% of volume · ${(v.twoSidedShare * 100).toFixed(0)}% two-sided · ${v.tradesPerTrader.toFixed(1)} trades/wallet · avg ${v.avgTradeSol.toFixed(3)}◎`,
    );
  }

  // Cabal fast-fill: the curve filled within ~30 minutes, especially when a few wallets paid for it.
  if (f.curveFillPerMin !== null && (s.coin.curveProgress ?? 0) >= 0.6 && f.ageMin <= 30) {
    const conc = f.launchBuyConcentration;
    add(
      "fastfill",
      "Fast curve fill",
      conc !== null && conc >= 0.5 ? "veto" : "warn",
      `${Math.round((s.coin.curveProgress ?? 0) * 100)}% filled in ${f.ageMin.toFixed(0)}m${conc !== null ? ` · top-10 buyers paid ${(conc * 100).toFixed(0)}%` : ""}`,
    );
  }

  // KOL-call awareness: a big account explicitly shilling this contract is a chase risk — in the
  // largest study, calls from 200k+ follower accounts had the worst returns afterwards (playbook §4).
  if (so?.kind === "tweet" && so.mentionsMint && (so.authorFollowers ?? 0) >= t.bigAccountFollowers) {
    const ageH = so.postedAt ? (Date.now() - so.postedAt) / 3_600_000 : null;
    if (ageH === null || ageH <= 24)
      add(
        "kol",
        "Big-account call",
        "warn",
        `@${so.author} (${(so.authorFollowers ?? 0).toLocaleString()} followers) promoted this contract${ageH !== null ? ` ${ageH.toFixed(1)}h ago` : ""}`,
      );
  }

  // Socials
  const links = [s.coin.socials.twitter, s.coin.socials.telegram, s.coin.socials.website].filter(Boolean).length;
  if (!links) add("socials", "Socials", "warn", "No social links");
  else if (so?.kind === "tweet" && so.error == null)
    add(
      "socials",
      "Socials",
      "ok",
      `Tweet by @${so.author} (${so.authorFollowers?.toLocaleString()} followers): ${so.likes} likes, ${so.views ?? "?"} views · ${so.mentionsMint ? "names this contract" : "doesn't name this contract"}`,
      so.at,
    );
  else if (so?.kind === "profile" && so.error == null)
    add("socials", "Socials", "ok", `Profile @${so.author}, ${so.authorFollowers?.toLocaleString()} followers · ${so.mentionsMint ? "bio names this contract" : "bio doesn't name this contract"}`, so.at);
  // A link we couldn't read proves nothing either way.
  else
    add(
      "socials",
      "Socials",
      "unknown",
      `${links} link${links > 1 ? "s" : ""} present, content not readable${so?.kind === "community" ? " (X communities can't be read for free)" : so?.error ? ` (${so.error})` : ""}`,
      so?.at ?? null,
    );

  // Old reports don't count as evidence: a stale "ok" becomes unknown, a stale problem stays visible.
  const now = Date.now();
  const d2 = CONFIG.decision;
  const maxAge: Record<string, number> = {
    top10: d2.holderReportMaxAgeMs,
    insiders: d2.holderReportMaxAgeMs,
    authority: d2.holderReportMaxAgeMs,
    rugged: d2.holderReportMaxAgeMs,
    metadata: d2.holderReportMaxAgeMs,
    lp: d2.holderReportMaxAgeMs,
    fresh: d2.fundingMaxAgeMs,
    funding: d2.fundingMaxAgeMs,
    devhistory: d2.devMaxAgeMs,
    socials: d2.socialMaxAgeMs,
  };
  for (const r of out) {
    const limit = maxAge[r.id];
    if (!limit || !r.observedAt || now - r.observedAt <= limit) continue;
    const mins = Math.round((now - r.observedAt) / 60_000);
    r.status = "stale";
    r.detail = `${r.detail} · stale (${mins}m old)`;
    if (r.level === "ok") r.level = "unknown";
  }
  return out;
}

export const verdict = (screens: ScreenResult[]) =>
  screens.some((x) => x.level === "veto")
    ? "veto"
    : screens.some((x) => x.level === "warn")
      ? "warn"
      : screens.some((x) => x.level === "unknown")
        ? "unknown"
        : "ok";
