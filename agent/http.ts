// Small fetch wrapper: timeouts, per-host concurrency, 429 backoff and call stats.

type HostState = {
  active: number;
  queue: (() => void)[];
  limit: number;
  pausedUntil: number;
  ok: number;
  errors: number;
  lastError: string | null;
  /** Token bucket: requests per minute allowed for this host. */
  perMin: number;
  tokens: number;
  refilledAt: number;
};

/** Free APIs rate-limit per IP; stay well under what we've observed. */
const RATE_PER_MIN: Record<string, number> = {
  // Measured: 429s after ~20 calls/min, and calls during the cool-down extend it.
  // Used only for launch backfills; live tapes come from GeckoTerminal (shared with the web app's charts).
  "swap-api.pump.fun": 10,
  "api.geckoterminal.com": 10,
  "api.dexscreener.com": 120,
  "frontend-api-v3.pump.fun": 30,
  "api.rugcheck.xyz": 20,
  "api.fxtwitter.com": 20,
};

const hosts = new Map<string, HostState>();

function host(url: string, limit: number): HostState {
  const h = new URL(url).host;
  let s = hosts.get(h);
  if (!s) {
    const perMin = RATE_PER_MIN[h] ?? 60;
    s = { active: 0, queue: [], limit, pausedUntil: 0, ok: 0, errors: 0, lastError: null, perMin, tokens: perMin / 4, refilledAt: Date.now() };
    hosts.set(h, s);
  }
  return s;
}

function refill(s: HostState) {
  const now = Date.now();
  s.tokens = Math.min(s.perMin / 4, s.tokens + ((now - s.refilledAt) / 60_000) * s.perMin);
  s.refilledAt = now;
}

/** Requests the host can take right now without waiting (for schedulers that prefer to skip rather than queue). */
export function budget(url: string): number {
  const s = host(url, 4);
  refill(s);
  return Date.now() < s.pausedUntil ? 0 : Math.floor(s.tokens) - s.queue.length;
}

async function takeToken(s: HostState) {
  for (;;) {
    refill(s);
    const wait = Math.max(s.pausedUntil - Date.now(), s.tokens >= 1 ? 0 : ((1 - s.tokens) / s.perMin) * 60_000);
    if (wait <= 0) {
      s.tokens -= 1;
      return;
    }
    await new Promise((r) => setTimeout(r, Math.min(wait, 5_000)));
  }
}

async function acquire(s: HostState) {
  if (s.active < s.limit) {
    s.active++;
    return;
  }
  await new Promise<void>((resolve) => s.queue.push(resolve));
  s.active++;
}

function release(s: HostState) {
  s.active--;
  s.queue.shift()?.();
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function getJson<T = unknown>(
  url: string,
  opts: { limit?: number; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<T> {
  const s = host(url, opts.limit ?? 4);
  await acquire(s);
  try {
    await takeToken(s);
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0", ...opts.headers },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after")) || 30;
      s.pausedUntil = Date.now() + Math.min(retry, 120) * 1000;
    }
    if (!res.ok) throw new HttpError(res.status, `${res.status} from ${new URL(url).host}`);
    const json = (await res.json()) as T;
    s.ok++;
    return json;
  } catch (e) {
    s.errors++;
    s.lastError = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    release(s);
  }
}

export function httpStats() {
  return Object.fromEntries(
    [...hosts].map(([h, s]) => [
      h,
      {
        ok: s.ok,
        errors: s.errors,
        active: s.active,
        queued: s.queue.length,
        pausedForMs: Math.max(0, s.pausedUntil - Date.now()),
        perMin: s.perMin,
        lastError: s.lastError,
      },
    ]),
  );
}
