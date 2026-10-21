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

## Slash commands (58 built-in)

| Command | REPL class | Web now | Target | Web form |
|---|---|---|---|---|
| /help | portable | TEXT | S0 → S2 | command palette + text |
| /cost | portable | TEXT | S0 → S2 | keyValue block; session meter already shows cost |
| /tokens | portable | TEXT | S0 → S2 | keyValue/table |
| /history | portable | TEXT | S0 | text (transcript view already covers display) |
| /tools | portable | TEXT | S0 → S2 | list |
| /mcp | portable | TEXT | S0 → S2 + UX | MCP panel (servers, status, pending OAuth URLs) |
| /limits | portable | TEXT | S0 → S2 | table |
| /debug | portable | TEXT | S0 | text |
| /usage | portable | TEXT | S0 → S2 + UX | quota panel (5h/7d windows) |
| /todo | portable | TEXT | S0 + UX | todo panel above composer |
| /goal | portable | TEXT | S0 + UX | goal chip in session header |
| /name | portable | GATED | S1 | inline rename in sidebar; requires session-control service |
| /fork | portable | GATED | S4 | new owned session + navigate; browser clipboard |
| /changelog | portable | TEXT | S0 | text |
| /bgsub, /bgsub:status, /bgsub:join, /bgsub:cancel | portable | TEXT | S0 + UX | jobs view (cancel route deferred — A3) |
| /tasks | partial | TEXT | S0 (list) → UX | subagent tree already in transcript; list as text |
| /tasks:view | tty-only | TEXT | UX | open subagent card in the transcript spine |
| /tasks:cancel | portable | TEXT | S0 | button on subagent card |
| /sh | portable | GATED | S1 | background process list in jobs view |
| /init | portable | GATED | S0 | requires interactive stdin; gated pending TTY-free refactor |
| /stats | portable | TEXT | S0 → S2 | table |
| /font-size | portable | GATED | N/A | edits VS Code/Cursor terminal settings; browser zoom covers web |
| /allow-dir | portable | TEXT | S0 | text; later a settings section |
| /worktree | portable | TEXT | S0 → S2 | table |
| /reauth | portable | GATED | S1 | settings action |
| /search | portable | TEXT | S0 + UX | transcript find (Cmd+F within session) |
| /diff | portable | TEXT | S0 → S2 | diff block via existing diff viewer |
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
| /exit, /quit | session-control | GATED | S4 | close session tab |
| /clear | session-control | GATED | S1 | reset button + command |
| /compact | session-control | GATED | S1 → S3 | command with live progress |
| /plan | session-control | GATED | S1 | mode toggle in composer; requires session-control service |
| /afk | session-control | GATED | S1 | mode toggle in composer; requires session-control service |
| /thinking | session-control | GATED | S1 | thinking display toggle |
| /fast | session-control | GATED | S1 | toggle in composer |
| /theme | session-control | GATED | UX | dashboard light/dark/auto theme |
| /retry | session-control | GATED | S1 | retry action on last message; requires session-control service |
| /model | partial | GATED | S1 (arg) → S3 (picker) | composer model selector (wired to the session) |
| /resume | partial | GATED | S4 | sidebar: take over a stored session |
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
| Model selector | DONE (create) | S0 | wired to create; mid-session switch S1 |
| Peer inbox delivery / idle wake | N/A | | REPL-owned sessions; web sessions read peers via panel |
| Resume / continue a stored session | MISSING | S4 | |
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
| Background jobs | PARTIAL (cancel deferred; needs cross-process channel — A3) | S0 |
| Settings | READ-ONLY | S1 + UX (editable) |
| Usage / quota | MISSING | S2 + UX |
| Trace viewer | MISSING | UX |
| MCP servers | MISSING | S2 + UX |
| Plugins / skills / marketplace | MISSING | UX |
| Peers / inbox | MISSING | UX |
| Worktrees | MISSING | S2 + UX |
