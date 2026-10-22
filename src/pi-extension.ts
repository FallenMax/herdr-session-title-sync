/**
 * The project Pi extension reads its current session in memory and reports sidebar tokens.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  SessionInfoChangedEvent,
  BeforeAgentStartEvent,
} from "@mariozechner/pi-coding-agent";
import { chooseTitle, displayText, messageText, reportSidebar, waitForPaneSession } from "./sidebar.ts";

type SessionMessage = { role: "user" | "assistant"; content: unknown };
type SessionRef = { id?: string; path?: string };

/** Registers pane metadata updates at Pi's session and settled-turn boundaries. */
export default function registerHerdrSidebar(pi: ExtensionAPI): void {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return;
  let nativeTitle = "";
  let activePrompt = "";
  let rootTuiSession = false;
  let queue = Promise.resolve();

  function enqueue(value: { title: string; latest: string }, session: SessionRef): void {
    queue = queue.then(async () => {
      if (!await waitForPaneSession("pi", session.id, session.path)) return;
      await reportSidebar("pi", value);
    }).catch(() => undefined);
  }

  function currentSession(ctx: ExtensionContext): SessionRef {
    let id: string | undefined;
    let path: string | undefined;
    try {
      const value = ctx.sessionManager.getSessionId();
      if (typeof value === "string") id = value;
    } catch {}
    try {
      const value = ctx.sessionManager.getSessionFile();
      if (typeof value === "string") path = value;
    } catch {}
    return { id, path };
  }

  function sessionEntries(ctx: ExtensionContext): SessionMessage[] {
    try {
      const entries: unknown = ctx.sessionManager.getEntries();
      if (!Array.isArray(entries)) return [];
      return entries.flatMap((entry): SessionMessage[] => {
        if (!entry || typeof entry !== "object") return [];
        const candidate = (entry as Record<string, unknown>).message;
        if ((entry as Record<string, unknown>).type !== "message" || !candidate || typeof candidate !== "object") return [];
        const message = candidate as Record<string, unknown>;
        if (message.role !== "user" && message.role !== "assistant") return [];
        return [{ role: message.role, content: message.content }];
      });
    } catch {
      return [];
    }
  }

  function promptFrom(entries: SessionMessage[]): string {
    for (const entry of entries) {
      if (entry.role === "user") {
        const prompt = messageText(entry.content);
        if (prompt) return prompt;
      }
    }
    return "";
  }

  function latestFrom(entries: SessionMessage[], idle: boolean): string {
    const wantedRole = idle ? "assistant" : "user";
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.role === wantedRole) {
        const text = messageText(entry.content);
        if (text) return text;
      }
    }
    return activePrompt || promptFrom(entries) || chooseTitle(nativeTitle, "", process.cwd(), "pi");
  }

  function updateSession(event: SessionStartEvent | SessionInfoChangedEvent, ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    rootTuiSession = true;
    if (event.type === "session_start") {
      try { nativeTitle = displayText(ctx.sessionManager.getSessionName()); } catch { nativeTitle = ""; }
      activePrompt = promptFrom(sessionEntries(ctx));
    } else {
      nativeTitle = displayText(event.name);
    }
    const entries = sessionEntries(ctx);
    const title = chooseTitle(nativeTitle, promptFrom(entries), ctx.cwd, "pi");
    enqueue({ title, latest: latestFrom(entries, ctx.isIdle()) }, currentSession(ctx));
  }

  pi.on("session_start", updateSession);
  pi.on("session_info_changed", updateSession);
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    if (!rootTuiSession) return;
    activePrompt = messageText(event.prompt);
    enqueue({
      title: chooseTitle(nativeTitle, activePrompt, ctx.cwd, "pi"),
      latest: activePrompt,
    }, currentSession(ctx));
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!rootTuiSession || !activePrompt) return;
    enqueue({
      title: chooseTitle(nativeTitle, activePrompt, ctx.cwd, "pi"),
      latest: activePrompt,
    }, currentSession(ctx));
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!rootTuiSession || ctx.isIdle() !== true) return;
    const entries = sessionEntries(ctx);
    enqueue({
      title: chooseTitle(nativeTitle, activePrompt, ctx.cwd, "pi"),
      latest: latestFrom(entries, true),
    }, currentSession(ctx));
  });
}
