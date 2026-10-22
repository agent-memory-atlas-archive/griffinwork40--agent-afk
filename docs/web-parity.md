# Web ↔ REPL parity matrix

The `afk web` browser surface aims at feature and UX parity with the interactive REPL. This file is the
contract that defines "parity": every REPL capability has a row, and every row ends as **DONE** (backed by a
test) or **N/A** (with a reason). Architecture: see the command-layer ADR summarized in
[`docs/web-command-layer.md`](web-command-layer.md) once it lands; until then the decision record is PATH_B,
"surface-agnostic command layer, staged".

Status legend: **DONE** works on web with a test · **TEXT** runs on web, plain/ANSI text output only ·
**GATED** refused on web with a clear reason · **PASS** sent to the model as text (bug: the command never runs) ·
**MISSING** no web path · **N/A** not meaningful in a browser (reason given).

Target column = the stage that delivers the row (S0 generic command route + text capture, S1 capabilities +
session-control service, S2 structured output blocks + renderer registry, S3 choice-requests + progress events,
S4 session lifecycle, S5 Telegram adoption, UX = dashboard-native work).

Baseline measured 2026-10-21 on main @ 1c846bee0.

Stage 1 update: `/clear`, `/model <name>`, `/name`, `/thinking`, `/fast`, and `/compact`
now execute canonical session controls on web. `/model` without arguments prints current
model and available aliases as text; the terminal picker remains REPL-only. Clear also resets
the browser transcript and command outputs across connected tabs. Usage/tokens/context/MCP
reads share the canonical service; Stage 2 renders usage/tokens/MCP through structured blocks. Capability requirements replace
the Stage 0 flat gate list. Rows below retain future UX targets; no pickers, fork/resume or
Telegram adoption were added in Stage 1.

## Slash commands (58 built-in)

| Command | REPL class | Web now | Target | Web form |
|---|---|---|---|---|
| /help | portable | DONE | S2 | structured command list, preserving REPL registry order |
| /info | portable | DONE | S2 | new read-only session key-value summary |
| /cost | portable | TEXT | S0 → S2 | keyValue block; session meter already shows cost |
| /tokens | portable | DONE | S2 | keyValue panels + category table; local fallback |
| /history | portable | TEXT | S0 | text (transcript view already covers display) |
| /tools | portable | TEXT | S0 → S2 | list |
| /mcp | portable | DONE | S2; dedicated view UX | server/status table; auth links |
| /limits | portable | TEXT | S0 → S2 | table |
| /debug | portable | TEXT | S0 | text |
| /usage | portable | DONE | S2; dedicated view UX | quota keyValue panel (5h/7d windows); unavailable warning |
| /todo | portable | TEXT | S0 + UX | todo panel above composer |
| /goal | portable | TEXT | S0 + UX | goal chip in session header |
| /name | portable | DONE | S1 | canonical rename updates sidebar and session title |
| /fork | portable | DONE | S4 | creates new owned session + navigate control; dashboard selects the fork |
| /changelog | portable | TEXT | S0 | text |
| /bgsub, /bgsub:status, /bgsub:join, /bgsub:cancel | portable | TEXT | S0 + UX | jobs view (cancel route deferred) |
| /tasks | partial | TEXT | S0 (list) → UX | subagent tree already in transcript; list as text |
| /tasks:view | tty-only | TEXT | UX | open subagent card in the transcript spine |
| /tasks:cancel | portable | TEXT | S0 | button on subagent card |
| /sh | portable | GATED | S1 | background process list in jobs view |
| /init | portable | GATED | S1 | writes through its own console writer instead of the command output; gated until it uses ctx.out |
| /stats | portable | TEXT | S0 → S2 | table |
| /font-size | portable | GATED | N/A | edits VS Code/Cursor terminal settings; browser zoom covers web |
| /allow-dir | portable | TEXT | S0 | text; later a settings section |
| /worktree | portable | DONE (list) | S2 | list table; other actions retain text |
| /reauth | portable | GATED | S1 | settings action |
| /search | portable | TEXT | S0 + UX | transcript find (Cmd+F within session) |
| /diff | portable | DONE | S2 | structured unified diff; empty-state message |
| /doctor | portable | TEXT | S0 → S2 | checklist |
| /spine | portable | TEXT | S0 | text |
| /whatif | portable | TEXT | S0 | text with progress |
| /good, /bad | portable | TEXT | S0 | message actions (thumbs) |
| /bug | portable | TEXT | S0 | link block |
| /inbox | portable | TEXT | S0 + UX | peers/inbox panel |
| /peers | portable | TEXT | S0 → S2 | peers panel |
| /export | portable | TEXT | S0 | download link (md/html) |
| /handoffs, /handoffs:answer | portable | TEXT | DONE (view) | handoffs view exists; command form S0 |
| /keys | portable | GATED | UX | web keyboard-shortcut sheet (?) |
| /exit, /quit | session-control | DONE | S4 | marks session ended (sidecar closeTime); dashboard shows inline notice, deselects session |
| /clear | session-control | DONE | S1 | resets conversation and command outputs across tabs; retains confirmation |
| /compact | session-control | DONE | S1 → S3 | canonical compaction with buffered progress; live progress deferred |
| /plan | session-control | GATED | S1 | mode toggle in composer; requires session-control service |
| /afk | session-control | GATED | S1 | mode toggle in composer; requires session-control service |
| /thinking | session-control | DONE | S1 | authoritative per-session thinking display preference |
| /fast | session-control | DONE | S1 | canonical command backed by live provider fast controller |
| /theme | session-control | GATED | UX | dashboard light/dark/auto theme |
| /retry | session-control | GATED | S1 | retry action on last message; requires session-control service |
| /model | partial | DONE (arg/read) | S1 → S3 (picker) | authoritative selector/header/sidebar updates; bare command lists aliases |
| /resume | partial | DONE | S4 | bare: structured list block; /resume <id>: creates owned resumed session + navigate; Resume button on sidebar cards |
| /transcript | partial | TEXT | S0 | text; transcript view already exists |
| /afk-md | partial | TEXT | S0 (show/reload/add) | `user`/`project` edit subcommands → UX editor |
| /config | partial | TEXT | S1 (view/set) → UX | editable settings view |
| /rewind | tty-only | GATED | S3 | choice-request picker; "rewind to here" on a user message |
| /editor | tty-only | GATED | N/A | the browser composer is already a full editor |
| /copy | tty-only | TEXT | UX | copy buttons on messages and code blocks (partly DONE) |
| /ghost | tty-only | GATED | N/A | terminal ghost-text; web uses native autocomplete |
| /suggestions | tty-only | GATED | UX | composer history (↑/↓); native browser autocomplete preferred |

