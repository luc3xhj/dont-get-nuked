import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSources, narrativeTerms, publicUrl, researchPlan } from "./research-plan";
import type { ResearchSource } from "../src/lib/research-types";

const mint = "A".repeat(32);
const coin = { mint, name: "Storm Cat", symbol: "CAT", socials: { twitter: "https://x.com/cat/status/123", website: "https://cat.example/", telegram: "https://t.me/cat" } };

test("research combines identity, social links and narrative within five searches", () => {
  const plan = researchPlan({ ...coin, social: { url: coin.socials.twitter, author: "cat", error: null, text: "A storm cat leads a new community of weather watchers" } });
  assert.deepEqual(plan.map((q) => q.kind), ["contract", "identity", "social", "website", "narrative"]);
  assert.equal(plan[0].query, `"${mint}"`);
  assert.match(plan[1].query, /Storm Cat.*CAT/);
  assert.match(plan[2].query, /site:x.com\/cat/);
  assert.deepEqual(plan[2].domains, ["x.com", "twitter.com"]);
  assert.match(plan[4].query, /weather watchers/);
  assert.ok(plan.every((q) => q.query.length < 250));
});

test("narrative queries retain the event beyond an introductory sentence", () => {
  const query = narrativeTerms("This might be the most French thing I've ever seen. A guy was spotted in the Paris riots holding a baguette like he's ready to fight. You literally can't make this up. 1.3 mill views and going up FAST");
  assert.match(query, /Paris riots.*baguette/);
  assert.doesNotMatch(query, /views|FAST|might/);
});

test("missing links still research identity and narrative; Telegram is a usable lead", () => {
  const noLinks = researchPlan({ ...coin, socials: { twitter: null, website: null, telegram: null } });
  assert.deepEqual(noLinks.map((q) => q.kind), ["contract", "identity", "narrative"]);
  const telegram = researchPlan({ ...coin, socials: { twitter: null, website: null, telegram: "https://t.me/cat" } });
  assert.match(telegram.find((q) => q.kind === "social")!.query, /t.me\/cat/);
});

test("research leads do not forward credentials or local URLs", () => {
  for (const url of ["file:///tmp/example", "http://127.0.0.1/a", "https://user:pass@example.com", "https://example.com/?token=private"]) assert.equal(publicUrl(url), null);
  assert.equal(publicUrl("https://example.com/post?utm_source=tracking#section"), "https://example.com/post");
});

test("deduplication retains query provenance and the text supporting exact-contract labels", () => {
  const s: ResearchSource = { url: "https://example.com/post", title: mint, snippet: "A contract claim", via: "search_snippet", queryKinds: ["contract"], mentionsContract: true };
  const result = mergeSources([s, { ...s, title: "Social", snippet: "Just a meme", via: "linked_social", queryKinds: ["social"], mentionsContract: false }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, mint);
  assert.equal(result[0].via, "search_snippet");
  assert.deepEqual(result[0].queryKinds, ["contract", "social"]);
});
