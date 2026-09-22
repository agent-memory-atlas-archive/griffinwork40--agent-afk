# Throughput Inflection Audit: September 15-22, 2026

**Audit date:** 2026-09-22  
**Window:** Sept 8-14 (baseline) vs Sept 15-22 (post-inflection)  
**Method:** Five parallel investigation probes covering merge quality, issue backlog, causal attribution, PR substance, and waste/duplication. All evidence from repository history, GitHub API, and session artifacts.

---

## Executive Summary

The throughput increase is real but overstated by raw metrics, accompanied by measurable quality tradeoffs, and primarily caused by a merge-loop acceleration -- not the parallel-first prompt change that was previously credited.

| Metric | Pre (Sept 8-14) | Post (Sept 15-22) | Honest multiple |
|--------|-----------------|-------------------|-----------------|
| PRs merged | 44 | 173 | **~3x** after discount |
| Substantive PRs | ~25 | ~85 | **~3.4x** |
| Issues created | 5 | 149 | ~2x at human granularity |
| Commits/day peak | 10 | 99 | inflated by release tags |
| Human review rate | 70% | 45% | **-25pp** |

**The inflection is genuine engineering velocity, not theater.** But ~18% of PRs are marginal/batchable, the issue count is ~2-3x what human-granularity filing would produce, and the human review gate was bypassed at twice the pre-period rate.

---

## 1. What Materially Changed

### The merge feedback loop compressed by 11.6x

The single largest structural change was **PR #1703** (merged Sept 17): `/review` gained the ability to auto-merge clean docs/test PRs. Median time-to-merge dropped from **20.8 hours to 1.8 hours** on the exact day it landed. This is the primary throughput multiplier -- more PRs fit in a day when they merge in 2 hours instead of 21.

### The fix-pr cycling bottleneck was removed

**PR #1680** (merged Sept 16) fixed `/fix-pr` review cycling. Before this, the `/review -> /fix-pr -> /review` loop consumed 2-5 agent rounds per PR. After, each PR typically needed one pass.

### The parallel-first prompt change was contributory, not causal

**PR #1676** (merged Sept 15) changed 14 lines of prompt to say "parallel by default" instead of "parallelize when appropriate." However:

- The daemon was already running worktree-based issue dispatch **before Sept 6** (confirmed by 28 abandoned daemon worktrees accumulated across serial hourly cron runs Aug 18 - Sept 7)
- Sept 15 itself had only **4 PRs created** -- the lowest of any day in the window
- The sharp inflection is Sept 17 (63 commits), not Sept 15 (19 commits)
- The compose DAG executor, worktree isolation, and 8-concurrent ceiling were all operational before the prompt change

**Verdict:** #1676 reinforced a behavioral posture the infrastructure already supported. It may have increased the frequency of parallel dispatch in interactive sessions, but it cannot explain the 3x throughput jump. The merge-loop acceleration (#1703) and the trough-rebound effect are stronger explanations.

### A feature-consolidation trough inflated the "before" baseline