Skill commands (plugin, user, builtin, marketplace): **DONE** via `classifySlashInput` (same pipeline as the REPL).

## Interaction features

| REPL feature | Web now | Target | Web form |
|---|---|---|---|
| Streaming markdown, tool cards, diffs, thinking | DONE | | |
| Interrupt (Ctrl+C) | DONE | | Stop button |
| Queued messages while busy | DONE | | queue panel (reorder/edit) |
| Approvals: confirm/text/choice/multi_choice | DONE | | approval cards |
| Approvals: number | DONE | S0 | number input card |
| @file mentions | DONE | | |
| Slash autocomplete | DONE | | |
| Image paste / attach (Ctrl+V) | MISSING | UX | paste/drop/upload images |
| `!cmd` shell passthrough, `!&` background | MISSING | UX | `!` prefix in composer, server-side shell job |
| Ctrl+B background a turn | MISSING | UX | "send to background" action |
| Multi-line input, history ↑/↓ | PARTIAL | UX | Shift+Enter exists; add history |
| Permission-mode cycle (Shift+Tab) | MISSING | S1 | mode switcher in composer |
| Status line (model, context %, cost, mode, quota) | PARTIAL | UX | session header meter |
| Model selector | DONE | S1 | create and authoritative mid-session switching |
| Peer inbox delivery / idle wake | N/A | | REPL-owned sessions; web sessions read peers via panel |
| Resume / continue a stored session | DONE | S4 | /resume <id> or sidebar Resume button; creates a new live session from stored sidecar |
| Retry / edit a sent message | MISSING | S1 / S3 | |
| Message timestamps | MISSING | UX | |
| Terminal title, worktree exit picker | N/A | | tab title per session; worktree panel |

## Views

| View | Web now | Target |
|---|---|---|
| Sessions sidebar | DONE | |
| Memory | DONE | |
| Schedules | DONE | |
| Handoffs | DONE | |
| Background jobs | PARTIAL — list/detail DONE; cancel DEFERRED (disabled button with tooltip: "Cancel from the owning session with /bgsub:cancel <id>"; needs cross-process channel) | S1 |
| Settings | READ-ONLY | S1 + UX (editable) |
| Usage / quota | MISSING | S2 + UX |
| Trace viewer | MISSING | UX |
| MCP servers | MISSING | S2 + UX |
| Plugins / skills / marketplace | MISSING | UX |
| Peers / inbox | MISSING | UX |
| Worktrees | MISSING | S2 + UX |
