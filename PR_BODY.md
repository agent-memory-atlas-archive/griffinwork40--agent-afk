## Summary

- Expose `cwd`, `readRoots`, and `writeRoots` as per-node fields on the compose tool schema, giving DAG nodes parity with the `agent` tool for filesystem targeting
- Before this change, compose nodes all inherited the parent session's cwd with no override — parallel subagents in a monorepo had no runtime enforcement mechanism
- Structural validation (absolute paths, no `..` segments, correct types) extracted into `compose-input-parse.ts`; runtime breadth guards (`isTooBroadRoot`, `ungatedSensitiveRoot`) remain in `dag-subagent.ts` (unchanged)
- `parseComposeInput` extracted into a dedicated sibling module to keep `compose-executor.ts` under the 350-LOC ceiling

## Test results

- `pnpm test`: 20,173 passed | 26 skipped — 0 failures (1,028 test files, 48.75s)

## Verification

Adversarial verifier (context-blind re-derivation from diff alone):

- Claim 1 — "No per-node path override existed before": **CONFIRM** — `ComposeNodeInput` previously had only `id`, `prompt`, `model`; the spread at `compose-executor.ts` line ~590 is the first time these fields reach the DAG layer.
- Claim 2 — "Structural validation in `compose-input-parse.ts`, breadth guards in `dag-subagent.ts`": **CONFIRM** — `parseNodePaths()` and `parseRootArray()` perform absolute-path and `..`-segment checks; `dag-subagent.ts` is untouched by the diff.
- Claim 3 — "Extracted to respect 350-LOC ceiling": **REFINE** — extraction is structurally real and sound; the ceiling value itself requires external project knowledge (AFK.md) to verify but is consistent with the project convention.

## Out of scope

All three fields default to `undefined` (inherit parent), preserving existing behavior. No changes to `dag-subagent.ts` runtime validation.
