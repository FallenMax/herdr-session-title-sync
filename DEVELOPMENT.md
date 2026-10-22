# Development reference

This document records the dependency behavior that constrains the integration. It describes public contracts and verified observations, not the implementation details of this repository.

## Architecture

- Herdr's official integrations provide pane identity, workspace identity, agent detection, lifecycle state, and native session identity.
- Codex and Claude Code expose lifecycle hooks with structured input.
- Pi exposes an in-process extension API with session and agent lifecycle events.
- Each adapter converts the strongest available public session signal into bounded title and latest-message values.
- The adapters report metadata through Herdr's pane-scoped public API.
- A Herdr plugin refreshes workspace metadata when workspace or pane lifecycle events occur.
- Herdr renders the metadata tokens in the agent and workspace sidebars.
- The installer composes the official integrations with these adapters without owning agent state.

## Distribution and installation

- The published Herdr plugin runs `scripts/install.ts --plugin-build` during installation.
- The installer detects `codex`, `claude`, and `pi` on `PATH` and configures only the agents that are present.
- Codex hooks are kept in `~/.codex/config.toml`. The installer preserves unrelated hooks and removes a Herdr-only legacy `hooks.json`.
- Claude Code hooks are added to `~/.claude/settings.json` without replacing unrelated hooks.
- The global Pi adapter is generated as a self-contained extension in `~/.pi/agent/extensions`.
- `PI_PROJECT_DIR` selects a project Pi scope. The installer copies the official Herdr Pi state adapter into that project's `.pi/extensions` directory and generates the display adapter there.
- The generated Pi adapter uses the `local_` prefix so a shared project can ignore it.
- The installer removes the old display adapter names and generated library files before writing the current adapter.
- Herdr has no plugin uninstall callback. Uninstalling this plugin unregisters its workspace events but cannot remove agent configuration written by the build command.
- The workspace plugin refreshes metadata on workspace and pane lifecycle events. It is not responsible for installing agent hooks.

## Herdr 0.9.5

References: [plugins](https://herdr.dev/docs/plugins/), [socket API](https://herdr.dev/docs/socket-api/), and [integrations](https://herdr.dev/docs/integrations/).

### Verified public behavior

- Official integrations identify the agent pane and expose Herdr-owned pane and workspace identifiers to integration processes.
- The public snapshot contains agent status, native terminal title, agent session identity when available, workspace membership, and source-scoped metadata tokens.
- Pane metadata and workspace metadata are separate reports. Updating a pane does not imply that the workspace display has been recomputed.
- Plugins receive lifecycle events for workspace creation and update, pane creation and exit, and agent detection. Event commands run with Herdr's injected runtime context.
- Herdr does not derive the desired session title from a terminal title or an agent transcript. An adapter must report display metadata explicitly.
- Pane creation or agent detection can occur before the official integration has produced an agent session identity or before an adapter has produced title metadata.
- Workspace fallback metadata is useful during that gap, but a later authoritative adapter report must replace it.
- Plugins run as the local user and are not sandboxed. A manifest and its commands are part of the trust boundary.

### Design consequences

- Use Herdr identity fields to associate updates. Do not infer pane ownership from focus or directory names.
- Treat snapshot and metadata APIs as the inspection surface. Do not inspect Herdr server logs for normal operation.
- Separate pane reporting from workspace refresh. Test both states independently.
- Make lifecycle refresh idempotent because the same workspace can receive several relevant events.

## Codex CLI 0.163.0

Reference: [Codex hooks](https://developers.openai.com/codex/hooks/).

### Verified public behavior

- Codex hooks receive structured JSON on standard input and can run for `SessionStart`, `UserPromptSubmit`, and `Stop`.
- Hook configuration can exist in more than one representation. Loading both `hooks.json` and `config.toml` produces a warning and makes the effective configuration harder to reason about.
- The official Herdr integration is the source of Codex session identity. A custom hook can run before that identity appears in Herdr's snapshot.
- Codex hook payloads do not provide a consistently usable human session title for every lifecycle event.
- Herdr's public pane metadata exposes the terminal title, which can become more informative after the Codex session starts than it was at `SessionStart`.
- A running Codex process does not reload changed hook configuration. New processes are required to verify an installation change.

### Design consequences

- Keep one Codex hook representation and preserve unrelated user hooks.
- Report an early fallback without treating it as final. Re-read Herdr pane metadata at prompt and turn-completion boundaries.
- Do not require Codex to provide a session title when Herdr can provide the current native terminal title.
- Verify both the hook configuration and a newly started Codex process.

## Claude Code 2.1.301

Reference: [Claude Code hooks](https://code.claude.com/docs/en/hooks).

### Verified public behavior

- Claude Code exposes structured hooks for `SessionStart`, `UserPromptSubmit`, and `Stop`.
- Hook input includes a session identifier and working directory. Prompt and final-response fields are event-dependent.
- A session title field is not guaranteed to be present or useful on every event.
- Herdr's pane snapshot provides a native terminal title after the Claude session has initialized.
- A Claude hook can run before Herdr has linked the hook's session identifier to the pane. Waiting for the matching pane session avoids cross-pane updates.
- Existing Claude processes do not pick up changed settings until they are restarted.

### Design consequences

- Match the hook session identifier with Herdr's pane session identity before reporting.
- Prefer the Herdr native terminal title when the hook payload has no authoritative title.
- Refresh the title at turn completion, not only at session start.
- Keep the official Herdr state hook and the display hook as independent entries.

## Pi 1.3.0

Reference: [Pi extensions](https://pi.dev/docs/latest/extensions) and [session file format](https://pi.dev/docs/latest/session-format).

### Verified public behavior

- Pi automatically loads extensions from its global extension directory and a project's `.pi/extensions` directory.
- The extension API exposes `session_start` and `session_info_changed` for session creation, reload, and session-name changes.
- The extension API exposes `before_agent_start`, `agent_start`, and `agent_settled` around an agent turn.
- The session manager exposes the active session identity, session file, session name, and in-memory entries through the extension context.
- Pi extensions run inside the Pi process with the process's operating-system permissions.
- A project extension can be loaded in addition to the global extension. Duplicate display adapters can therefore produce competing metadata reports.

### Design consequences

- Use the extension API as the primary source for session name and message state.
- Subscribe to session-name changes and settled turns. Do not poll session files as the normal path.
- Install one display adapter per Pi scope and use an explicit local prefix for personal project extensions.
- Treat extension loading as trusted code execution and keep the extension dependency-free.

## Revalidate after dependency changes

When Herdr or an agent runtime changes, verify the affected component in this order:

1. Record the new version and read the current public documentation.
2. List the available identity, title, message, lifecycle, and rename signals.
3. Run a controlled session that exercises startup, one prompt, one completed turn, rename if supported, reload, and exit.
4. Inspect public snapshots or API responses for positive signals and for missing or overwritten values.
5. Update this document with facts that changed, then update the adapter only from those facts.
6. Run the repository checks and repeat the controlled session with a newly started process.
