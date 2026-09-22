/**
 * Input parsing and validation for the compose tool.
 *
 * Extracted from compose-executor.ts to stay under the 350-code-line ceiling.
 * The executor delegates all schema-level validation here; runtime validation
 * (root-breadth guards) remains in dag-subagent.ts's validateDagNodeRoots.
 *
 * @module agent/tools/compose-input-parse
 */

import type { DAGEdge } from '../dag.js';

export interface ComposeNodeInput {
  id: string;
  prompt: string;
  model?: string;
  /** Per-node tool-use round budget. Overrides compose-level max_tool_rounds_per_node. */
  max_tool_rounds?: number;
  /** Per-node turn budget. Forwarded to the fork config as maxTurns. */
  max_turns?: number;
}

export interface ComposeInput {
  nodes: ComposeNodeInput[];
  edges?: DAGEdge[];
  fail_fast?: boolean;
  node_timeout_ms?: number;
  /**
   * Compose-level tool-use ROUND budget, normalized from either
   * `max_tool_rounds_per_node` (preferred) or the deprecated
   * `max_tool_calls_per_node` alias. Per-node `max_tool_rounds` overrides this.
   */
  max_tool_rounds_per_node?: number;
}

export interface ParseResult {
  parsed: ComposeInput;
  /** Human-readable warnings to surface in the compose result output. */
  warnings: string[];
}

// Bounds for the per-node timeout.
const MIN_NODE_TIMEOUT_MS = 1_000;
const MAX_NODE_TIMEOUT_MS = 3_600_000;

// Bounds for tool-use round budgets (both compose-level and per-node).
const MIN_NODE_TOOL_ROUNDS = 1;
const MAX_NODE_TOOL_ROUNDS = 1_000;

/** Validate and return a positive integer tool-round budget from raw input. */
function parseToolRounds(val: unknown, key: string): number {
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
    throw new Error(`"${key}" must be a positive finite number`);
  }
  if (!Number.isInteger(val)) {
    throw new Error(
      `"${key}" must be an integer (got ${val}). ` +
      `Tool-use rounds are discrete events; fractional budgets are not meaningful.`,
    );
  }
  if (val < MIN_NODE_TOOL_ROUNDS) {
    throw new Error(`"${key}" must be at least ${MIN_NODE_TOOL_ROUNDS}`);
  }
  if (val > MAX_NODE_TOOL_ROUNDS) {
    throw new Error(
      `"${key}" must be at most ${MAX_NODE_TOOL_ROUNDS} ` +
      `(got ${val}). A larger budget no longer constrains useful work.`,
    );
  }
  return val;
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

    let nodeMaxToolRounds: number | undefined;
    if (n['max_tool_rounds'] !== undefined) {
      nodeMaxToolRounds = parseToolRounds(n['max_tool_rounds'], `node "${id}" max_tool_rounds`);
    }

    let nodeMaxTurns: number | undefined;
    if (n['max_turns'] !== undefined) {
      const val = n['max_turns'];
      if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val) || val <= 0) {
        throw new Error(`Node "${id}" max_turns must be a positive integer`);
      }
      nodeMaxTurns = val;
    }

    parsed.push({ id, prompt, model,
      ...(nodeMaxToolRounds !== undefined ? { max_tool_rounds: nodeMaxToolRounds } : {}),
      ...(nodeMaxTurns !== undefined ? { max_turns: nodeMaxTurns } : {}),
    });
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
    nodeTimeoutMs = Math.min(MAX_NODE_TIMEOUT_MS, val);
    if (val > MAX_NODE_TIMEOUT_MS) {
      warnings.push(
        `node_timeout_ms clamped: requested ${val}ms exceeds the maximum ` +
        `${MAX_NODE_TIMEOUT_MS}ms; using ${MAX_NODE_TIMEOUT_MS}ms.`,
      );
    }
  }

  // `max_tool_calls_per_node` is the pre-wind-down alias; preferred key wins.
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
    maxToolRoundsPerNode = parseToolRounds(obj[usedKey], usedKey);
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
