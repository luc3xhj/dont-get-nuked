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
  const add = (id: string, label: string, level: ScreenResult["level"], detail: string) => out.push({ id, label, level, detail });

  // Holders (RugCheck)
  if (!h) add("holders", "Top holders", "unknown", "No holder report yet");
  else {
    const top = h.top10ExPoolPct;
    add(
      "top10",
      "Top-10 concentration",
      top >= t.top10ExPoolVetoPct ? "veto" : top >= t.top10ExPoolWarnPct ? "warn" : "ok",
      `${pct(top)} of supply (excl. curve/pool)`,
    );
    add(
      "insiders",
      "Insider network",
      // What matters is how much supply linked insiders control, not that any linked wallets exist.
      (h.insiderPct ?? 0) >= t.insiderVetoPct ? "veto" : h.insidersDetected > 0 ? "warn" : "ok",
      h.insidersDetected > 0
        ? `${h.insidersDetected} linked wallets still hold ${(h.insiderPct ?? 0).toFixed(1)}% of supply`
        : "None detected by RugCheck",
    );
    if (h.mintAuthority || h.freezeAuthority) add("authority", "Mint/freeze authority", "veto", "Authority not revoked");
    if (h.rugged) add("rugged", "Rugged", "veto", "RugCheck marks this token as rugged");
    // pump.fun coins launch immutable; mutable metadata means it can be rebranded after you buy.
    if (h.metadataMutable) add("metadata", "Mutable metadata", "veto", "Name, image and links can still be changed");
    // `!= null`: reports saved before this field existed don't have it.
    if (h.lpLockedPct != null)
      add("lp", "LP locked/burned", h.lpLockedPct < 90 ? "veto" : "ok", `${h.lpLockedPct.toFixed(0)}% of the graduation pool's LP is locked or burned`);
  }

  if (!f) {
    add("tape", "Trade tape", "unknown", "Not enough trades yet");
    return out;
  }

  // Cohorts from the tape
  if (!f.tapeFromLaunch) add("cohorts", "Launch cohorts", "unknown", "Tape doesn't reach launch; snipers/bundles unknown");
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
      `Tweet by @${so.author} (${so.authorFollowers?.toLocaleString()} followers): ${so.likes} likes, ${so.views ?? "?"} views`,
    );
  else if (so?.kind === "profile" && so.error == null)
    add("socials", "Socials", "ok", `Profile @${so.author}, ${so.authorFollowers?.toLocaleString()} followers`);
  else add("socials", "Socials", "ok", `${links} link${links > 1 ? "s" : ""}${so?.kind === "community" ? " (X community)" : ""}`);

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
