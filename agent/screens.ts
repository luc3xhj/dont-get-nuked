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
    add("top10", "Top-10 concentration", top >= t.top10ExPoolVetoPct ? "veto" : top >= t.top10ExPoolWarnPct ? "warn" : "ok", `${pct(top)} of supply (excl. curve/pool)`);
    add("insiders", "Insider network", h.insidersDetected > 0 ? "veto" : "ok", h.insidersDetected > 0 ? `${h.insidersDetected} linked insider wallets` : "None detected by RugCheck");
    if (h.mintAuthority || h.freezeAuthority) add("authority", "Mint/freeze authority", "veto", "Authority not revoked");
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
      b.wallets ? `${b.wallets} same-slot launch wallets still hold ${pct(b.heldPct)} (sold ${(b.soldFraction * 100).toFixed(0)}%)` : "No same-slot launch buys"
    );
    const sn = f.cohorts.snipers;
    add("snipers", "Sniper supply", sn.heldPct >= t.sniperHeldWarnPct ? "warn" : "ok", `${sn.wallets} snipers hold ${pct(sn.heldPct)} (sold ${(sn.soldFraction * 100).toFixed(0)}%)`);
  }
  const d = f.cohorts.dev;
  const devSellingNow = d.sellSol60s > 0.05;
  add(
    "dev",
    "Developer",
    devSellingNow ? "warn" : d.heldPct >= t.devHeldWarnPct ? "warn" : "ok",
    devSellingNow ? `Dev sold ${d.sellSol60s.toFixed(2)} SOL in the last minute` : `Dev holds ${pct(d.heldPct)} (sold ${(d.soldFraction * 100).toFixed(0)}%)`
  );

  // A market cap the pool can't back is a fake price: you can't sell into it.
  if (f.liquidityUsd !== null && s.quote) {
    const ratio = s.quote.mcapUsd ? f.liquidityUsd / s.quote.mcapUsd : 0;
    add(
      "liquidity",
      "Pool liquidity",
      f.liquidityUsd < 5_000 || ratio < 0.02 ? "veto" : f.liquidityUsd < 10_000 || ratio < 0.05 ? "warn" : "ok",
      `$${Math.round(f.liquidityUsd).toLocaleString()} backing a $${Math.round(s.quote.mcapUsd).toLocaleString()} market cap (${(ratio * 100).toFixed(1)}%)`
    );
  }

  // Flow quality
  const rt = f.flow5m.roundTripShare;
  add("wash", "Wash-like flow", rt >= t.washShareWarn ? "warn" : "ok", `${(rt * 100).toFixed(0)}% of 5m volume from wallets that bought and sold`);

  const rb = f.repeatBuyShare;
  if (f.flow5m.buys >= 10)
    add("bots", "Bump bots", rb >= 0.4 ? "warn" : "ok", `${(rb * 100).toFixed(0)}% of 5m buys repeat the same wallet and size`);

  // Socials
  const links = [s.coin.socials.twitter, s.coin.socials.telegram, s.coin.socials.website].filter(Boolean).length;
  if (!links) add("socials", "Socials", "warn", "No social links");
  else if (so?.kind === "tweet" && so.error == null)
    add("socials", "Socials", "ok", `Tweet by @${so.author} (${so.authorFollowers?.toLocaleString()} followers): ${so.likes} likes, ${so.views ?? "?"} views`);
  else if (so?.kind === "profile" && so.error == null)
    add("socials", "Socials", "ok", `Profile @${so.author}, ${so.authorFollowers?.toLocaleString()} followers`);
  else add("socials", "Socials", "ok", `${links} link${links > 1 ? "s" : ""}${so?.kind === "community" ? " (X community)" : ""}`);

  return out;
}

export const verdict = (screens: ScreenResult[]) =>
  screens.some((x) => x.level === "veto") ? "veto" : screens.some((x) => x.level === "warn") ? "warn" : screens.some((x) => x.level === "unknown") ? "unknown" : "ok";
