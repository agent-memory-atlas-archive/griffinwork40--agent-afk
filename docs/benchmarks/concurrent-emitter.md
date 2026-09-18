# Concurrent-Emitter Trace Integrity

**Benchmark ID:** concurrent-emitter-v1
**Status:** Initial results published
**Date:** 2026-09-17
**Contract ref:** `docs/philosophy/afk-contract.md` -- "Every tool call (name, input size, result size...)"

---

## What is being tested

The single-writer trace-completeness benchmark proved that `NdjsonTraceWriter`
events survive `kill -9` for one writer. Production routinely runs 5-10 parallel
sessions on the same machine -- daemon compose waves, concurrent REPL + Telegram
\+ cron jobs, or a `compose` DAG with N parallel subagent nodes.

Each session writes to its own `trace.jsonl` through its own `NdjsonTraceWriter`
instance. The writers share the kernel page cache and the I/O scheduler. This
benchmark answers: **does the flush-survives-kill property degrade when 10
writers contend for kernel I/O resources simultaneously?**

The threat model is not cross-file corruption (each writer opens its own
`O_APPEND` handle) but I/O-scheduler contention: could 10 concurrent
`appendFile` calls delay kernel page-cache commits enough that a SIGKILL
arrives before all completed writes are flushed?

---

## Test methodology

A single child process (spawned via `tsx`) creates 10 `NdjsonTraceWriter`
instances, each writing to a separate `trace.jsonl` in a separate directory.
Writers run concurrently via `Promise.all`. Each event's `toolUseId` is tagged
with the writer's identity (`w0-t0`, `w3-t2`, etc.) to detect cross-writer
contamination.

After all writes complete, the child signals `READY`. The parent immediately
sends `SIGKILL`. Post-kill, each of the 10 trace files is read back and
verified independently.

| Scenario | Setup | Kill timing |
|---|---|---|
| `all-complete` | 10 writers, 5 pairs each (100 events total), all awaited | After all 100 events flushed |
| `mid-write` | 10 writers, 3 awaited pairs + 5 unawaited pairs each | Kill races 100 in-flight writes across 10 writers |
| `staggered-start` | 10 writers, even start immediately, odd start 50ms late | After all writers finish |

Verification per writer:
- **Event count**: recovered events vs expected
- **Seq monotonicity**: `seq` strictly increasing across all recovered events
- **No cross-contamination**: every `toolUseId` matches the writer's tag
- **No seal**: `session_sealed` absent (expected under SIGKILL)

---

## Success criteria

| Metric | Target | Notes |
|---|---|---|
| Pre-signal event survival | 100% per writer | Each writer's completed writes must survive independently |
| Cross-writer contamination | 0 events | Writer N's events must never appear in writer M's file |
| Seq monotonicity | true per writer | Each writer's seq counter is independent and must be strictly increasing |
| NDJSON integrity | 100% parseable | Partial last lines from interrupted writes are skipped; preceding lines must parse |
| Sealed-clean rate | 0% | Expected under SIGKILL -- exit handler cannot run |

---

## How to run

```bash
pnpm test src/agent/trace/concurrent-emitter.bench.test.ts
```

The benchmark is deterministic (no network, no real AFK session). Each scenario
spawns and kills a single child process containing 10 concurrent writers. Total
runtime is approximately 1 second.

---

## Results (2026-09-17)

Run environment: Node.js v24.11.0, macOS (darwin), tmpfs temp dir.

| Scenario | Writers | Expected (min) | Recovered | Completeness | Monotonic | Tagged | Sealed |
|---|---|---|---|---|---|---|---|
| all-complete | 10 | 100 | 100 | **100%** | all true | all true | none |
| mid-write (racing) | 10 | 60 | 160 | **100%+** | all true | all true | none |
| staggered-start | 10 | 100 | 100 | **100%** | all true | all true | none |

**All pre-signal events recovered across all 10 writers in every scenario. Zero
cross-writer contamination. No NDJSON corruption. The flush-survives-kill
property does not degrade under concurrent I/O contention.**

### Interpretation

Each `NdjsonTraceWriter` opens its own file handle with `O_APPEND`. The handles
are independent at the kernel level -- different vnodes, different page-cache
ranges. The kernel flushes ALL dirty pages on process exit (even under SIGKILL),
not just those belonging to a single file. Ten concurrent writers create ten
independent dirty-page ranges; the kernel flushes all of them.

The `mid-write` scenario is the strongest test: 100 in-flight writes (10 writers
x 5 unawaited pairs x 2 events) race the SIGKILL. The test recovered 160 events
(60 guaranteed pre-signal + 100 post-signal that landed before the kill). Even
in the race window, per-writer monotonicity held and no partial writes corrupted
the NDJSON.

The `staggered-start` scenario verifies that writers joining the I/O pool at
different times (simulating subagents spawning during a compose wave) do not
affect already-running writers. All 10 writers recovered their full event sets.

The `tagged` column is the cross-contamination guard. Every `tool_call` event in
each writer's trace file carries the correct writer prefix in its `toolUseId`.
A value of `true` for all writers proves that no file handle wrote to the wrong
trace file -- which is expected (each writer has its own `FileHandle`) but now
verified under kill-signal stress.

---

## Gaps and open questions

1. **Shared-file concurrent writers not tested.** This benchmark uses separate
   files per writer (the production pattern). A pathological case where multiple
   writers share a single `trace.jsonl` (e.g., a bug in session-label resolution)
   is not covered. The writer's own `O_APPEND` atomicity guarantees per-line
   integrity even in this case, but interleaved seq numbers would break
   monotonicity.

2. **Very high writer counts not tested.** 10 writers matches the common
   production ceiling (daemon compose waves). Extreme fan-outs (50+ writers)
   would stress the I/O scheduler differently but are not a realistic scenario.

3. **Filesystem-full behavior not tested.** If the disk runs out of space
   mid-batch, `appendFile` errors are swallowed per writer (only the first
   failure is surfaced). The benchmark does not cover this degraded case.

---

## Related benchmarks

- [Trace Completeness Under kill -9](./trace-completeness.md) -- single-writer
  version of this benchmark; proves the baseline property this benchmark extends.
- [Abort-Cascade Correctness](./abort-cascade.md) -- validates abort propagation
  topology; in production, an abort cascade triggers across the same concurrent
  sessions whose traces this benchmark stresses.
- [Crash-to-Resume DAG Checkpoint](./crash-to-resume.md) -- validates checkpoint
  correctness for the DAG executor that dispatches the parallel subagents whose
  traces this benchmark models.
