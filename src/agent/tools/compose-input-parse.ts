/**
 * Input parsing and validation for the compose tool.
 *
 * Extracted from compose-executor.ts to stay under the 350-code-line ceiling.
 * The executor delegates all schema-level validation here; runtime validation
 * (root-breadth guards) remains in dag-subagent.ts's validateDagNodeRoots.
 *
 * @module agent/tools/compose-input-parse
 */

import path from 'path';
import type { DAGEdge } from '../dag.js';

export interface ComposeNodeInput {
  id: string;
  prompt: string;
  model?: string;
  /** Per-node working directory override. Same semantics as the agent tool's cwd. */
  cwd?: string;
  /** Per-node extra read roots. Same semantics as the agent tool's readRoots. */
  readRoots?: string[];
  /** Per-node extra write roots. Same semantics as the agent tool's writeRoots. */
  writeRoots?: string[];
}

export interface ComposeInput {
  nodes: ComposeNodeInput[];
  edges?: DAGEdge[];
  fail_fast?: boolean;
  node_timeout_ms?: number;
  /**
   * Per-node tool-use ROUND budget, normalized from either
   * `max_tool_rounds_per_node` (preferred) or the deprecated
   * `max_tool_calls_per_node` alias. Forwarded to each node's fork config as
   * `maxToolUseIterations` — see the budget note in ComposeExecutor.
   */
  max_tool_rounds_per_node?: number;
}

export interface ParseResult {
  parsed: ComposeInput;
  /** Human-readable warnings to surface in the compose result output. */
  warnings: string[];
}

// Bounds for the per-node timeout. The lower bound rejects sub-second values
// that are almost always a copy-paste bug (the user meant seconds, not ms),
// and the upper bound rejects multi-hour values that would defeat the
// purpose of having a deadline at all.
const MIN_NODE_TIMEOUT_MS = 1_000;
const MAX_NODE_TIMEOUT_MS = 3_600_000;

// Bounds for the per-node tool-use round budget. A floor of 1 keeps at least
// one tool-using round before the wind-down round fires (budget=0 means "no
// cap" to the provider loop, the opposite of what a caller passing 0 wants).
// The ceiling of 1000 is a sanity cap — past that the budget no longer
// constrains useful work and is almost always a typo.
const MIN_NODE_TOOL_ROUNDS = 1;
const MAX_NODE_TOOL_ROUNDS = 1_000;

/**
 * Parse and validate per-node path fields (cwd, readRoots, writeRoots).
 * Returns the validated values or throws on invalid input. Structural
 * validation only (absolute, no .., non-empty); root-breadth guards
 * (isTooBroadRoot, ungatedSensitiveRoot) are enforced downstream by
 * validateDagNodeRoots in dag-subagent.ts.
 */
function parseNodePaths(n: Record<string, unknown>, id: string): {
  cwd?: string;
  readRoots?: string[];
  writeRoots?: string[];
} {
  let cwd: string | undefined;
  if (n['cwd'] !== undefined) {
    if (typeof n['cwd'] !== 'string' || n['cwd'].trim().length === 0) {
      throw new Error(`Node "${id}" cwd must be a non-empty string`);
    }
    cwd = n['cwd'];
    if (!path.isAbsolute(cwd)) {
      throw new Error(`Node "${id}" cwd must be an absolute path (got "${cwd}")`);
    }
    if (cwd.split(/[/\\]/).includes('..')) {
      throw new Error(`Node "${id}" cwd must not contain ".." segments`);
    }
  }

  const readRoots = parseRootArray(n, id, 'readRoots');
  // Contract: writeRoots is mutually exclusive with isolation:"worktree"
  // when that lands on compose nodes (#1939). The guard belongs here.
  const writeRoots = parseRootArray(n, id, 'writeRoots');

  return { cwd, readRoots, writeRoots };
}

/** Shared parser for readRoots / writeRoots array fields. */
function parseRootArray(
  n: Record<string, unknown>,
  id: string,
  field: 'readRoots' | 'writeRoots',
): string[] | undefined {
  if (n[field] === undefined) return undefined;
  if (!Array.isArray(n[field])) {
    throw new Error(`Node "${id}" ${field} must be an array`);
  }
  const roots: string[] = [];
  for (const r of n[field] as unknown[]) {
    if (typeof r !== 'string' || r.trim().length === 0) {
      throw new Error(`Node "${id}" ${field} entries must be non-empty strings`);
    }
    if (!path.isAbsolute(r)) {
      throw new Error(`Node "${id}" ${field} entry must be an absolute path (got "${r}")`);
    }
    if (r.split(/[/\\]/).includes('..')) {
      throw new Error(`Node "${id}" ${field} entry must not contain ".." segments`);
    }
    roots.push(r);
  }
  return roots.length > 0 ? roots : undefined;
}

