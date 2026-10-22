/**
 * Shared display rules for agent-native session adapters. Herdr owns lifecycle
 * and session identity; this module only writes bounded sidebar tokens.
 */

import net from "node:net";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

export type Agent = "codex" | "claude" | "pi";
export type SidebarValue = { title: string; latest: string };

type HerdrResponse = { id?: string; result?: unknown; error?: unknown };
type PaneSession = { agent?: unknown; kind?: unknown; value?: unknown };
type PaneInfo = {
  workspace_id?: unknown;
  terminal_title_stripped?: unknown;
  tokens?: Record<string, unknown>;
  agent_session?: PaneSession;
};

type WorkspaceInfo = {
  workspace_id?: unknown;
  label?: unknown;
};

const SOURCE = "user:herdr-session-sidebar";
const WORKSPACE_ICON = "";
const MAX_TEXT_LENGTH = 80;
let lastSequence = 0;

/** Parses a hook payload as a plain object and rejects malformed input. */
export function parseHookInput(value: string): Record<string, unknown> | undefined {
  if (value.length > 2_000_000) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Normalizes untrusted agent text for visible sidebar metadata. */
export function displayText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_LENGTH)
    .trim();
}

/** Extracts readable text from the string and content-block shapes used by agents. */
export function messageText(value: unknown): string {
  if (typeof value === "string") return displayText(value);
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return displayText(parts.join(" "));
}

/** Chooses a native session title, active prompt, or safe workspace fallback. */
export function chooseTitle(
  nativeTitle: unknown,
  prompt: unknown,
  cwd: unknown,
  agent: Agent,
): string {
  const native = displayText(nativeTitle);
  if (native && !isGenericTitle(native)) return native;
  const activePrompt = messageText(prompt);
  if (activePrompt) return activePrompt;
  const directory = typeof cwd === "string" ? cwd.split(/[\\/]/).filter(Boolean).at(-1) : undefined;
  return displayText(`${directory || "workspace"}-${agent}`);
}

/** Writes the two sidebar tokens through Herdr's pane-scoped metadata API. */
export async function reportSidebar(
  agent: Agent,
  value: Partial<SidebarValue>,
  paneId = process.env.HERDR_PANE_ID,
): Promise<void> {
  if (process.env.HERDR_ENV !== "1" || !isPaneId(paneId)) return;
  const title = displayText(value.title);
  const latest = displayText(value.latest);
  const tokens: Record<string, string> = {};
  if (title) tokens.title = title;
  if (latest) tokens.latest = latest;
  if (Object.keys(tokens).length === 0) return;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!isSocketPath(socketPath)) return;

  try {
    await requestHerdr(socketPath, "pane.report_metadata", {
      pane_id: paneId,
      source: SOURCE,
      agent,
      applies_to_source: `herdr:${agent}`,
      tokens,
      seq: nextSequence(),
    }, [250, 500, 1000]);
    await reportWorkspace(agent, value, paneId);
  } catch {
    // Presentation updates must not affect the agent runtime.
  }
}

/** Writes the same presentation values to the workspace's Space metadata. */
export async function reportWorkspace(
  agent: Agent,
  value: Partial<SidebarValue>,
  paneId = process.env.HERDR_PANE_ID,
): Promise<void> {
  if (process.env.HERDR_ENV !== "1" || !isPaneId(paneId)) return;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!isSocketPath(socketPath)) return;

  const pane = await readPaneInfo(paneId);
  const workspaceId = pane?.workspace_id;
  if (!isWorkspaceId(workspaceId)) return;

  const tokens: Record<string, string> = {};
  const title = displayText(value.title);
  const latest = displayText(value.latest);
  if (title) tokens.title = title;
  if (latest) tokens.latest = latest;
  if (Object.keys(tokens).length === 0) return;

  await requestHerdr(socketPath, "workspace.report_metadata", {
    workspace_id: workspaceId,
    source: SOURCE,
    tokens,
    seq: nextSequence(),
  }, [250, 500, 1000]);
}

