/**
 * Installs the native presentation adapters while preserving independent agent hooks.
 */

import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const root = dirname(import.meta.dir);
const home = process.env.HOME;
if (!home) throw new Error("HOME is required");

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const pluginBuild = process.argv.includes("--plugin-build");
const projectDir = process.env.PI_PROJECT_DIR ? resolve(process.env.PI_PROJECT_DIR) : undefined;
const piConfigDir = projectDir ? join(projectDir, ".pi") : join(home, ".pi", "agent");

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, value, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function eventHooks(config: Record<string, unknown>): Record<string, unknown[]> {
  const hooks = config.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) config.hooks = {};
  return config.hooks as Record<string, unknown[]>;
}

function addClaudeHook(hooks: Record<string, unknown[]>, event: string, command: string): void {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
  const exists = entries.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const nested = (entry as Record<string, unknown>).hooks;
    return Array.isArray(nested) && nested.some((hook) =>
      !!hook && typeof hook === "object" && (hook as Record<string, unknown>).command === command,
    );
  });
  if (!exists) entries.push({ matcher: "*", hooks: [{ type: "command", command, timeout: 5 }] });
  hooks[event] = entries;
}

function commandExists(command: string): boolean {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

async function installOfficialIntegrations(): Promise<Set<string>> {
  const installed = new Set<string>();
  for (const agent of ["codex", "claude", "pi"]) {
    if (!commandExists(agent)) continue;
    run(herdr, ["integration", "install", agent]);
    installed.add(agent);
  }
  return installed;
}

function isHerdrAgentStateCommand(value: unknown, command: string): boolean {
  return value === command;
}

function isManagedCodexHooksFile(config: Record<string, unknown>, command: string): boolean {
  const hooks = config.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const entries = Object.entries(hooks as Record<string, unknown>);
  if (entries.length !== 1 || entries[0][0] !== "SessionStart") return false;
  if (!Array.isArray(entries[0][1]) || entries[0][1].length === 0) return false;

  return entries[0][1].every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const nested = (entry as Record<string, unknown>).hooks;
    if (!Array.isArray(nested) || nested.length !== 1) return false;
    const hook = nested[0];
    return !!hook && typeof hook === "object" && !Array.isArray(hook) &&
      isHerdrAgentStateCommand((hook as Record<string, unknown>).command, command);
  });
}

async function consolidateCodexHooks(): Promise<void> {
  const codexHome = process.env.CODEX_HOME ?? join(home, ".codex");
  const configPath = join(codexHome, "config.toml");
  const hooksPath = join(codexHome, "hooks.json");
  const command = `bash '${join(codexHome, "herdr-agent-state.sh")}' session`;
  const config = await readFile(configPath, "utf8");
  const hooksFile = await readJson(hooksPath);

  if (!Object.keys(hooksFile).length) return;
  if (!isManagedCodexHooksFile(hooksFile, command)) {
    console.warn(`preserving Codex hooks.json because it contains non-Herdr hooks: ${hooksPath}`);
    return;
  }

  const commandLine = `command = ${JSON.stringify(command)}`;
  if (!config.split("\n").some((line) => line.trim() === commandLine)) {
    const suffix = config.endsWith("\n") ? "" : "\n";
    await writeText(
      configPath,
      `${config}${suffix}\n[[hooks.SessionStart]]\n\n[[hooks.SessionStart.hooks]]\n${commandLine}\ntimeout = 10\ntype = "command"\n`,
    );
  }
  await rm(hooksPath, { force: true });
}

async function installClaudeHooks(enabledAgents: ReadonlySet<string>): Promise<void> {
  if (!enabledAgents.has("claude")) return;
  const path = join(process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "settings.json");
  const config = await readJson(path);
  const hooks = eventHooks(config);
  const command = `bun '${join(root, "src", "claude-hook.ts")}'`;
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
    addClaudeHook(hooks, event, command);
  }
  await writeJson(path, config);
}

