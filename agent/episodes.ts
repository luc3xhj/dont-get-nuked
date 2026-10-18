// Setups as observable sequences (roadmap B10). An episode starts when a setup's structure forms
// (armed), may fire once its trigger confirms, and ends when the structure breaks (invalidated, or
// completed after a fire) or when it stays armed too long without firing (expired). Fires from an
// expired or invalidated episode are suppressed for a cooldown, so a setup that flickers on and off
// doesn't re-signal as if it were new.
import { CONFIG } from "./config";
import { db, journal } from "./db";
import type { SetupEval, SetupId } from "./setups";

export type EpisodeEnd = "completed" | "expired" | "invalidated";
export type Episode = {
  id: string;
  mint: string;
  setup: SetupId;
  armedAt: number;
  firedAt: number | null;
  endedAt: number | null;
  end: EpisodeEnd | null;
};
export type EpisodeView = { id: string; state: "armed" | "fired" | "cooldown"; armedAt: number; firedAt: number | null; cooldownUntil?: number };

db.exec("CREATE TABLE IF NOT EXISTS setup_episodes (id TEXT PRIMARY KEY, mint TEXT NOT NULL, setup TEXT NOT NULL, armed_at INTEGER NOT NULL, data TEXT NOT NULL)");
const save = (e: Episode) =>
  db.prepare("INSERT OR REPLACE INTO setup_episodes (id, mint, setup, armed_at, data) VALUES (?, ?, ?, ?, ?)").run(e.id, e.mint, e.setup, e.armedAt, JSON.stringify(e));

/** Latest episode per `${mint}:${setup}` (open or recently ended). */
const latest = new Map<string, Episode>();

export function restoreEpisodes(now = Date.now()) {
  const rows = db.prepare("SELECT data FROM setup_episodes WHERE armed_at > ? ORDER BY armed_at").all(now - 24 * 3600_000) as { data: string }[];
  for (const r of rows) {
    const e = JSON.parse(r.data) as Episode;
    latest.set(`${e.mint}:${e.setup}`, e);
  }
}

function close(e: Episode, end: EpisodeEnd, now: number) {
  e.end = end;
  e.endedAt = now;
  save(e);
  journal("episode_end", e.mint, { id: e.id, setup: e.setup, end, armedAt: e.armedAt, firedAt: e.firedAt, durationMin: (now - e.armedAt) / 60_000 });
}

/**
 * Advances every episode for this coin and returns the setups allowed to fire this tick.
 * Each evaluation gets `episode` attached for the UI.
 */
export function trackEpisodes(mint: string, evals: SetupEval[], now = Date.now()): SetupEval[] {
  const { maxArmedMs, cooldownMs } = CONFIG.setupEpisode;
  const present = new Set(evals.map((x) => x.setup));
  // Structure broke: the episode ends.
  for (const e of latest.values())
    if (e.mint === mint && !e.end && !present.has(e.setup)) close(e, e.firedAt ? "completed" : "invalidated", now);

  const fires: SetupEval[] = [];
  for (const ev of evals) {
    const key = `${mint}:${ev.setup}`;
    let e = latest.get(key);
    if (e && !e.end && !e.firedAt && now - e.armedAt > maxArmedMs) close(e, "expired", now);
    if (!e || e.end) {
      const failedRecently = e && e.end !== "completed" && now - (e.endedAt ?? 0) < cooldownMs;
      if (failedRecently) {
        ev.episode = { id: e!.id, state: "cooldown", armedAt: e!.armedAt, firedAt: e!.firedAt, cooldownUntil: (e!.endedAt ?? 0) + cooldownMs };
        continue;
      }
      e = { id: crypto.randomUUID(), mint, setup: ev.setup, armedAt: now, firedAt: null, endedAt: null, end: null };
      latest.set(key, e);
      save(e);
      journal("episode_armed", mint, { id: e.id, setup: ev.setup });
    }
    if (ev.status === "fire") {
      if (!e.firedAt) {
        e.firedAt = now;
        save(e);
      }
      fires.push(ev);
    }
    ev.episode = { id: e.id, state: e.firedAt ? "fired" : "armed", armedAt: e.armedAt, firedAt: e.firedAt };
  }
  return fires;
}
