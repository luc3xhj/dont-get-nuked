import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCodex } from "./codex";

async function fixture(code: string, run: (bin: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "dgn-codex-test-"));
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!${process.execPath}\n${code}`, { mode: 0o700 });
  try { await run(bin); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const options = { schema: { type: "object" }, instructions: "Use evidence only.", timeoutMs: 5_000 };
const writeResult = `const fs = require('node:fs'); const args = process.argv; const file = args[args.indexOf('--output-last-message') + 1];`;

test("reads structured output and usage after a recovered stream error; keeps secrets out of child", async () => {
  const previous = process.env.TREG_TOKEN;
  process.env.TREG_TOKEN = "test-secret";
  try {
    await fixture(`${writeResult}
      if (process.env.TREG_TOKEN) process.exit(9);
      if (!args.includes('read-only') || !args.includes('--ignore-user-config')) process.exit(8);
      process.stdin.resume(); process.stdin.on('end', () => {
        fs.writeFileSync(file, JSON.stringify({ verdict: 'neutral' }));
        console.log(JSON.stringify({ type: 'error', message: 'Reconnecting...' }));
        console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12 } }));
      });`, async (bin) => {
        const result = await runCodex("untrusted evidence", { ...options, bin });
        assert.equal(result.structured.verdict, "neutral");
        assert.deepEqual(result.raw.usage, { input_tokens: 12 });
      });
  } finally {
    if (previous === undefined) delete process.env.TREG_TOKEN;
    else process.env.TREG_TOKEN = previous;
  }
});

test("surfaces an expired login instead of producing a verdict", async () => {
  await fixture(`console.log(JSON.stringify({type:'turn.failed',error:{message:'401 unauthorized; login required'}})); process.exit(1);`, async (bin) => {
    await assert.rejects(runCodex("evidence", { ...options, bin }), { code: "not-logged-in" });
  });
});

test("rejects missing or malformed structured output", async () => {
  await fixture(`${writeResult} fs.writeFileSync(file, 'not json');`, async (bin) => {
    await assert.rejects(runCodex("evidence", { ...options, bin }), /no valid structured result/);
  });
});

test("terminates a stalled process at the timeout", async () => {
  await fixture("setInterval(() => {}, 1000);", async (bin) => {
    const started = Date.now();
    await assert.rejects(runCodex("evidence", { ...options, bin, timeoutMs: 100 }), /timed out/);
    assert.ok(Date.now() - started < 4_000);
  });
});

test("rejects a missing executable without waiting for the timeout", async () => {
  await assert.rejects(runCodex("evidence", { ...options, bin: "/does-not-exist/dgn-codex" }), { code: "ENOENT" });
});