async function makeCodexSessionStartAsync(enabledAgents: ReadonlySet<string>): Promise<void> {
  if (!enabledAgents.has("codex")) return;
  const path = join(process.env.CODEX_HOME ?? join(home, ".codex"), "config.toml");
  const config = await readFile(path, "utf8");
  const command = `bun '${join(root, "src", "codex-hook.ts")}'`;
  const commandLine = `command = ${JSON.stringify(command)}`;
  const lines = config.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "[[hooks.SessionStart.hooks]]") continue;
    let end = index + 1;
    while (end < lines.length && !lines[end].trim().startsWith("[")) end += 1;
    if (!lines.slice(index + 1, end).some((line) => line.trim() === commandLine)) continue;
    const asyncIndex = lines.findIndex((line, lineIndex) => lineIndex > index && lineIndex < end && /^\s*async\s*=/.test(line));
    if (asyncIndex >= 0) {
      const setting = lines[asyncIndex].trim();
      if (setting === "async = true") return;
      if (setting !== "async = false") throw new Error("Invalid Codex SessionStart async setting");
      lines[asyncIndex] = "async = true";
    } else {
      let insertAt = end;
      while (insertAt > index + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
      lines.splice(insertAt, 0, "async = true");
    }
    await writeText(path, lines.join("\n"));
    return;
  }
  throw new Error("Codex session sidebar hook is missing from config.toml");
}

async function removeOldCursorHook(): Promise<void> {
  const path = join(process.env.CURSOR_CONFIG_DIR ?? join(home, ".cursor"), "hooks.json");
  const config = await readJson(path);
  const hooks = config.hooks as Record<string, unknown> | undefined;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return;
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    hooks[event] = value.filter((entry) => {
      if (!entry || typeof entry !== "object") return true;
      const command = (entry as Record<string, unknown>).command;
      return typeof command !== "string" || !command.includes(`${root}/src/cursor-hook.ts`);
    });
    if ((hooks[event] as unknown[]).length === 0) delete hooks[event];
  }
  await writeJson(path, config);
}

async function installPiAdapter(enabledAgents: ReadonlySet<string>): Promise<void> {
  if (!enabledAgents.has("pi")) return;
  const extensionsDir = join(piConfigDir, "extensions");
  const agentStatePath = join(extensionsDir, "local_herdr-agent-state.ts");
  const sidebarPath = join(extensionsDir, "local_herdr-session-workspace-sync.ts");
  await mkdir(extensionsDir, { recursive: true });

  if (projectDir) {
    await rm(agentStatePath, { force: true });
    await copyFile(join(home, ".pi", "agent", "extensions", "herdr-agent-state.ts"), agentStatePath);
  } else {
    await rm(agentStatePath, { force: true });
  }

  run("bun", [
    "build",
    join(root, "src", "pi-extension.ts"),
    "--outfile",
    sidebarPath,
    "--target",
    "bun",
  ]);

  for (const filename of [
    "herdr-session-title-sync.ts",
    "local_herdr-session-title-sync.ts",
    "local_herdr-session-sidebar.ts",
  ]) {
    await rm(join(extensionsDir, filename), { force: true });
  }
  for (const filename of ["sidebar.ts", "title.ts", "report.ts"]) {
    await rm(join(piConfigDir, "lib", filename), { force: true });
  }
}

async function installWorkspacePlugin(): Promise<void> {
  const result = spawnSync(herdr, ["plugin", "unlink", "herdr-session-title-sync"], { stdio: "ignore" });
  if (result.error) throw result.error;
  run(herdr, ["plugin", "link", root]);
}

const installedAgents = await installOfficialIntegrations();
if (installedAgents.has("codex")) await consolidateCodexHooks();
await makeCodexSessionStartAsync(installedAgents);
await installClaudeHooks(installedAgents);
await removeOldCursorHook();
await installPiAdapter(installedAgents);
if (!pluginBuild) await installWorkspacePlugin();

for (const filename of ["refresh.ts", "cursor-hook.ts"]) {
  await rm(join(root, "src", filename), { force: true });
}

if (!pluginBuild) run(herdr, ["server", "reload-config"]);
console.log(
  projectDir
    ? `Installed Herdr session sidebar adapters for Codex, Claude Code, and project Pi at ${projectDir}`
    : "Installed Herdr session sidebar adapters for Codex, Claude Code, and global Pi",
);
