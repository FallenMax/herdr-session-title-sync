# Maintenance principles

This repository integrates Herdr with several agent runtimes. Keep the integration small, observable, and portable.

## Use public contracts first

- Prefer documented APIs, hook payloads, lifecycle events, environment variables, and socket or CLI interfaces.
- Do not depend on agent internals, private files, undocumented log formats, screen scraping, or implementation-specific transcript layouts when a public interface can provide the same signal.
- Treat Herdr as the owner of pane identity, workspace identity, lifecycle state, and agent detection.
- Treat each agent as the owner of its session name, prompt, reply, and session lifecycle.
- Keep this repository as an adapter. Do not duplicate either system's state machine.

## Investigate the full dependency surface

Before changing behavior, record the versions in use and inspect every relevant public capability of Herdr and the agent runtime.

- Enumerate the positive signals that can establish identity, title, prompt, reply, start, update, rename, settle, and exit.
- Verify when each signal becomes available and whether it carries enough data for the target behavior.
- Exercise the signals with a controlled session instead of inferring behavior from one stale session.
- Record negative behavior as well. Check which events omit data, which events arrive before another system has updated its state, and which lifecycle events can overwrite metadata.
- Prefer a later authoritative signal over an early incomplete signal. Do not replace a useful value with a weaker fallback.

## Preserve boundaries and fallbacks

- Validate external hook input at the boundary, bound displayed text, and keep user content out of diagnostics.
- Associate every update with the pane and session supplied by the host. Never choose a pane by focus, recency, or directory alone.
- Make updates idempotent and safe when a host is unavailable, restarting, or already updated.
- Use fallbacks only when the authoritative signal is absent. A fallback must not hide whether the integration failed to observe the authoritative signal.
- Do not make title synchronization able to block or change agent work.

## Keep documentation useful

- Keep this file limited to general maintenance principles and architecture boundaries.
- Keep component facts, versions, public capabilities, and verified limitations in `DEVELOPMENT.md`.
- Keep user-facing setup in `README.md`.
- Do not put current business details, one-off observations, or workaround history in this file.
- Update a component section when a new version or experiment changes a verified fact.
