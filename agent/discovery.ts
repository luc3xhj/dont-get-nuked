// Proactive discovery (V2 §05, WP09). Three ways in, one candidate registry:
//   market   — new launches (lifecycle stream) and coins passing the Pulse filters
//   evidence — registered topic searches (Treg free route) that surface narratives and mint addresses
//   wallet   — trades by watched or discovered traders
// Evidence is normalized, deduplicated by content and origin, and kept with its availability time. An
// address in a search snippet is a reference, not an endorsement; a topic without a mint stays an
// unresolved lead. Discovery only prioritizes coins for observation: it never authorizes a trade.
import { createHash } from "node:crypto";
import { db, journal, loadCoin } from "./db";
import { searchWithTrace } from "./research";
import { candidateBoost, coins } from "./state";

export type Ingress = "market" | "evidence" | "wallet";
export type IdentityState = "unresolved" | "chain_validated" | "conflicted";

db.exec(`
  CREATE TABLE IF NOT EXISTS source_watchlist (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    locator TEXT NOT NULL,
    topic TEXT NOT NULL,
    access_route TEXT NOT NULL,
    access_scope TEXT NOT NULL,
    zero_cost TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    cadence_ms INTEGER NOT NULL,
    last_attempt_at INTEGER,
    last_success_at INTEGER,
    health TEXT NOT NULL,
    version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS evidence_observations (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    canonical_url TEXT,
    origin_group TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    title TEXT NOT NULL,
    snippet TEXT NOT NULL,
    asserted_mints TEXT NOT NULL,
    published_at INTEGER,
    received_at INTEGER NOT NULL,
    available_at INTEGER NOT NULL,
    inspection_depth TEXT NOT NULL,
    call_id TEXT,
    narrative_id TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS evidence_dedupe ON evidence_observations (source_id, content_hash);
  CREATE TABLE IF NOT EXISTS narratives (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    version INTEGER NOT NULL,
    first_known_at INTEGER NOT NULL,
    latest_evidence_at INTEGER NOT NULL,
    evidence_count INTEGER NOT NULL,
    independent_origins INTEGER NOT NULL,
    mints TEXT NOT NULL,
    status TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    mint TEXT UNIQUE,
    ingress TEXT NOT NULL,
    identity_state TEXT NOT NULL,
    claim_status TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    available_at INTEGER NOT NULL,
    last_event_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    narrative_ids TEXT NOT NULL,
    evidence_ids TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS candidate_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS candidate_events_c ON candidate_events (candidate_id, at);
`);

/** Registered topic searches (bounded: a few queries, each at most every 20 minutes). */
const DEFAULT_SOURCES = [
  { id: "topic-pumpfun-launches", topic: "pump.fun launches", locator: "pump.fun new token launch solana" },
  { id: "topic-solana-meme-narratives", topic: "Solana meme narratives", locator: "solana memecoin narrative trending this week" },
  { id: "topic-solana-meme-news", topic: "Solana meme news", locator: "solana meme coin news today" },
];
for (const s of DEFAULT_SOURCES)
  db.prepare(
    `INSERT OR IGNORE INTO source_watchlist (id, kind, locator, topic, access_route, access_scope, zero_cost, enabled, cadence_ms, health, version)
     VALUES (?, 'search_query', ?, ?, 'treg.search', 'search result titles and snippets only', 'verified_free', 1, ?, 'new', 1)`,
  ).run(s.id, s.locator, s.topic, 20 * 60_000);

const MINT_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** Origin of a piece of content: the canonical page without tracking parameters (reposts of one page share it). */
export function originOf(url: string | null, title: string): string {
  if (!url) return `title:${hash(title.toLowerCase().trim())}`;
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return `title:${hash(title.toLowerCase().trim())}`;
  }
}

/** Candidate mints in text. Pump.fun mints usually end in "pump"; others need chain validation to count. */
export function extractMints(text: string): string[] {
  return [...new Set((text.match(MINT_RE) ?? []).filter((m) => m.length >= 32))];
}

const identityOf = (mint: string): IdentityState => (coins.has(mint) || loadCoin(mint) ? "chain_validated" : "unresolved");

