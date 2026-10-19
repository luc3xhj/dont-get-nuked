import assert from "node:assert/strict";
import { test } from "node:test";

test("discovery: dedupe, independent origins, unresolved identity, merged ingress", async () => {
  process.env.AGENT_DB = ":memory:";
  const { db, saveCoin } = await import("./db");
  const { ingestSearchResult, touchCandidate, originOf, extractMints } = await import("./discovery");
  const { candidateBoost } = await import("./state");
  const known = "K".repeat(40) + "pump";
  const unknown = "U".repeat(40) + "pump";
  saveCoin({ mint: known, symbol: "KNW", name: "Known", creator: "c", curve: "x", pool: null, stage: "curve", createdAt: 1, socials: { twitter: null, website: null, telegram: null }, replies: 0, mcapUsd: 1, athMcapUsd: null, curveProgress: 0, lastTradeAt: 1, firstSeen: 1, updatedAt: 1 });

  const src = { id: "topic-test", topic: "Test topic" };
  const r = { title: "New launch", url: "https://news.example.com/a?utm=1", snippet: `Contract ${known} and ${unknown}` };
  const first = ingestSearchResult(src, r, { callId: "call-1", receivedAt: 1_000 });
  assert.deepEqual(first.mints.sort(), [known, unknown].sort());
  const dup = ingestSearchResult(src, r, { callId: "call-2", receivedAt: 2_000 });
  assert.equal(dup.evidenceId, null, "the same content is one record");
  // A repost of the same page with different text is new evidence but not a new origin.
  ingestSearchResult(src, { ...r, url: "https://www.news.example.com/a/", snippet: "updated text" }, { callId: "call-3", receivedAt: 3_000 });
  const n = db.prepare("SELECT evidence_count, independent_origins, status FROM narratives WHERE id = 'topic:topic-test'").get() as Record<string, number | string>;
  assert.equal(n.evidence_count, 2);
  assert.equal(n.independent_origins, 1, "copies of one page are one origin");
  assert.equal(originOf("https://www.x.com/p/", "t"), "x.com/p");

  const cands = db.prepare("SELECT mint, identity_state, state, ingress FROM candidates").all() as Record<string, string>[];
  assert.equal(cands.find((c) => c.mint === known)!.identity_state, "chain_validated");
  assert.equal(cands.find((c) => c.mint === unknown)!.identity_state, "unresolved", "an address in a snippet is a reference, not a validated token");

  touchCandidate(known, "wallet", { wallet: "w" }, 4_000);
  const merged = db.prepare("SELECT ingress FROM candidates WHERE mint = ?").get(known) as { ingress: string };
  assert.deepEqual(JSON.parse(merged.ingress).sort(), ["evidence", "wallet"], "one candidate, several routes");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE mint = ?").get(known) as { n: number }).n, 1);
  assert.equal(candidateBoost.get(known), 30, "wallet leads request attention; they admit nothing");
  assert.deepEqual(extractMints("no address here"), []);
});