Sept 11-14 was an anomalous low: the React dashboard consolidation (PRs #1633-1640) concentrated work into large multi-day branches, suppressing parallel dispatch. The Sept 15+ recovery is partly a **rebound from an artificial trough**, not purely a step-change to a new regime.

---

## 2. Strongest Supporting Evidence (for real improvement)

1. **PR substance holds up under sampling.** Of 164 post-inflection PRs: ~52% are substantive new capabilities or important fixes, ~30% are moderate improvements, ~18% are marginal/batchable. After discounting marginal PRs, the count is ~134 -- still a real 3x over baseline.

2. **No classic inflation mechanisms.** Zero `chore(release)` bumps in the PR count. Only 3 dependabot PRs. No prefabricated version-bump trains.

3. **Issue quality is high.** 92% of issues reference a merged PR. Issues have file:line citations, root cause analysis, and severity labeling. The 65% same-day close rate reflects fast task throughput, not create-and-close padding.

4. **Major capability PRs are genuinely substantial.** Delegation budget (#1894, 1344 lines), subagent runtime knowledge (#1997, 1061 lines), Tier 3 file-size extractions (#1755, 2896 lines), parallelized pre-dispatch gates (#1901, 655 lines), shell executor (#1719, 269 lines).

5. **91.5% of opened PRs merged.** Only 14 of 189 were closed without merge -- a low waste rate for the open-then-fix workflow.

---

## 3. Strongest Counterevidence and Confounders

### Review collapse is the dominant quality regression

| Signal | Pre | Post | Severity |
|--------|-----|------|----------|
| Zero-human-review merges | **30%** | **55%** | High |
| Owner review coverage | **70%** | **45%** | High |
| Fix-of-fix chain rate | 4.5% | 8.0% | Moderate |
| CI failures on merge | 7% | 12% | Moderate |
| Revert rate | 0% | 1% (3 reverts) | Low absolute |

**55% of post-inflection PRs merged with zero human review.** This is the mechanism through which all other quality gaps compound. The fix-of-fix chains, CI failures, and reverts concentrate in the zero-review bucket.

### Specific regression chains

- **TUI compositor:** #1670 (Sept 15) -> #1683 (test fix) -> #1684 (full revert Sept 16). 616 lines of churn to end up where you started.
- **Compose docs:** #1978 shipped with a misleading safety claim, reverted by #2001 1.3 hours later.
- **Executor validation:** Reverted and re-landed 3.5 hours later with a regression test that should have been in the original.

### PR fragmentation inflates count by ~1.5-2x

The Sept 22 compose burst (8 PRs for what is architecturally one feature) and the streaming UX series (phases 1/2/3 in 30 minutes) show work being split at agent granularity rather than logical-change granularity. ~29 PRs (18%) could have been batched with their parent PRs.

### Issue filing is ~2-3x over-granular

The midnight audit dump (31 issues in 90 minutes from one audit pass) and the compose per-node cluster (9 issues for one feature) are artifacts of agent tooling. A human would file ~10 issues for the same scope.

### Wasted work is measurable but bounded

- **14 closed-without-merge PRs** (~4,438 additions discarded)
- **1 fully abandoned feature** (marketing landing page, #1903, 1,687 lines -- silently dropped with zero human review)
- **1 lost stacked PR** (#1972, SEO P1, 293 lines -- base merged, stack never rebased)
- **~30-38% of implementation sessions** produced no merged artifact (note: no pre-period baseline exists, so this may reflect normal overhead rather than a regression)
- **157 stale `afk/` branches** on remote (never pruned after closure)

---

## 4. Quality/Cost Tradeoffs

| Dimension | Better | Worse | Net |
|-----------|--------|-------|-----|
| Throughput (substantive PRs/day) | 3x real improvement | -- | Positive |
| Latency (idea to merge) | 11.6x faster merge cycle | Rushed merges skip review | Mixed |
| Defect rate | Low absolute revert rate (1%) | Fix-of-fix doubled, CI failures +5pp | Slightly negative |
| Review coverage | Some PRs get deep multi-wave review | 55% get zero human review | Negative |
| Issue tracking | High linkage (92% to PRs), detailed bodies | 2-3x over-granular filing | Cosmetic |
| Waste | 91.5% PR merge rate is high | ~35% of sessions produce nothing; 1,687 lines silently abandoned | Moderate cost |
| Branch hygiene | -- | 157 stale agent branches on remote | Minor debt |

**The core tradeoff is velocity vs. review coverage.** The system trades human review for speed. At current scale (self-authored repo, single operator), this is likely acceptable -- the operator can sample-review rather than gate every merge. At team scale or on production systems, the 55% zero-review rate would be a serious concern.

---

## 5. Is the New Regime Genuinely Better?

**Yes, with caveats.**

**Better in:**
- Raw substantive output (~3x after honest discounting)
- Latency from finding to fix (hours instead of days)
- Test coverage generation (14.6% of PRs are test-only, addressing real gaps)
- Automated detection of technical debt (audit-driven issue filing)

**Worse in:**
- Human review coverage (-25pp)
- Fix-of-fix rate (+3.5pp, and qualitatively changed from additive to corrective)
- CI discipline (4 PRs knowingly merged into a red PTY test suite)
- Abandoned work visibility (no human saw #1903 die)

**Neutral/ambiguous:**
- Issue count (real work, inflated units)
- PR size distribution (smaller is easier to review, but not being reviewed)

The improvement is real for a solo operator iterating on their own system. The quality tradeoffs would become liabilities at team scale.

---

## 6. Causal Attribution Summary

| Cause | Evidence strength | Contribution estimate |
|-------|-------------------|----------------------|
| Review auto-merge (#1703, Sept 17) | **Strong** -- 14x merge-time compression, inflection aligns with merge date | Primary driver of sustained throughput increase |
| Trough rebound (Sept 11-14 dashboard consolidation) | **Strong** -- prior weeks (W34) had comparable velocity | Large confounder; significant fraction of apparent increase is baseline recovery |
| fix-pr cycling fix (#1680, Sept 16) | **Moderate** -- reduced per-PR overhead, freed agent capacity | Secondary driver |
| Parallel-first prompt (#1676, Sept 15) | **Weak** -- infrastructure was already parallel, inflection is Sept 17 not Sept 15, Sept 15 was lowest-creation day | Minor behavioral reinforcement |
| Daemon tackle/triage loop | **Moderate** -- serial hourly dispatch was already running since Aug 18 | Minor contributor |

**The original narrative ("14 prompt lines caused a 3x throughput increase") is substantially overclaimed.** The merge-loop acceleration is the primary driver.

---

## 7. Remaining Uncertainty and Suggested Instrumentation

### What we cannot determine from available evidence

1. **Whether the prompt change altered observable parallel dispatch frequency.** No before/after measurement of actual tool-call parallelism exists.
2. **The counterfactual:** If #1703 hadn't shipped Sept 17, would #1676 alone have produced a sustained increase?
3. **Per-session cost data:** Token/cost breakdowns are not available in the session store for this window.
4. **Whether a model upgrade or API change coincided with the inflection.** No model version change or API configuration change was observed in the CHANGELOG or config files reviewed; this confounder cannot be fully ruled out from repository artifacts alone.

### Suggested follow-up experiments

1. **Instrument parallel dispatch ratio.** Add a trace metric: `parallel_tool_calls / total_tool_calls` per session. This would let you measure whether the prompt change actually changed dispatch behavior.

2. **Track review-gated vs. auto-merged PRs.** Tag each merged PR with whether a human reviewed it. This is the most important quality signal to monitor going forward.

3. **Measure session yield rate.** Track `sessions_producing_merged_PR / total_implementation_sessions` as a persistent metric. The estimated 62-70% yield rate should be validated and trended.

4. **Add a regression-chain detector.** Flag PRs whose title references another PR merged in the same day. The fix-of-fix rate is the best leading indicator of review quality.

5. **Prune stale branches.** The 157 stale `afk/` branches on remote are dead weight. A periodic `git push --delete` sweep for branches whose PRs are closed would reduce clutter.

6. **A/B test the prompt change.** Temporarily revert #1676 for a week and measure whether throughput drops. If it doesn't, the prompt was cosmetic. If it does, the behavioral contribution is larger than the current evidence suggests.

---

*Audit methodology: 5 parallel investigation agents (merge quality, issue backlog, causal attribution, PR substance, waste/duplication), each with independent data collection and assessment. Full probe outputs preserved in session compose artifacts.*

*Post-audit corrections applied after shadow verification (3 independent re-derivation agents) and devils-advocate critique (4 critic lenses + synthesis). Corrections: review coverage figures adjusted from 61%/39% to 55%/45% per independent re-derivation; daemon parallelism evidence corrected from "single parallel run" to serial hourly dispatch; false-precision causal percentages replaced with ordinal rankings; session-yield figure annotated with missing baseline caveat; model-upgrade ruling-out softened to acknowledge evidence gap. A follow-up self-correction loop audit (docs/audit-self-correction-loop-2026-09.md) found that loop instrumentation tightened but eval-run pass rates degraded (89% -> 75%) and the eval pipeline was dark for the entire 15-day sprint.*
