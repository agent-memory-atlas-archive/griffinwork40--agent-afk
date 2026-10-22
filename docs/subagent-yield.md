# Subagent Yield (proposed)

Status: **design, not implemented.** Decided in a 2026-10-22 session after two
devils-advocate passes and one composition-boundary check. The second pass's
recommendation folds in the boundary check's findings but has not had a second
boundary check yet (see Open questions).

## Problem

A foreground subagent that hits a question only its parent can answer has no
structured way out. Today:

- Forks are non-interactive by default, so `ask_question` is stripped from the
  child toolset (`src/agent/subagent/fork-child-config.ts:379-387`).
- The identity preamble tells non-interactive children to "proceed on the most
  reasonable assumption, or stop, and put the open question in your reply"
  (`src/agent/subagent/identity-preamble.ts:116-121`). That is an informal
  yield: the escape hatch exists, but the parent gets unstructured prose and no
  resume handle.
- Model-owned steering (`send_message_to_agent`) covers background children
  only. Foreground children are steered by the human alone
  (`docs/subagent-steering.md`).

## Decision 1: yield-and-resume, not a live channel

Foreground children get **child-initiated yield-and-resume**. They do not get a
live bidirectional channel with the parent model.

Why not a live channel: while a foreground child runs, the parent model is
suspended inside its own `agent` tool call. There is no parent turn to receive a
message or produce a reply, and the Messages API requires each `tool_use` to be
followed immediately by its `tool_result`, so the parent cannot take a turn in
the middle of the call. Progress events confirm the constraint: they reach the
parent "at its next user-turn boundary"
(`src/agent/subagent/fork-progress-events.ts:66`), which a blocked foreground
parent does not have until the child returns. A design where the child waits
for a parent-model answer deadlocks until the idle watchdog or the wall clock
kills it.

Live two-way messaging stays with background agents (#1418), where the parent
really is free.

### Shape of a yield

1. The child ends its turn with a question.
2. The runtime returns a typed `needs_input` result as the parent's normal
   `agent` tool_result. It always contains the question, a self-contained
   summary of the work done so far, and the child's full final text. It contains
   a `continuation_chain_id` only when the chain is actually continuable.
3. The parent either continues the chain with its answer, or re-dispatches a
   fresh child with the summary plus the answer. The parent also decides
   whether to escalate to the human; children never reach the operator directly.
4. A yielding child gives up its concurrency slot and its wall-clock and idle
   budgets. A paused child holds nothing.

### Amendments from the first critique

- **Always self-contained.** Many chains cannot be resumed: worktree-isolated
  chains are `continuable: false`, compose nodes refuse `continuation_chain_id`,
  and all chains are in-memory only, lost on restart and `/resume`
  (`docs/subagent-continuation.md:140,159-163`). Because every yield carries a
  summary written for a stranger, the fresh-re-dispatch path covers all of
  these. The runtime, not the child, decides which path applies.
- **Typed result.** `needs_input` vs `result` is an explicit discriminator so a
  parent cannot read a pause as a final answer.
- **Runtime-enforced cap.** 1 to 2 yields per chain, counted by the runtime,
  not left to prompt wording.

Remaining dissent: chains are in-memory only, so resume is fragile in long
sessions. The self-contained summary limits the damage: losing a chain costs
history, not the answer.

## Decision 2: how children learn about it

Children are told, but through conventions they already have, **not a new
tool**. All three critics in the second pass independently rejected a dedicated
`ask_parent` tool.

1. **Wire format: the existing Asking terminal state.** A child yields by
   ending with an **Asking** block (question, the assumption it resolves, what
   happens once answered) plus a short work summary. The agent-layer parser
   already extracts the question (`src/agent/outcomes/terminal-state.ts:200,423`).
   Nothing upstream fights a child that ends on Asking: the stop-hook seam is a
   no-op for forks (`src/agent/providers/shared/stop-hook-continuation.ts:214`),
   and the terminal-state gate only acts on `done`
   (`terminal-state-gate.ts:92`).
2. **Teaching: one conditional preamble paragraph.** It replaces
   `identity-preamble.ts:119-120` when, and only when, the runtime will honor a
   yield for this child. It states the real cost (asking ends your turn; you may
   resume with history or a fresh child may continue from your summary), tells
   the child to write question and summary for a stranger, sets the bar at
   information only the parent holds (user intent, the original conversation,
   sibling findings, never anything the child's own tools can answer), and shows
   the remaining yield count. Leaving the paragraph out is as honest a
   capability signal as leaving out a tool, and it follows the preamble's
   existing rule that every line is derived from the child's resolved config.
3. **Parent side ships in the same change.** The `agent` tool description
   documents `needs_input` and how to answer it (continue the chain, or
   re-dispatch with the summary). A child that yields to a parent that does not
   recognise the result is the main misread risk.

### Why the tool lost

The problems a tool would solve (result shape, interception point, nested yield
cascades) are the same either way. The convention reuses wording and parsing
that already exist, and its failure mode is graceful: a missing or malformed
Asking block falls through as an ordinary final reply, which is today's
behavior. A tool stays available as a purely additive follow-up if traces show
children under-yielding or false positives causing real harm.

## Implementation constraints (from the boundary check)

- **There is no single ToolResult choke point.** The foreground path
  (`foreground-handoff.ts:161-167`, plus the promotion path in
  `foreground-promotion.ts:162-164`) and the compose path
  (`dag-subagent.dispatch.ts:85,164`) assemble results independently. Detect
  once where the `SubagentResult` is built (`buildSuccessResult` in
  `src/agent/subagent/result.ts`), tag it, and have every assembler honor the
  tag. Intercepting in one assembler alone silently misses compose children.
- **Bypass output schemas.** Tagging must happen before Zod `outputSchema`
  validation (`src/agent/subagent/handle.ts:240`,
  `handle.streaming.ts:376-399`). A yielding child cannot also satisfy a schema,
  so an Asking result must skip validation rather than surface a spurious
  `schemaError`.
- **Guard false positives.** `parseTerminalState` is tail-anchored and
  fenced-code-aware but not blockquote-aware, so a child that quotes another
  agent's Asking block near its tail could be misdetected. Require Asking to be
  the last terminal heading and reject blockquoted headings. Because
  `needs_input` always carries the full final text, a misdetection degrades to
  today's output plus a label.
- **Compose.** A compose node cannot be resumed, so a yield there means
  fresh-re-dispatch semantics or yields off by default for nodes. Downstream
  nodes must never silently consume a yield as a complete result.
- **Facets are unaffected.** A child's Asking block arrives inside a
  tool_result in a user-role message, which `src/agent/facets/derive.ts` does
  not scan as the parent's own terminal state.

## Open questions

1. A second composition-boundary check on the revised design, scoped to the
   `buildSuccessResult` tag and its consumers.
2. Whether forks inherit the parent's assembled system prompt. The full
   Done/Blocked/Asking block format is added only on the `repl` and `telegram`
   surfaces (`src/agent/routing-directive.ts:151-170`), and
   `fork-child-config.ts:297` reads `options.config.systemPrompt` without making
   it obvious which prompt that is. If forks do not inherit it, the preamble
   paragraph must spell out the Asking block format itself.
3. Whether compose nodes get yields at all in v1, or stay on today's wording.

## Related

- `docs/subagent-steering.md`: human-owned foreground and model-owned
  background steering.
- `docs/subagent-continuation.md`: continuation chains and their limits.
- #1418: addressable agent messaging for running (background) agents.
- #3897: mid-turn user steering at every tool-round boundary.