/** Creates or merges the candidate for a mint; every arrival is a candidate event (provenance kept). */
export function touchCandidate(mint: string, ingress: Ingress, detail: Record<string, unknown>, now = Date.now()) {
  const row = db.prepare("SELECT id, ingress, identity_state FROM candidates WHERE mint = ?").get(mint) as
    | { id: string; ingress: string; identity_state: string }
    | undefined;
  const identity = identityOf(mint);
  let id: string;
  if (!row) {
    id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO candidates (id, mint, ingress, identity_state, claim_status, first_seen_at, available_at, last_event_at, state, narrative_ids, evidence_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]')`,
    ).run(id, mint, JSON.stringify([ingress]), identity, ingress === "evidence" ? "observed_reference" : "observed", now, now, now, identity === "chain_validated" ? "watching" : "unresolved");
  } else {
    id = row.id;
    const routes = new Set(JSON.parse(row.ingress) as Ingress[]);
    routes.add(ingress);
    db.prepare("UPDATE candidates SET ingress = ?, identity_state = ?, last_event_at = ?, state = CASE WHEN ? = 'chain_validated' AND state = 'unresolved' THEN 'watching' ELSE state END WHERE id = ?").run(
      JSON.stringify([...routes]),
      identity,
      now,
      identity,
      id,
    );
  }
  db.prepare("INSERT INTO candidate_events (candidate_id, at, kind, detail) VALUES (?, ?, ?, ?)").run(id, now, ingress, JSON.stringify(detail));
  // Evidence and wallet leads ask the market side for attention; they never bypass any filter or check.
  if (ingress !== "market") candidateBoost.set(mint, Math.max(candidateBoost.get(mint) ?? 0, ingress === "wallet" ? 30 : 20));
  return id;
}

function linkCandidate(mint: string, field: "narrative_ids" | "evidence_ids", value: string) {
  const row = db.prepare(`SELECT ${field} AS v FROM candidates WHERE mint = ?`).get(mint) as { v: string } | undefined;
  if (!row) return;
  const ids = new Set(JSON.parse(row.v) as string[]);
  ids.add(value);
  db.prepare(`UPDATE candidates SET ${field} = ? WHERE mint = ?`).run(JSON.stringify([...ids].slice(-50)), mint);
}

/** Normalizes one search result into evidence, its narrative and any referenced candidates. */
export function ingestSearchResult(
  source: { id: string; topic: string },
  r: { title: string; url: string; snippet: string },
  meta: { callId: string | null; receivedAt: number },
): { evidenceId: string | null; mints: string[] } {
  const content = `${r.url}\n${r.title}\n${r.snippet}`;
  const contentHash = hash(content);
  const mints = extractMints(`${r.title} ${r.snippet} ${r.url}`);
  const evidenceId = crypto.randomUUID();
  const narrativeId = `topic:${source.id}`;
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO evidence_observations (id, source_id, canonical_url, origin_group, content_hash, title, snippet, asserted_mints, published_at, received_at, available_at, inspection_depth, call_id, narrative_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'search_snippet', ?, ?)`,
    )
    .run(evidenceId, source.id, r.url || null, originOf(r.url, r.title), contentHash, r.title, r.snippet, JSON.stringify(mints), meta.receivedAt, meta.receivedAt, meta.callId, narrativeId);
  if (!inserted.changes) return { evidenceId: null, mints: [] }; // the same content seen again: one record
  // Narrative projection: evidence count and independent origins (copies of one page count once).
  const origins = (db.prepare("SELECT COUNT(DISTINCT origin_group) AS n, COUNT(*) AS c FROM evidence_observations WHERE narrative_id = ?").get(narrativeId) as {
    n: number;
    c: number;
  });
  const prior = db.prepare("SELECT mints, version, first_known_at FROM narratives WHERE id = ?").get(narrativeId) as
    | { mints: string; version: number; first_known_at: number }
    | undefined;
  const linked = new Set([...(prior ? (JSON.parse(prior.mints) as string[]) : []), ...mints]);
  db.prepare(
    `INSERT OR REPLACE INTO narratives (id, label, version, first_known_at, latest_evidence_at, evidence_count, independent_origins, mints, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    narrativeId,
    source.topic,
    (prior?.version ?? 0) + 1,
    prior?.first_known_at ?? meta.receivedAt,
    meta.receivedAt,
    origins.c,
    origins.n,
    JSON.stringify([...linked].slice(-100)),
    linked.size ? "linked" : "unresolved",
  );
  for (const m of mints) {
    touchCandidate(m, "evidence", { evidenceId, narrativeId, url: r.url, inspection: "search_snippet" }, meta.receivedAt);
    linkCandidate(m, "evidence_ids", evidenceId);
    linkCandidate(m, "narrative_ids", narrativeId);
  }
  return { evidenceId, mints };
}