/** Mirrors the selected agent into the Space, or restores the workspace label. */
export async function syncWorkspaceMetadata(workspaceId: string): Promise<void> {
  if (process.env.HERDR_ENV !== "1" || !isWorkspaceId(workspaceId)) return;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!isSocketPath(socketPath)) return;

  const snapshot = await requestHerdr(socketPath, "session.snapshot", {});
  const result = asRecord(snapshot?.result);
  const session = asRecord(result?.snapshot);
  const workspaces = Array.isArray(session?.workspaces) ? session.workspaces : [];
  const workspace = workspaces
    .map(asRecord)
    .find((item) => item?.workspace_id === workspaceId);
  if (!workspace) return;

  const panes = Array.isArray(session?.panes) ? session.panes : [];
  const label = displayText(workspace.label);
  if (!label) return;
  const agentPane = panes
    .map(asRecord)
    .find((pane) => pane?.workspace_id === workspaceId && typeof pane?.agent === "string");
  const paneTokens = asRecord(agentPane?.tokens);
  const agentTitle = displayText(paneTokens?.title);
  const agentLatest = displayText(paneTokens?.latest);
  const hasSessionDisplay = agentTitle.length > 0 || agentLatest.length > 0;
  const title = hasSessionDisplay ? agentTitle || label : `${WORKSPACE_ICON} ${label}`;
  const latest = hasSessionDisplay ? agentLatest : "";
  await requestHerdr(socketPath, "workspace.report_metadata", {
    workspace_id: workspaceId,
    source: SOURCE,
    tokens: { title, latest: latest || null },
    seq: nextSequence(),
  }, [250, 500, 1000]);
}

/** Reads server-owned terminal title metadata for agents without a title hook field. */
export async function readPaneInfo(paneId = process.env.HERDR_PANE_ID): Promise<PaneInfo | undefined> {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!isSocketPath(socketPath) || !isPaneId(paneId)) return undefined;
  let response: HerdrResponse | undefined;
  try {
    response = await requestHerdr(socketPath, "pane.get", { pane_id: paneId }, [150, 350, 800]);
  } catch {
    return undefined;
  }
  if (!response || typeof response.result !== "object" || response.result === null) return undefined;
  const result = response.result as Record<string, unknown>;
  const pane = result.pane;
  return pane && typeof pane === "object" ? pane as PaneInfo : undefined;
}

/** Waits until Herdr's official integration confirms that the event belongs to this pane session. */
export async function waitForPaneSession(
  agent: Agent,
  sessionId?: string,
  sessionPath?: string,
  paneId = process.env.HERDR_PANE_ID,
): Promise<PaneInfo | undefined> {
  if (!isPaneId(paneId) || (!isSessionId(sessionId) && !isAbsoluteSessionPath(sessionPath))) return undefined;
  const deadline = Date.now() + 1200;
  do {
    const pane = await readPaneInfo(paneId);
    const session = pane?.agent_session;
    if (session?.agent === agent && (
      isAbsoluteSessionPath(sessionPath)
        ? session.kind === "path" && session.value === sessionPath
        : session.kind === "id" && session.value === sessionId
    )) return pane;
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  return undefined;
}

/** Converts a session's current prompt and final reply into shared sidebar semantics. */
export function makeSidebarValue(
  agent: Agent,
  cwd: unknown,
  prompt: unknown,
  nativeTitle?: unknown,
  finalReply?: unknown,
): SidebarValue {
  const title = chooseTitle(nativeTitle, prompt, cwd, agent);
  const latest = messageText(finalReply) || messageText(prompt) || title;
  return { title, latest };
}

function isGenericTitle(value: string): boolean {
  return /^(?:codex|claude(?: code)?|pi|π|terminal)(?:\s*[-|].*)?$/i.test(value);
}

function isPaneId(value: unknown): value is string {
  return typeof value === "string" && /^w[\w-]+:p[\w-]+$/.test(value);
}

function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && /^w[\w-]+$/.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isSocketPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024 && !/[\u0000-\u001f]/.test(value) && isAbsolute(value);
}

async function requestHerdr(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeouts: readonly number[] = [500, 1500],
): Promise<HerdrResponse | undefined> {
  const requestId = `session-sidebar-${randomUUID()}`;
  const payload = `${JSON.stringify({ id: requestId, method, params })}\n`;
  for (let attempt = 0; attempt < timeouts.length; attempt++) {
    const timeoutMs = timeouts[attempt];
    const result = await new Promise<HerdrResponse | undefined>((resolve) => {
      let settled = false;
      let buffer = "";
      const socket = net.createConnection(socketPath);
      const finish = (response?: HerdrResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        resolve(response);
      };
      const timeout = setTimeout(() => finish(), timeoutMs);
      timeout.unref?.();
      socket.on("error", () => finish());
      socket.on("connect", () => socket.write(payload));
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response: unknown = JSON.parse(buffer.slice(0, newline));
          if (!response || typeof response !== "object") return finish();
          const parsed = response as HerdrResponse;
          finish(parsed.id === requestId && !parsed.error ? parsed : undefined);
        } catch {
          finish();
        }
      });
      socket.on("end", () => finish());
    });
    if (result) return result;
    if (attempt + 1 < timeouts.length) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }
  return undefined;
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isAbsoluteSessionPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && isAbsolute(value) && !/[\u0000-\u001f]/.test(value);
}

function nextSequence(): number {
  const epochMicroseconds = Math.floor((performance.timeOrigin + performance.now()) * 1000);
  lastSequence = Math.max(lastSequence + 1, epochMicroseconds);
  return lastSequence;
}
