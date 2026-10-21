# Web Command Layer — Architecture

> Stages 0–1 of the Web↔CLI Parity Command Layer (surface-agnostic, staged).

## Stage 1: capabilities and canonical session controls

Command availability is derived from `SlashCommand.requires` and the surface's positive
capability set (`src/cli/slash/capabilities.ts`). Only rewind/pickers, fork/resume and exit
retain explicit lifecycle-stage deferrals; GET `/api/commands` keeps its existing wire shape.
The REPL declares actual TTY availability; web advertises session control, not terminal access.

`src/agent/session-control/` owns reset, compaction hooks, model/name/preferences and shared
usage/token/context/MCP reads. Busy admission stays with callers. REPL handlers retain their
formatting and terminal progress adapters; web captures text progress without ora.

`session-owner.control.ts` binds these operations to live owner stats, autosave, and the
provider's fast-mode controller. Clear resets conversation/stats/trusted-skill ledger while
retaining model, permission and thinking preference. Telegram's replacement-session behavior
is deliberately not adopted; Telegram migration remains Stage 5.

Successful clear returns `control: {kind:'clear'}`. Model/name/thinking commands may return
`session` metadata. The dashboard clears old client-local command output and conversation
state, retains the clear confirmation, and applies authoritative model/name/display changes.
Ledger replacement is atomic; generation-qualified opaque SSE cursors and `{reset:true}`
frames rebase both existing tabs and reconnecting clients, including repeated clears.

The sections below describe the original Stage 0 foundation; its flat gate-list description
is historical and superseded by the capability derivation above.

## Overview

The web surface (`afk web`) exposes slash commands through a structured HTTP API rather than
running the CLI's interactive loop. This document describes the architecture, data flow, and
intentional limitations of Stage 0.

## Request Flow

```
Browser composer
  └─ POST /api/sessions/:id/commands   { input: "/help" }
       └─ routes.commands.ts
            ├─ validateId
            ├─ requireOwned
            ├─ isBusy? → 409
            ├─ reserveTurn()          ← synchronous
            └─ try {
                 ensureSlashRegistry()
                 waitForSessionReady() ← polls owner.getSession() up to 2s
                 registry.parse(input)
                 registry.lookup(name)
                 isGated(name)?        ← command-gate.ts (single source of truth)
                 BufferingWriter       ← captures all handler output
                 createWebSlashContext()
                 cmd.handler(ctx, args)
                 writer.toOutputBlock()
                 normalizeSlashResult()
                 → 200 { blocks, control }
               } finally { releaseTurn() }
```

## Key Modules

| Module | Role |
|---|---|
| `src/web-server/slash-registry.ts` | Shared `ensureSlashRegistry()` memo — one registry init for both `routes.ts` and `slash-dispatch.ts` |
| `src/web-server/command-gate.ts` | Canonical gate list; `isGated(name)` + `gateReason(name)`; **single source of truth** for Stage 0 |
| `src/web-server/writer.buffer.ts` | `BufferingWriter` — captures handler output; `toOutputBlock()` strips VT control chars |
| `src/web-server/session-owner.slash.ts` | Per-session `SessionStats` side-car; `buildSessionRef()` |
| `src/web-server/slash-context.web.ts` | `createWebSlashContext()` — `SlashContext` adapter for web |
| `src/web-server/routes.commands.ts` | `POST /api/sessions/:id/commands` handler |
| `src/web-server/shared/command-wire.ts` | Server-side wire types (`CommandOutputBlock`, `CommandResponse`, `CommandControl`) |

## Wire Types

### Request

```json
POST /api/sessions/:id/commands
{ "input": "/help" }
```

### Response (200)

```json
{
  "blocks": [
    {
      "ansi": "\u001b[1mAvailable commands\u001b[0m\n...",
      "text": "Available commands\n..."
    }
  ],
  "control": { "kind": "continue" }
}
```

### Control variants

| `control.kind` | Dashboard action |
|---|---|
| `continue` | no-op |
| `exit` | show inline notice (no effect on web in Stage 0) |
| `forward` | re-POST original input to `/prompt` |
| `rerun` | re-POST `control.input` to `/commands` |
| `submit` | submit `control.message` as a new prompt |
| `prefill` | set composer text to `control.message` without submitting |

## Gate List (Stage 0)

Commands in `command-gate.ts` return HTTP 409 `command_gated` with a human-readable reason.
The gate covers all commands that require terminal machinery, session-lifecycle operations, or
capabilities absent on the web surface (compositor, ledger, TTY, etc.).

> **Invariant:** Stage 1 replaces the flat gate list with `requires: SurfaceCapability[]`
> per command, enabling fine-grained capability negotiation.

## Command Output — Client-Local Items

`command-output` transcript items are **client-local**: they are never persisted to the
session journal or SSE stream. Each item lives only in the React component tree for the
duration of the browser session. On page reload, only server-persisted transcript items
(tool cards, assistant messages, etc.) reappear.

This is intentional for Stage 0: command output is ephemeral diagnostic/utility output.
Stage 2 will introduce structured output blocks (keyValue, table, list, diff) that may be
selectively persisted via the journal.

## Session Stats

`session-owner.slash.ts` maintains a process-global `Map<sessionId, SessionStats>` as a
side-car to `session-owner.ts`. Stats are initialized when a session is created and updated
after each turn drains in `session-owner.autosave.ts`. This allows slash handlers that read
`ctx.stats` (e.g. `/cost`, `/tokens`) to return accurate data without coupling the route to
the autosave internals.

## Known Limitations (Stage 0)

- **No cancel route**: background job cancel requires a cross-process signal channel.
  The cancel button in the bg-jobs view is disabled with a tooltip directing the operator to
  use `/bgsub:cancel <id>` from the owning session.
- **Command output is client-local**: not persisted; lost on reload.
- **Session readiness poll**: `waitForSessionReady` polls `owner.getSession(id)` every 50ms
  up to 2s. If the session is not ready, it returns 503 `session_not_ready`. Stage 1 will
  replace this with a readiness event from `SessionOwner`.
- **Dynamic imports on hot path**: `ensureSlashRegistry` and registry imports are dynamic to
  keep the `cli/slash` tree off the server's startup path. These will be hoisted to
  module-top once the route is opt-in (server.ts already routes lazily).
