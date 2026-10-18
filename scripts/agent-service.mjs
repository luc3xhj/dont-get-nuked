// Runs the agent worker as a macOS LaunchAgent: starts at login, restarts if it exits.
//   npm run agent:install | agent:start | agent:stop | agent:status | agent:uninstall
// Paper trading only; the worker listens on 127.0.0.1 and holds no keys.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const label = "local.dont-get-nuked.agent";
const domain = `gui/${process.getuid()}`;
const plist = resolve(homedir(), "Library/LaunchAgents", `${label}.plist`);
const logs = resolve(root, "agent/logs");
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

function ctl(args, required = true) {
  const r = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (required && r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r;
}
const loaded = () => ctl(["print", `${domain}/${label}`], false).status === 0;

function writePlist() {
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(logs, { recursive: true });
  if (existsSync(plist) && !readFileSync(plist, "utf8").includes(xml(root))) throw new Error("Existing service belongs to another directory");
  // `node --import tsx` runs the TypeScript worker in a single process launchd can supervise.
  const args = [process.execPath, "--import", "tsx", resolve(root, "agent/main.ts")];
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(resolve(logs, "agent.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(resolve(logs, "agent.error.log"))}</string>
</dict>
</plist>
`
  );
  execFileSync("/usr/bin/plutil", ["-lint", plist], { stdio: "inherit" });
}

const cmd = process.argv[2];
if (cmd === "install") {
  if (loaded()) ctl(["bootout", `${domain}/${label}`], false);
  writePlist();
  ctl(["bootstrap", domain, plist]);
  console.log(`Installed ${plist}\nAgent API: http://127.0.0.1:3101 · logs: ${logs}`);
} else if (cmd === "start") {
  if (loaded()) ctl(["kickstart", "-k", `${domain}/${label}`]);
  else ctl(["bootstrap", domain, plist]);
  console.log("Started");
} else if (cmd === "stop") {
  ctl(["bootout", `${domain}/${label}`], false);
  console.log("Stopped. It starts again at next login; use agent:uninstall to remove it.");
} else if (cmd === "status") {
  const r = ctl(["print", `${domain}/${label}`], false);
  if (r.status !== 0) console.log("Service not loaded");
  else console.log(r.stdout.split("\n").filter((l) => /state =|pid =|last exit code|runs =/.test(l)).join("\n"));
} else if (cmd === "uninstall") {
  ctl(["bootout", `${domain}/${label}`], false);
  rmSync(plist, { force: true });
  console.log("Uninstalled. Data in agent/data is kept.");
} else {
  console.error("Use install | start | stop | status | uninstall");
  process.exit(1);
}
