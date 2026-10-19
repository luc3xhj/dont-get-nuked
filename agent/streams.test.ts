import assert from "node:assert/strict";
import { test } from "node:test";

test("lifecycle stream: free subscriptions only, create and migration parsed with receipt time", async () => {
  process.env.AGENT_DB = ":memory:";
  const { subscribeMessage, handleMessage } = await import("./streams");
  const { coins } = await import("./state");
  const { db } = await import("./db");
  const { capabilityReport } = await import("./capabilities");

  assert.equal(subscribeMessage("subscribeNewToken"), JSON.stringify({ method: "subscribeNewToken" }));
  assert.throws(() => subscribeMessage("subscribeTokenTrade"), /not a verified free capability/);
  assert.throws(() => subscribeMessage("subscribeAccountTrade"));

  const mint = "S".repeat(43) + "p";
  const t0 = 1_800_000_000_000;
  assert.equal(handleMessage(JSON.stringify({ txType: "create", mint, name: "Stream", symbol: "STR", traderPublicKey: "creator", bondingCurveKey: "curve", pool: "pump" }), t0), "create");
  const s = coins.get(mint)!;
  assert.equal(s.coin.launchObservedAt, t0, "receipt time is recorded");
  assert.equal(s.coin.stage, "curve");

  assert.equal(handleMessage(JSON.stringify({ txType: "migrate", mint, pool: "P".repeat(44) }), t0 + 60_000), "migration");
  assert.equal(coins.get(mint)!.coin.stage, "migrated");
  assert.equal(coins.get(mint)!.coin.migratedAt, t0 + 60_000);
  assert.equal(coins.get(mint)!.coin.migratedAtSource, "migration_stream");
  // A duplicate delivery doesn't create a second lifecycle event.
  handleMessage(JSON.stringify({ txType: "migrate", mint }), t0 + 70_000);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM lifecycle_events WHERE mint = ? AND kind = 'migration'").get(mint) as { n: number }).n, 1);
  assert.equal(coins.get(mint)!.coin.migratedAt, t0 + 60_000, "first observation kept");

  assert.equal(handleMessage("{not json"), "ignored");
  assert.equal(handleMessage(JSON.stringify({ message: "Successfully subscribed" })), "ignored");

  const caps = capabilityReport();
  assert.equal(caps.find((c) => c.id === "pumpportal.token_trade")!.state, "unsupported");
  assert.equal(caps.find((c) => c.id === "jupiter.quote")!.state, "unsupported");
  assert.equal(caps.find((c) => c.id === "pumpportal.migration")!.stage, "live_checked", "first live migration promotes the stage");
});
