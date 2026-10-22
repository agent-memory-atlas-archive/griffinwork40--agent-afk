# Web Command Layer — Architecture

> Stages 0–2 of the Web↔CLI Parity Command Layer (PATH_B: surface-agnostic command layer, staged).

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

Stage 2 builds on these canonical reads and controls: handlers obtain data from the
session-control service, then use structured block helpers without changing REPL rendering.

## Overview

The web surface (`afk web`) exposes slash commands through a structured HTTP API rather than
running the CLI's interactive loop. This document describes the architecture, data flow, and
intentional limitations of the command transport and structured-output layer.

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
                 owner.executeSessionControl(cmd, ctx, args) ← canonical handler + persistence
                 writer.toOutputBlocks()
                 normalizeSlashResult()
                 → 200 { blocks, control, session? }
               } finally { releaseTurn() }
```

## Key Modules

| Module | Role |
|---|---|
| `src/web-server/slash-registry.ts` | Shared `ensureSlashRegistry()` memo — one registry init for both `routes.ts` and `slash-dispatch.ts` |
| `src/web-server/command-gate.ts` | Capability-derived admission plus explicit lifecycle deferrals; `isGated(name)` + `gateReason(name)` |
| `src/web-server/writer.buffer.ts` | `BufferingWriter` — captures ordered text/structured output; `toOutputBlocks()` returns snapshots |
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
      "kind": "text",
      "ansi": "\u001b[1mAvailable commands\u001b[0m\n...",
      "text": "Available commands\n..."
    }
  ],
  "control": { "kind": "continue" }
}
```

### Structured blocks (Stage 2)

`src/cli/slash/output-blocks.ts` defines an optional `Writer.block(block)` capability.
`output-blocks.format.ts` provides `writeTable`, `writeKeyValue`, `writeDiff`,
`writeList`, and `writeLink`. Each helper takes semantic data and a legacy rendering
callback: block-capable writers receive structure; console writers execute the
original palette/line rendering unchanged. This callback is necessary to preserve
existing whitespace, colors, widths and newline behavior rather than invent a
second generic terminal format.

All blocks carry mandatory `text` (plain clipboard/fallback representation) and
`ansi` (text renderer representation). Structured helpers strip terminal controls
from all fields and generate deterministic fallbacks. The JSON-only wire contract
is mirrored in `dashboard/src/types/command-wire.ts`, with no CLI imports:

| kind | Additional fields |
|---|---|
| `text` | none; legacy responses without `kind` remain supported |
| `table` | `columns: string[]`, `rows: string[][]`, optional `title` |
| `keyValue` | `entries: {key: string, value: string}[]`, optional `title` |
| `diff` | `diff: string` (unified diff), optional `fileName` |
| `list` | `items: {text: string, description?: string}[]`, optional `title` |
| `link` | `url: string`, `label: string` |

The buffer preserves write order: contiguous `line`/`raw` writes become a text
block, each structured write flushes preceding text, and following text forms a
new block. Snapshots are non-destructive and detached; no output returns `[]`.
`SlashResult` remains control-only.

The dashboard registry selects renderers by `kind`; unknown kinds fall back to
text. Tables use accessible headers and horizontal scrolling, key-values use
semantic description lists, diffs render escaped React text with line colors,
and links accept only HTTP(S) schemes. Copy concatenates block `text` fields in
order. Navigation metadata lives in `dashboard/src/lib/nav-registry.ts`.

Migrated handlers: `/help` (same flat registry order as REPL), `/usage`, `/tokens`
(and `/ctx`), `/mcp` (including auth links), `/diff`, `/worktree list`.
`/info` did not exist in the baseline; Stage 2 adds a read-only local-stat summary.
`/resume` is a picker/session swap and remains deferred, not a plain listing.
Twenty plain/ANSI golden cases in `output-parity.test.ts` prove the migrated console
paths match the pre-structured handlers. Core/info/MCP fixtures are pinned to Stage 1's
canonical-service handlers; diff/worktree retain the common baseline. Existing snapshots
remain unchanged; `/info` has its own exact-output test.
Renderer tests cover all kinds, unknown fallback, safety and clipboard behavior.

### Control variants

