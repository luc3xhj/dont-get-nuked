import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export function codexBin(): string | null {
  const candidates = [
    process.env.CODEX_BIN,
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((p) => join(p, "codex")),
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    resolve(homedir(), ".local/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

type Options = { schema: object; instructions: string; model?: string; timeoutMs: number; bin?: string };

/** Headless, ephemeral Codex using the existing ChatGPT login, outside the repository. */
export async function runCodex(prompt: string, options: Options): Promise<{ structured: Record<string, unknown>; raw: Record<string, unknown> }> {
  const bin = options.bin ?? codexBin();
  if (!bin) throw Object.assign(new Error("Codex CLI not installed; set CODEX_BIN"), { code: "not-installed" });
  const base = resolve(homedir(), ".cache/dont-get-nuked-analyst");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(base, "run-"));
  const output = join(dir, "result.json");
  const schema = join(dir, "schema.json");
  writeFileSync(schema, JSON.stringify(options.schema), { mode: 0o600 });
  const args = [
    "exec", "--ignore-user-config", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only",
    "--color", "never", "--json", "--output-schema", schema, "--output-last-message", output,
    "-c", "approval_policy=\"never\"", "-c", "web_search=\"disabled\"",
    "-c", "features.shell_tool=false", "-c", "features.apps=false", "-c", "features.plugins=false",
    "-c", "features.multi_agent=false", "-c", "features.hooks=false",
    "-c", "features.skip_host_skill_discovery=true", "-c", "project_doc_max_bytes=0",
    "-c", `developer_instructions=${JSON.stringify(options.instructions)}`,
    ...(options.model ? ["--model", options.model] : []), "-",
  ];
  // Authentication is read by Codex itself. Provider keys and the Treg token are not inherited.
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production" };
  for (const key of ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE"])
    if (process.env[key]) env[key] = process.env[key];

  try {
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(bin, args, { cwd: dir, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      let failure: Error | null = null;
      let escalation: NodeJS.Timeout | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* Already exited. */ }
      };
      const stop = (reason: string) => {
        if (failure) return;
        failure = new Error(reason);
        kill("SIGTERM");
        escalation = setTimeout(() => kill("SIGKILL"), 2_000);
      };
      const onParentExit = () => kill("SIGKILL");
      process.once("exit", onParentExit);
      const timer = setTimeout(() => stop(`Codex timed out after ${options.timeoutMs}ms`), options.timeoutMs);
      const clear = () => { clearTimeout(timer); clearTimeout(escalation); process.removeListener("exit", onParentExit); };
      child.stdout.on("data", (data) => {
        out += data.toString();
        if (out.length > 2_000_000) stop("Codex output exceeded 2 MB");
      });
      child.stderr.on("data", (data) => { err = (err + data.toString()).slice(-8_000); });
      child.stdin.on("error", () => { /* Early exits are handled by close. */ });
      child.on("error", (error) => { clear(); reject(error); });
      child.on("close", (code) => {
        clear();
        if (failure) return reject(failure);
        let usage: unknown;
        let eventError = "";
        let turnFailed = false;
        for (const line of out.split("\n")) {
          try {
            const event = JSON.parse(line);
            if (event.type === "turn.completed") usage = event.usage;
            if (event.type === "error" || event.type === "turn.failed") eventError = event.message ?? event.error?.message ?? "Codex turn failed";
            if (event.type === "turn.failed") turnFailed = true;
          } catch { /* Ignore non-event lines. */ }
        }
        if (code !== 0 || turnFailed) {
          const message = (eventError || err || `Codex exited with code ${code}`).slice(-600);
          return reject(Object.assign(new Error(message), { code: /not logged in|unauthorized|401|sign in|login required/i.test(message) ? "not-logged-in" : "error" }));
        }
        try {
          const structured = JSON.parse(readFileSync(output, "utf8"));
          if (!structured || typeof structured !== "object" || Array.isArray(structured)) throw new Error("Expected an object");
          resolvePromise({ structured, raw: { usage, provider: "codex" } });
        } catch {
          reject(new Error("Codex returned no valid structured result"));
        }
      });
      child.stdin.end(prompt);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
