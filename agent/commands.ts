// Operator commands with an idempotent log. A retry with the same commandId and the same content
// returns the recorded result without acting again; the same id with different content is a
// conflict (HTTP 409) and changes nothing. Every result carries reason codes and the account state
// revision it produced.
import { createHash } from "node:crypto";
import { db } from "./db";
import {
  cancelPendingBuys,
  pauseEntries,
  requestExit,
  requestFlatten,
  resetRiskAnchors,
  reallocate,
  resumeEntries,
  SLEEVES,
  type ControlResult,
} from "./portfolio";
import type { SleeveId } from "./setups";

export const COMMAND_TYPES = ["pause_entries", "resume_entries", "cancel_pending_buys", "request_exit", "request_flatten", "reset_risk_anchors", "reallocate_cash"] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

db.exec(`
  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT NOT NULL,
    at INTEGER NOT NULL,
    revision INTEGER NOT NULL
  );
`);

const stable = (v: unknown): string =>
  v && typeof v === "object" && !Array.isArray(v)
    ? `{${Object.keys(v as object)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
        .join(",")}}`
    : JSON.stringify(v ?? null);
const hashOf = (type: string, payload: unknown) => createHash("sha256").update(`${type}|${stable(payload)}`).digest("hex");

/** Monotonic revision of operator-visible state, advanced by every applied command. */
export const stateRevision = () => (db.prepare("SELECT COALESCE(MAX(revision), 0) AS r FROM commands").get() as { r: number }).r;

export type CommandResponse = { httpStatus: 200 | 202 | 400 | 409 | 422; body: Record<string, unknown> };

export function executeCommand(input: Record<string, unknown>): CommandResponse {
  const id = typeof input.commandId === "string" ? input.commandId.trim() : "";
  const type = input.commandType as CommandType;
  const payload = (input.payload ?? {}) as Record<string, unknown>;
  if (!id || id.length > 100) return { httpStatus: 422, body: { error: "commandId is required (≤ 100 characters)", reasonCodes: ["invalid_command_id"] } };
  if (!COMMAND_TYPES.includes(type)) return { httpStatus: 422, body: { error: `Unknown commandType`, reasonCodes: ["unknown_command_type"], allowed: COMMAND_TYPES } };
  const hash = hashOf(type, payload);

  const prior = db.prepare("SELECT type, payload_hash, status, result, revision FROM commands WHERE id = ?").get(id) as
    | { type: string; payload_hash: string; status: string; result: string; revision: number }
    | undefined;
  // Idempotency is checked before anything else: an identical retry returns the original result.
  if (prior) {
    if (prior.payload_hash !== hash)
      return { httpStatus: 409, body: { error: "commandId was already used with different content", reasonCodes: ["command_id_conflict"], commandId: id } };
    return { httpStatus: 200, body: { commandId: id, replayed: true, status: prior.status, ...JSON.parse(prior.result), stateRevision: prior.revision } };
  }
  if (input.expectedRevision !== undefined && Number(input.expectedRevision) !== stateRevision())
    return { httpStatus: 409, body: { error: "State changed since expectedRevision", reasonCodes: ["stale_revision"], stateRevision: stateRevision() } };

  let r: ControlResult;
  switch (type) {
    case "pause_entries":
      r = pauseEntries(typeof payload.reason === "string" && payload.reason ? payload.reason.slice(0, 120) : "Paused manually");
      break;
    case "resume_entries":
      r = resumeEntries();
      break;
    case "cancel_pending_buys":
      r = { status: "applied", reasonCodes: [], detail: { cancelledBuys: cancelPendingBuys("agent") } };
      break;
    case "request_exit":
      if (typeof payload.positionId !== "string") return { httpStatus: 422, body: { error: "payload.positionId is required", reasonCodes: ["invalid_payload"] } };
      r = requestExit(payload.positionId);
      break;
    case "request_flatten":
      r = requestFlatten();
      break;
    case "reset_risk_anchors":
      r = resetRiskAnchors();
      break;
    case "reallocate_cash": {
      const sleeve = (v: unknown) => (v === null || v === undefined || v === "unallocated" ? null : (SLEEVES as string[]).includes(String(v)) ? (v as SleeveId) : undefined);
      const from = sleeve(payload.from);
      const to = sleeve(payload.to);
      if (from === undefined || to === undefined || !(Number(payload.amountSol) > 0))
        return { httpStatus: 422, body: { error: "payload needs from, to (sleeve or 'unallocated') and amountSol > 0", reasonCodes: ["invalid_payload"] } };
      r = reallocate((payload.account as "agent" | "rules") ?? "agent", from, to, Number(payload.amountSol));
      break;
    }
  }
  const revision = stateRevision() + (r.status === "applied" ? 1 : 0);
  const result = { reasonCodes: r.reasonCodes, detail: r.detail };
  db.prepare("INSERT INTO commands (id, type, payload_hash, status, result, at, revision) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    type,
    hash,
    r.status,
    JSON.stringify(result),
    Date.now(),
    revision,
  );
  return { httpStatus: 200, body: { commandId: id, replayed: false, status: r.status, ...result, stateRevision: revision } };
}

export function commandStatus(id: string) {
  const row = db.prepare("SELECT id, type, status, result, at, revision FROM commands WHERE id = ?").get(id) as
    | { id: string; type: string; status: string; result: string; at: number; revision: number }
    | undefined;
  return row ? { commandId: row.id, commandType: row.type, status: row.status, ...JSON.parse(row.result), at: row.at, stateRevision: row.revision } : null;
}