| `control.kind` | Dashboard action |
|---|---|
| `continue` | no-op |
| `clear` | clear queue and replace command outputs with the confirmation; the nonterminal SSE reset clears the transcript on the existing connection |
| `exit` | show inline notice; dashboard calls `onSessionEnded` which deselects the session (no tab close) |
| `navigate` | select the target session id in the dashboard (returned by `/fork` and `/resume <id>`) |
| `forward` | re-POST original input to `/prompt` |
| `rerun` | re-POST `control.input` to `/commands` |
| `submit` | submit `control.message` as a new prompt |
| `prefill` | set composer text to `control.message` without submitting |

## Capability admission

Commands rejected by `command-gate.ts` return HTTP 409 `command_gated` with a human-readable
reason. `requires: SurfaceCapability[]` and the web capability set replace the Stage 0 flat
list. Terminal-only requirements remain unavailable; deferred pickers, fork/resume and exit
retain explicit lifecycle gates. The registry enforces requirements for explicitly declared
surfaces while preserving compatibility with older contexts.

## Command Output — Client-Local Items

`command-output` transcript items are **client-local**: they are never persisted to the
session journal or SSE stream. Each item lives only in the React component tree for the
duration of the browser session. On page reload, only server-persisted transcript items
(tool cards, assistant messages, etc.) reappear.

This is intentional for Stage 0: command output is ephemeral diagnostic/utility output.
Stage 2 adds structured output blocks but does not change persistence: all command output
remains client-local, including structured blocks.

## Session Stats

`session-owner.slash.ts` maintains a process-global `Map<sessionId, SessionStats>` as a
side-car to `session-owner.ts`. Stats are initialized when a session is created and updated
after each turn drains in `session-owner.autosave.ts`. This allows slash handlers that read
`ctx.stats` (e.g. `/cost`, `/tokens`) to return accurate data without coupling the route to
the autosave internals.

## Stage 4: session lifecycle control

`/fork`, `/resume`, and `/exit` (alias `/quit`) are now native web commands, handled by
`src/web-server/session-owner.lifecycle.ts`. All three run inside the command route's
`reserveTurn`/`releaseTurn` bracket.

**`/fork`** — calls `forkStoredSession` (same helper the REPL uses) to write a sidecar fork,
copies the message journal, then calls `SessionOwner.create()` with a resume config built from
the fork sidecar. Returns `{ kind: 'navigate', sessionId }` pointing at the new session.
Dashboard selects it. Clipboard and terminal-spawn paths are replaced by navigate; no
`navigator.clipboard` is needed.

**`/resume`** (no arg) — emits a structured `list` block of saved sessions via the Stage 2
block helpers. Returns `continue`.

**`/resume <id-or-name>`** — finds the stored session, guards against resuming the live session
(same SDK-id check as the REPL), then calls `SessionOwner.create()` with `resumeConfigFor()`.
Returns `{ kind: 'navigate', sessionId }`.

**`/exit` / `/quit`** — persists the sidecar with `closeTime: true, exitReason: 'exit-command'`
and returns `{ kind: 'exit' }`. Dashboard shows an inline notice and deselects the session.
The session object stays in the owner map until the next server restart so in-flight SSE tails
can drain.

**Resume button** — `SessionCard` renders a hover-reveal "Resume" button for `mode === 'readonly'`
sessions. Clicking it calls `handleResumeFromSidebar` in `app.tsx`, which issues
`/resume <id>` through a live session and navigates to the result.

**`useCommandControl` hook** — `composer.tsx` delegates all `CommandControl` dispatch to the
`dashboard/src/hooks/use-command-control.ts` hook, which handles `navigate` and `exit` in
addition to the existing kinds.

## Known limitations after Stage 2

- **No cancel route**: background job cancel requires a cross-process signal channel.
  The cancel button in the bg-jobs view is disabled with a tooltip directing the operator to
  use `/bgsub:cancel <id>` from the owning session.
- **Command output is client-local**: not persisted; lost on reload.
- **Session readiness poll**: `waitForSessionReady` polls `owner.getSession(id)` every 50ms
  up to 2s. If the session is not ready, it returns 503 `session_not_ready`; an owner
  readiness event remains future work.
- **Dynamic imports on hot path**: `ensureSlashRegistry` and registry imports are dynamic to
  keep the `cli/slash` tree off the server's startup path. These will be hoisted to
  module-top once the route is opt-in (server.ts already routes lazily).
