/**
 * Codex hooks consume stable hook fields and publish presentation metadata only.
 */

import { makeSidebarValue, messageText, parseHookInput, readPaneInfo, reportSidebar, type Agent, type SidebarValue } from "./sidebar.ts";

export type CodexHookDependencies = {
  readPaneInfo: () => ReturnType<typeof readPaneInfo>;
  reportSidebar: (agent: Agent, value: Partial<SidebarValue>) => Promise<void>;
};

/** Publishes Codex presentation metadata using the pane identity supplied by Herdr. */
export async function syncCodexSidebar(
  payload: Record<string, unknown>,
  dependencies: CodexHookDependencies = { readPaneInfo, reportSidebar },
): Promise<void> {
  if (payload.agent_id) return;
  const event = payload.hook_event_name;
  if (event === "SessionStart" || event === "UserPromptSubmit") {
    const pane = await dependencies.readPaneInfo();
    const prompt = event === "UserPromptSubmit" ? payload.prompt : "";
    const value = makeSidebarValue("codex", payload.cwd, prompt, pane?.terminal_title_stripped);
    await dependencies.reportSidebar("codex", value);
  } else if (event === "Stop") {
    const latest = messageText(payload.last_assistant_message);
    const pane = await dependencies.readPaneInfo();
    const title = makeSidebarValue("codex", payload.cwd, "", pane?.terminal_title_stripped).title;
    if (title || latest) await dependencies.reportSidebar("codex", { title, latest });
  }
}

if (import.meta.main) {
  const payload = await readHookPayload();
  if (payload && process.env.HERDR_ENV === "1") await syncCodexSidebar(payload);
}

async function readHookPayload(): Promise<Record<string, unknown> | undefined> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (input.length > 2_000_000) return undefined;
  }
  return parseHookInput(input);
}