export function parseComposeInput(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Compose tool input must be an object');
  }

  const obj = input as Record<string, unknown>;

  const nodes = obj['nodes'];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('Compose tool requires a non-empty "nodes" array');
  }

  const MAX_NODES = 20;
  if (nodes.length > MAX_NODES) {
    throw new Error(
      `Compose tool supports at most ${MAX_NODES} nodes (got ${nodes.length}). ` +
      `Split into multiple compose calls for larger workloads.`,
    );
  }

  const parsed: ComposeNodeInput[] = [];
  const seenIds = new Set<string>();
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) {
      throw new Error('Each node must be an object');
    }
    const n = node as Record<string, unknown>;
    const id = n['id'];
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('Each node must have a non-empty "id" string');
    }
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      // Strip control chars + truncate in the error itself so it cannot
      // become a log-forge vector even on the error path.
      const safeId = id.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 32);
      throw new Error(
        `Node id "${safeId}" must match /^[A-Za-z0-9_-]+$/ (alphanumeric, underscore, hyphen)`,
      );
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate node ID: ${id}`);
    }
    seenIds.add(id);

    const prompt = n['prompt'];
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error(`Node "${id}" must have a non-empty "prompt" string`);
    }

    let model: string | undefined;
    if (n['model'] !== undefined) {
      if (typeof n['model'] !== 'string') {
        throw new Error(`Node "${id}" model must be a string`);
      }
      model = n['model'];
    }

    const { cwd, readRoots, writeRoots } = parseNodePaths(n, id);

    parsed.push({ id, prompt, model, cwd, readRoots, writeRoots });
  }

  let edges: DAGEdge[] | undefined;
  if (obj['edges'] !== undefined) {
    if (!Array.isArray(obj['edges'])) {
      throw new Error('"edges" must be an array');
    }
    edges = [];
    for (const edge of obj['edges']) {
      if (typeof edge !== 'object' || edge === null) {
        throw new Error('Each edge must be an object');
      }
      const e = edge as Record<string, unknown>;
      if (typeof e['from'] !== 'string' || typeof e['to'] !== 'string') {
        throw new Error('Each edge must have "from" and "to" strings');
      }
      if (!seenIds.has(e['from'])) {
        throw new Error(`Edge references non-existent node: ${e['from']}`);
      }
      if (!seenIds.has(e['to'])) {
        throw new Error(`Edge references non-existent node: ${e['to']}`);
      }
      edges.push({ from: e['from'], to: e['to'] });
    }
  }

  let failFast: boolean | undefined;
  if (obj['fail_fast'] !== undefined) {
    if (typeof obj['fail_fast'] !== 'boolean') {
      throw new Error('"fail_fast" must be a boolean');
    }
    failFast = obj['fail_fast'];
  }

  const warnings: string[] = [];

  let nodeTimeoutMs: number | undefined;
  if (obj['node_timeout_ms'] !== undefined) {
    const val = obj['node_timeout_ms'];
    if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
      throw new Error('"node_timeout_ms" must be a positive finite number (milliseconds)');
    }
    if (val < MIN_NODE_TIMEOUT_MS) {
      throw new Error(
        `"node_timeout_ms" must be at least ${MIN_NODE_TIMEOUT_MS}ms ` +
        `(got ${val}). Sub-second timeouts are almost always a unit mistake.`,
      );
    }
    // Upper clamp: cap rather than reject — a very large value expresses
    // intent ("a long deadline is fine") and clamping preserves forward
    // progress. Surface a warning so the model knows its value was adjusted.
    nodeTimeoutMs = Math.min(MAX_NODE_TIMEOUT_MS, val);
    if (val > MAX_NODE_TIMEOUT_MS) {
      warnings.push(
        `node_timeout_ms clamped: requested ${val}ms exceeds the maximum ` +
        `${MAX_NODE_TIMEOUT_MS}ms; using ${MAX_NODE_TIMEOUT_MS}ms.`,
      );
    }
  }

  // `max_tool_calls_per_node` is the pre-wind-down name for the same knob and
  // is still accepted; the preferred key wins when both are present so a
  // caller migrating incrementally never silently gets the older value.
  const ROUNDS_KEY = 'max_tool_rounds_per_node';
  const LEGACY_ROUNDS_KEY = 'max_tool_calls_per_node';
  const usedKey = obj[ROUNDS_KEY] !== undefined ? ROUNDS_KEY : LEGACY_ROUNDS_KEY;
  if (obj[ROUNDS_KEY] !== undefined && obj[LEGACY_ROUNDS_KEY] !== undefined) {
    warnings.push(
      `both "${ROUNDS_KEY}" and the deprecated "${LEGACY_ROUNDS_KEY}" were ` +
      `supplied; using "${ROUNDS_KEY}" and ignoring the deprecated key.`,
    );
  } else if (obj[LEGACY_ROUNDS_KEY] !== undefined) {
    warnings.push(
      `"${LEGACY_ROUNDS_KEY}" is deprecated — use "${ROUNDS_KEY}". The unit ` +
      `is tool-use ROUNDS (a round with N parallel calls costs 1), and ` +
      `spending the budget now triggers a tools-stripped wind-down round ` +
      `instead of cancelling the node.`,
    );
  }

  let maxToolRoundsPerNode: number | undefined;
  if (obj[usedKey] !== undefined) {
    const val = obj[usedKey];
    if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
      throw new Error(`"${usedKey}" must be a positive finite number`);
    }
    if (!Number.isInteger(val)) {
      throw new Error(
        `"${usedKey}" must be an integer (got ${val}). ` +
        `Tool-use rounds are discrete events; fractional budgets are not meaningful.`,
      );
    }
    if (val < MIN_NODE_TOOL_ROUNDS) {
      throw new Error(`"${usedKey}" must be at least ${MIN_NODE_TOOL_ROUNDS}`);
    }
    if (val > MAX_NODE_TOOL_ROUNDS) {
      throw new Error(
        `"${usedKey}" must be at most ${MAX_NODE_TOOL_ROUNDS} ` +
        `(got ${val}). A larger budget no longer constrains useful work.`,
      );
    }
    maxToolRoundsPerNode = val;
  }

  return {
    parsed: {
      nodes: parsed,
      edges,
      fail_fast: failFast,
      node_timeout_ms: nodeTimeoutMs,
      max_tool_rounds_per_node: maxToolRoundsPerNode,
    },
    warnings,
  };
}