let running = false;
/** Runs the most overdue registered topic search (one per tick, well inside the free search budget). */
export async function discoveryTick(now = Date.now()) {
  if (running) return;
  const due = db
    .prepare("SELECT * FROM source_watchlist WHERE enabled = 1 AND kind = 'search_query' AND (last_attempt_at IS NULL OR last_attempt_at + cadence_ms <= ?) ORDER BY COALESCE(last_attempt_at, 0) LIMIT 1")
    .get(now) as { id: string; locator: string; topic: string } | undefined;
  if (!due) return;
  running = true;
  db.prepare("UPDATE source_watchlist SET last_attempt_at = ? WHERE id = ?").run(now, due.id);
  try {
    const { trace, results } = await searchWithTrace({ kind: "narrative", query: due.locator, purpose: `Proactive discovery: ${due.topic}` });
    const receivedAt = Date.now();
    if (trace.status === "error" || trace.status === "skipped") {
      // A failed or unavailable search is missing coverage, never "no discussion".
      db.prepare("UPDATE source_watchlist SET health = ? WHERE id = ?").run(`unavailable: ${trace.error ?? trace.status}`.slice(0, 200), due.id);
      return;
    }
    let fresh = 0;
    let referenced = 0;
    for (const r of results) {
      const out = ingestSearchResult(due, r, { callId: trace.callId, receivedAt });
      if (out.evidenceId) fresh++;
      referenced += out.mints.length;
    }
    db.prepare("UPDATE source_watchlist SET last_success_at = ?, health = ? WHERE id = ?").run(receivedAt, `ok: ${results.length} results, ${fresh} new`, due.id);
    journal("discovery", null, { source: due.id, results: results.length, fresh, referencedMints: referenced, callId: trace.callId });
  } finally {
    running = false;
  }
}

/** Market ingress: a launch on the stream, or a coin passing its Pulse column's filters. */
export function noteMarketCandidate(mint: string, reason: string) {
  const exists = db.prepare("SELECT 1 FROM candidates WHERE mint = ?").get(mint);
  if (!exists) touchCandidate(mint, "market", { reason });
}

export function discoveryReport(now = Date.now()) {
  const sources = db.prepare("SELECT * FROM source_watchlist ORDER BY id").all();
  const narratives = db.prepare("SELECT * FROM narratives ORDER BY latest_evidence_at DESC LIMIT 30").all() as Record<string, unknown>[];
  const candidates = (db.prepare("SELECT * FROM candidates ORDER BY last_event_at DESC LIMIT 100").all() as Record<string, unknown>[]).map((c) => ({
    ...c,
    ingress: JSON.parse(c.ingress as string),
    narrative_ids: JSON.parse(c.narrative_ids as string),
    evidence_ids: JSON.parse(c.evidence_ids as string),
    symbol: coins.get(c.mint as string)?.coin.symbol ?? null,
    hot: coins.get(c.mint as string)?.hot ?? false,
    pulse: coins.get(c.mint as string)?.pulse?.status ?? null,
  }));
  const counts = db.prepare("SELECT state, COUNT(*) AS n FROM candidates GROUP BY state").all();
  const byIngress = db
    .prepare("SELECT kind, COUNT(*) AS n FROM candidate_events WHERE at >= ? GROUP BY kind")
    .all(now - 24 * 3600_000);
  const evidence = db.prepare("SELECT * FROM evidence_observations ORDER BY received_at DESC LIMIT 30").all() as Record<string, unknown>[];
  return {
    sources,
    narratives: narratives.map((n) => ({ ...n, mints: JSON.parse(n.mints as string) })),
    candidates,
    counts,
    ingress24h: byIngress,
    evidence: evidence.map((e) => ({ ...e, asserted_mints: JSON.parse(e.asserted_mints as string) })),
  };
}

/** Narrative evidence for a mint as available now: independent origins and whether identity is chain-validated. */
export function narrativeEvidenceFor(mint: string): { independentOrigins: number; chainValidated: boolean; latestEvidenceAt: number | null } {
  const c = db.prepare("SELECT identity_state FROM candidates WHERE mint = ?").get(mint) as { identity_state: string } | undefined;
  const ev = db
    .prepare("SELECT COUNT(DISTINCT origin_group) AS n, MAX(available_at) AS latest FROM evidence_observations WHERE asserted_mints LIKE ?")
    .get(`%${mint}%`) as { n: number; latest: number | null };
  return { independentOrigins: ev.n, chainValidated: c?.identity_state === "chain_validated", latestEvidenceAt: ev.latest };
}
