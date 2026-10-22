# Herdr session sidebar sync

This Herdr plugin shows each Codex, Claude Code, and Pi session in the sidebar with:

- the session title, or the first useful message when no title exists;
- the latest prompt or agent reply.

It also mirrors the same values to the owning workspace. A workspace without an agent keeps its normal directory label.

## Install

```bash
herdr plugin install FallenMax/herdr-session-title-sync
```

The plugin writes the following integration configuration when the corresponding agent is installed:

- Codex hooks in `~/.codex/config.toml`;
- Claude Code hooks in `~/.claude/settings.json`;
- a Pi extension in `~/.pi/agent/extensions`.

Restart Codex, Claude Code, and Pi after installation.

## Configure the workspace sidebar

In the existing `[ui.sidebar.spaces]` section in Herdr's `config.toml`, set `rows` to:

```toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", { token = "$title", bold = true, dim = false }],
  [{ token = "$latest", bold = false, dim = false }],
]
```

Reload Herdr after saving the configuration:

```bash
herdr server reload-config
```
