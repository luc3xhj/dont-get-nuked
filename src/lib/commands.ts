// Operator commands to the worker (idempotent: each click gets its own commandId).
export type CommandType = "pause_entries" | "resume_entries" | "cancel_pending_buys" | "request_exit" | "request_flatten" | "reset_risk_anchors";
export type CommandResult = { status?: "applied" | "blocked"; reasonCodes?: string[]; detail?: Record<string, unknown>; error?: string };

export const REASON_TEXT: Record<string, string> = {
  max_drawdown_breached: "Max drawdown limit is breached. Reset risk anchors explicitly to resume.",
  daily_loss_limit_breached: "Daily loss limit is breached; entries resume at the next UTC day.",
  valuation_incomplete: "A position can't be reliably priced, so risk can't be assessed.",
  position_not_found: "That position is already closed.",
  exit_already_pending: "An exit for this position is already pending.",
  worker_not_running: "The worker isn't running normally (recovering, draining or faulted).",
};

export async function sendCommand(commandType: CommandType, payload: Record<string, unknown> = {}): Promise<CommandResult> {
  try {
    const res = await fetch("/api/agent/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: crypto.randomUUID(), commandType, payload }),
    });
    return (await res.json()) as CommandResult;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export const describeResult = (r: CommandResult) =>
  r.error ?? (r.status === "blocked" ? (r.reasonCodes ?? []).map((c) => REASON_TEXT[c] ?? c).join(" ") : null);
