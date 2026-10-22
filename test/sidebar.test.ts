import { describe, expect, test } from "bun:test";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseTitle, displayText, makeSidebarValue, messageText, parseHookInput, reportSidebar } from "../src/sidebar.ts";
import { syncCodexSidebar } from "../src/codex-hook.ts";

describe("sidebar display values", () => {
  test("prefers a native title and displays the final reply", () => {
    expect(makeSidebarValue("claude", "/workspace", "current request", "Release review", "Review finished"))
      .toEqual({ title: "Release review", latest: "Review finished" });
  });

  test("uses the current prompt when an agent has no native title", () => {
    expect(chooseTitle("Claude Code", "Fix the export path", "/workspace", "claude"))
      .toBe("Fix the export path");
  });

  test("uses an agent-specific workspace fallback when no session text exists", () => {
    expect(chooseTitle(undefined, "", "/workspace/project", "pi")).toBe("project-pi");
  });

  test("extracts only text blocks and strips control characters", () => {
    expect(messageText([
      { type: "text", text: "first\nline" },
      { type: "image", url: "private" },
      { type: "text", text: "second" },
    ])).toBe("first line second");
  });

  test("bounds and normalizes display text", () => {
    expect(displayText(`\u001b[31m${"x".repeat(100)}\u001b[0m`)).toHaveLength(80);
    expect(displayText("\u0000 hello\nworld ")).toBe("hello world");
  });

  test("rejects malformed or oversized hook input", () => {
    expect(parseHookInput("[]")).toBeUndefined();
    expect(parseHookInput("not json")).toBeUndefined();
    expect(parseHookInput("x".repeat(2_000_001))).toBeUndefined();
    expect(parseHookInput('{"hook_event_name":"Stop"}')).toEqual({ hook_event_name: "Stop" });
  });
});

describe("Codex pane metadata", () => {
  test("reports title and prompt even before Herdr has a session identity", async () => {
    const calls: unknown[] = [];
    await syncCodexSidebar({hook_event_name: "UserPromptSubmit", cwd: "/workspace/deck", prompt: "Fix the title"}, {
      readPaneInfo: async () => ({terminal_title_stripped: "Review deck"}),
      reportSidebar: async (...args) => { calls.push(args); },
    });
    expect(calls).toEqual([["codex", {title: "Review deck", latest: "Fix the title"}]]);
  });

  test("uses the exact Herdr pane metadata without requiring a Codex session id", async () => {
    const calls: unknown[] = [];
    await syncCodexSidebar({hook_event_name: "SessionStart", cwd: "/workspace/deck"}, {
      readPaneInfo: async () => ({terminal_title_stripped: "Task title"}),
      reportSidebar: async (...args) => { calls.push(args); },
    });
    expect(calls).toEqual([["codex", {title: "Task title", latest: "Task title"}]]);
  });

  test("refreshes the native title when Codex finishes a turn", async () => {
    const calls: unknown[] = [];
    await syncCodexSidebar({hook_event_name: "Stop", cwd: "/workspace/deck", last_assistant_message: "Done"}, {
      readPaneInfo: async () => ({terminal_title_stripped: "Native session title"}),
      reportSidebar: async (...args) => { calls.push(args); },
    });
    expect(calls).toEqual([["codex", {title: "Native session title", latest: "Done"}]]);
  });
});

test("retries pane metadata after a transient Herdr API error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-sidebar-"));
  const socketPath = join(directory, "herdr.sock");
  let requests = 0;
  const server = net.createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline));
      requests++;
      const response = requests === 1
        ? { id: request.id, error: { code: "pane_not_ready" } }
        : { id: request.id, result: { type: "ok" } };
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  const previous = {
    env: process.env.HERDR_ENV,
    pane: process.env.HERDR_PANE_ID,
    socket: process.env.HERDR_SOCKET_PATH,
  };
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w-test:p1";
    process.env.HERDR_SOCKET_PATH = socketPath;
    await reportSidebar("codex", { title: "Task title", latest: "Prompt" });
    expect(requests).toBe(3);
  } finally {
    if (previous.env === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous.env;
    if (previous.pane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = previous.pane;
    if (previous.socket === undefined) delete process.env.HERDR_SOCKET_PATH; else process.env.HERDR_SOCKET_PATH = previous.socket;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
