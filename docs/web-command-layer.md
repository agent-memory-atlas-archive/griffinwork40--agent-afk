# Web Command Layer — Architecture

> Stages 0–3 of the Web↔CLI Parity Command Layer (PATH_B: surface-agnostic command layer, staged).

## Stage 1: capabilities and canonical session controls

Command availability is derived from `SlashCommand.requires` and the surface's positive
capability set (`src/cli/slash/capabilities.ts`). Fork/resume and exit/quit retain explicit
lifecycle-stage deferrals; `/rewind` and bare `/model` now use web choices. GET `/api/commands`
keeps its existing wire shape.
The REPL declares actual TTY availability; web advertises session control and choice/progress,
not terminal access.

`src/agent/session-control/` owns reset, compaction hooks, model/name/preferences and shared
usage/token/context/MCP reads. Busy admission stays with callers. REPL handlers retain their
formatting and terminal interaction adapter; web sends live progress over SSE without ora.

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
| `src/web-server/shared/command-wire.ts` | Server-side command response/control types; browser mirror in `dashboard/src/types/command-wire.ts` |
| `src/cli/slash/interaction.ts`, `interaction.repl.ts` | Surface-neutral choice/progress contracts and REPL selector/spinner adapter |
| `src/web-server/choice-broker.ts`, `shared/choice-wire.ts`, `routes.choices.ts` | Ephemeral choice/progress SSE fan-out, validated answer route and wire |

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
| `exit` | show inline notice (no effect on web in Stage 0) |
| `forward` | re-POST original input to `/prompt` |
| `rerun` | re-POST `control.input` to `/commands` |
| `submit` | submit `control.message` as a new prompt |
| `prefill` | set composer text to `control.message` without submitting (e.g. after rewind) |

## Capability admission

Commands rejected by `command-gate.ts` return HTTP 409 `command_gated` with a human-readable
reason. `requires: SurfaceCapability[]` and the web capability set replace the Stage 0 flat
list. Terminal-only requirements remain unavailable; fork/resume and exit/quit retain explicit
lifecycle gates. The web context supports the shared choice/progress interaction contracts.
The registry enforces requirements for explicitly declared surfaces while preserving
compatibility with older contexts.

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

## Stage 3: choices, progress and rewind

`ChoiceRequest` is JSON-safe: `{ corrId, title, options: [{ value, label, description? }],
default?, cancellable? }`. `Choose` resolves to an option value or `null`; `ProgressEvent`
uses the same correlation key with `phase: 'start' | 'update' | 'end'`, `label`, and optional
normalized `fraction`. The REPL adapter presents a selector and compositor/terminal spinner;
web injects `choose` and `progress` through the session-scoped broker. Bare `/model` uses
this picker; `/model <name>` still switches directly. `/rewind` chooses a target and returns
`prefill` on success. `/compact` sends live progress only when compaction actually starts.

Web SSE sends `choice_request`, `progress`, and `choice_settled` **without ledger IDs**: these
are ephemeral, never persisted or included in durable cursor replay. The browser keeps dialog
and progress state locally. The broker fans out to connected tabs, snapshots pending choices
on subscription and again after a ledger reset; settlement dismisses the choice in all tabs.
An answer is `POST /api/sessions/:id/choices/:corrId` with `{ "value": "option-value" }`
or `{ "value": null }` when cancellable. Authentication/Origin checks precede the route;
the broker checks the owning session and allowed option value. Unanswered choices settle
`null` after 120 seconds, on session close, the last stream disconnect, or command request
disconnect. A lost browser connection does not turn choice/progress into journal state.

Web rewind verifies and flushes the live journal before provider mutation, then folds the
**display** journal (not the model/compaction fold) to retain historical visible turns,
including thinking/tool records. It seals the old writer and atomically replaces the stable
browser ledger projection; generation-qualified SSE cursors and reset frames rebase open
and reconnecting tabs, and subsequent turns continue on the new projection. Reconstructed
`done` boundaries have no invented cost/duration; cumulative billing remains unchanged.
An unavailable or inconsistent journal fails closed rather than rewinding only the provider.

## Known limitations after Stage 3

- **No cancel route**: background job cancel requires a cross-process signal channel.
  The cancel button in the bg-jobs view is disabled with a tooltip directing the operator to
  use `/bgsub:cancel <id>` from the owning session.
- **Command output and interactive choice/progress state are client-local**: not persisted; lost on reload (active pending choices can be re-sent on SSE subscription).
- **Session readiness poll**: `waitForSessionReady` polls `owner.getSession(id)` every 50ms
  up to 2s. If the session is not ready, it returns 503 `session_not_ready`; an owner
  readiness event remains future work.
- **Dynamic imports on hot path**: `ensureSlashRegistry` and registry imports are dynamic to
  keep the `cli/slash` tree off the server's startup path. These will be hoisted to
  module-top once the route is opt-in (server.ts already routes lazily).
- **Stage 4/5 deferred**: web fork/resume/exit session lifecycle and Telegram migration are not implemented here.
