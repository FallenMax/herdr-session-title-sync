/**
 * Claude Code hooks publish the current prompt and final reply without reading transcripts.
 */

import { makeSidebarValue, messageText, parseHookInput, reportSidebar, waitForPaneSession } from "./sidebar.ts";

const payload = await readHookPayload();
if (!payload || payload.agent_id || process.env.HERDR_ENV !== "1") process.exit(0);

const cwd = payload.cwd;
const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
if (!sessionId) process.exit(0);
const pane = await waitForPaneSession("claude", sessionId);
if (!pane) process.exit(0);
const nativeTitle = payload.session_title || pane.terminal_title_stripped;

if (payload.hook_event_name === "SessionStart") {
  const value = makeSidebarValue("claude", cwd, "", nativeTitle);
  await reportSidebar("claude", value);
} else if (payload.hook_event_name === "UserPromptSubmit") {
  const value = makeSidebarValue("claude", cwd, payload.prompt, nativeTitle);
  await reportSidebar("claude", value);
} else if (payload.hook_event_name === "Stop") {
  const latest = messageText(payload.last_assistant_message);
  const title = makeSidebarValue("claude", cwd, "", nativeTitle).title;
  if (title || latest) await reportSidebar("claude", { title, latest });
}

async function readHookPayload(): Promise<Record<string, unknown> | undefined> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (input.length > 2_000_000) return undefined;
  }
  return parseHookInput(input);
}
