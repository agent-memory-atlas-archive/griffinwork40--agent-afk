/**
 * Placeholder detection for agent output.
 *
 * Scans assistant text for unresolved placeholder tokens inside code blocks
 * and inline code — the failure class where the agent hands the user a command
 * like `ssh your-user@mac-mini-ip` and the user runs it literally.
 *
 * Two layers:
 *   1. {@link detectPlaceholders} — pure detection, returns every match.
 *   2. {@link createPlaceholderDetectHook} — Stop hook that injects a
 *      correction when placeholders are found, following the same
 *      `injectContext` pattern as the terminal-state gate.
 *
 * Intentionally pure — no I/O, no SDK imports — so any layer may depend on it.
 *
 * @module agent/placeholder-detect
 */

import type { HookContext, HookDecision, HookHandler } from './hooks.js';
import { debugLog } from '../utils/debug.js';

// ─── Placeholder patterns ────────────────────────────────────────────────────

/**
 * Each pattern has a name (for diagnostics), a regex, and an optional
 * validator that filters false positives from the regex match.
 */
interface PlaceholderPattern {
  name: string;
  regex: RegExp;
  /** Return false to suppress the match (false positive). */
  validate?: (match: string, fullBlock: string) => boolean;
}

// Contract: every regex uses the global flag so matchAll works. Patterns are
// ordered most-specific-first; the dedup in detectPlaceholders collapses
// overlapping matches by span.

const PLACEHOLDER_PATTERNS: PlaceholderPattern[] = [
  // ── Angle-bracket placeholders ──────────────────────────────────────────
  // <your-api-key>, <YOUR_TOKEN>, <hostname>, <port>, <user>, etc.
  // Excludes HTML tags (<div>, <br/>, <a href=...>), XML self-closing,
  // and common code patterns (<T>, <string>, <number>, generic type params).
  {
    name: 'angle-bracket',
    regex: /<([a-zA-Z][a-zA-Z0-9_-]*(?:\s+[a-zA-Z_-]+)*)>/g,
    validate: (match) => {
      const inner = match.slice(1, -1).toLowerCase();
      // HTML/XML tags
      if (/^\//.test(inner)) return false; // closing tags
      if (/^(?:div|span|p|a|br|hr|img|ul|ol|li|h[1-6]|table|tr|td|th|thead|tbody|form|input|button|label|select|option|textarea|pre|code|em|strong|b|i|u|s|head|body|html|script|style|link|meta|title|nav|header|footer|main|section|article|aside|summary|details|blockquote|figure|figcaption|iframe|video|audio|source|canvas|svg|path|circle|rect|line|polygon|polyline|ellipse|text|g|defs|use|symbol|marker|pattern|image|foreignobject|switch|desc)$/.test(inner)) return false;
      // Generic type parameters
      if (/^[A-Z]$/.test(inner)) return false; // <T>, <K>, <V>
      if (/^(?:string|number|boolean|object|any|void|never|unknown|null|undefined|bigint|symbol)$/.test(inner)) return false;
      // Must look like a placeholder — contains a separator or known prefix
      return /[-_\s]/.test(inner) ||
        /^(?:your|my|the|this|replace|insert|enter|add|put|set|specify|provide|fill|change|update|edit|example|sample|placeholder|todo|fixme|xxx|host|user|pass|token|key|secret|name|email|domain|server|port|path|url|uri|ip|address|database|db|api|app|project|org|repo|bucket|region|account|id|value|file|dir|folder|endpoint)/.test(inner);
    },
  },

  // ── SCREAMING_SNAKE placeholders ────────────────────────────────────────
  // YOUR_API_KEY, REPLACE_WITH_TOKEN, INSERT_PASSWORD_HERE
  {
    name: 'screaming-snake',
    regex: /\b(?:YOUR|MY|THE|REPLACE|INSERT|ENTER|ADD|PUT|SET|CHANGE|UPDATE|EDIT|EXAMPLE|SAMPLE|PLACEHOLDER|TODO|FIXME|XXX)[_A-Z0-9]{2,}\b/g,
    validate: (match) => {
      // Must contain at least one underscore to be a multi-word placeholder
      if (!match.includes('_')) return false;
      // Exclude common env var patterns that are real values, not placeholders
      if (/^(?:TODO|FIXME)$/.test(match)) return false;
      return true;
    },
  },

  // ── your-* / your_* kebab/snake placeholders ───────────────────────────
  // your-user, your-api-key, your_password, your_hostname
  {
    name: 'your-prefix',
    regex: /\byour[-_][a-z][a-z0-9_-]*\b/gi,
  },

  // ── example.com family ─────────────────────────────────────────────────
  // example.com, example.org, example.net, user@example.com
  {
    name: 'example-domain',
    regex: /\b[a-zA-Z0-9._%+-]*@?example\.(?:com|org|net)\b/g,
  },

  // ── xxx / xxxx placeholder runs ────────────────────────────────────────
  // xxx.xxx.xxx.xxx, xxxx-xxxx, but not hex or common abbreviations
  {
    name: 'xxx-run',
    regex: /\bx{3,}(?:[-._]x{2,})*\b/gi,
    validate: (match) => {
      // At least 3 x's in a row somewhere
      return /x{3}/i.test(match);
    },
  },

  // ── Ellipsis placeholders in code ──────────────────────────────────────
  // ... used as a placeholder value (not prose trailing)
  // Only match when ... is the entire value in an assignment or argument
  {
    name: 'ellipsis-value',
    regex: /(?:=\s*['"]?\.\.\.\s*['"]?|:\s*['"]?\.\.\.\s*['"]?(?:,|$|\}))/gm,
  },

  // ── REPLACE_ME / CHANGEME / PLACEHOLDER family ─────────────────────────
  {
    name: 'replace-me',
    regex: /\b(?:REPLACE_?ME|CHANGE_?ME|FILL_?(?:IN|ME|THIS)|FIX_?ME|TODO_?HERE|PLACEHOLDER)\b/gi,
  },
];

// ─── Code block extraction ───────────────────────────────────────────────────

/**
 * Extract fenced code blocks and inline code spans from markdown text.
 * Returns the code content only — surrounding prose is excluded so we
 * don't flag prose like "replace <your-token> with..." which is
 * instructional, not a runnable command.
 */
export function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];

  // Fenced code blocks: ```...``` or ~~~...~~~
  const fencedRe = /^(?:```|~~~)[^\n]*\n([\s\S]*?)^(?:```|~~~)\s*$/gm;
  for (const m of text.matchAll(fencedRe)) {
    if (m[1]) blocks.push(m[1]);
  }

  // Inline code: `...` (but not inside fenced blocks — already extracted)
  // Strip fenced blocks first, then extract inline
  const withoutFenced = text.replace(fencedRe, '');
  const inlineRe = /`([^`\n]+)`/g;
  for (const m of withoutFenced.matchAll(inlineRe)) {
    if (m[1]) blocks.push(m[1]);
  }

  return blocks;
}

// ─── Detection ───────────────────────────────────────────────────────────────

export interface PlaceholderMatch {
  pattern: string;
  match: string;
  /** The code block the match was found in. */
  block: string;
}

/**
 * Scan text for unresolved placeholder tokens inside code blocks and
 * inline code. Returns all matches, deduplicated by the matched string.
 *
 * Pure function — no I/O.
 */
export function detectPlaceholders(text: string): PlaceholderMatch[] {
  const codeBlocks = extractCodeBlocks(text);
  if (codeBlocks.length === 0) return [];

  const seen = new Set<string>();
  const matches: PlaceholderMatch[] = [];

  for (const block of codeBlocks) {
    for (const pattern of PLACEHOLDER_PATTERNS) {
      // Reset lastIndex for global regexes
      pattern.regex.lastIndex = 0;
      for (const m of block.matchAll(pattern.regex)) {
        const matched = m[0];
        if (seen.has(matched)) continue;
        if (pattern.validate && !pattern.validate(matched, block)) continue;
        seen.add(matched);
        matches.push({ pattern: pattern.name, match: matched, block });
      }
    }
  }

  return matches;
}

// ─── Stop hook ───────────────────────────────────────────────────────────────

/**
 * Maximum corrections per session. After this many bounces the hook goes
 * quiet — same fail-open model as the terminal-state gate.
 */
const MAX_INJECTIONS_PER_SESSION = 2;

/**
 * The correction injected into the next turn when placeholders are detected
 * in the assistant's output code blocks. Names the specific placeholders found
 * and instructs the model to resolve them or explicitly mark them.
 */
function buildCorrection(matches: PlaceholderMatch[]): string {
  const placeholders = matches.map((m) => `\`${m.match}\``).join(', ');
  return (
    '[placeholder-detect] The previous turn contained code blocks with ' +
    `unresolved placeholder values: ${placeholders}. ` +
    'Before presenting commands to the user, do ONE of:\n' +
    '  (a) resolve the actual values (run a discovery command, read config, ' +
    'or ask the user) and restate the command with real values; or\n' +
    '  (b) if the values genuinely cannot be resolved, wrap each placeholder ' +
    'in a prominent callout (e.g. "⚠ Replace `<your-token>` with ...") so ' +
    'the user cannot miss that substitution is required.\n' +
    'Do not restate the same command with the same placeholders.'
  );
}

/**
 * Build a `Stop` hook handler that detects unresolved placeholders in the
 * assistant's last message and injects a correction into the next turn.
 *
 * Requires `StopContext.lastAssistantText` to be populated by the REPL loop.
 * When the field is absent (non-REPL surfaces, subagents) the hook is a no-op.
 *
 * Same lifecycle contract as the terminal-state gate: never blocks, never
 * throws, bounded injections per session, fails open.
 */
export function createPlaceholderDetectHook(): HookHandler {
  let injections = 0;

  return (context: HookContext): HookDecision => {
    if (context.event !== 'Stop') return {};
    // Skip subagent turns — placeholder detection is for user-facing output.
    if (context.parentSessionId) return {};
    // Require the assistant text to be threaded through (REPL-only).
    const text = (context as { lastAssistantText?: string }).lastAssistantText;
    if (!text) return {};
    // Loop guard: bounded corrections per session.
    if (injections >= MAX_INJECTIONS_PER_SESSION) return {};

    const matches = detectPlaceholders(text);
    if (matches.length === 0) return {};

    injections += 1;
    debugLog(
      `[placeholder-detect] found ${matches.length} placeholder(s) in assistant output ` +
        `(${injections}/${MAX_INJECTIONS_PER_SESSION})`,
      { sessionId: context.sessionId, placeholders: matches.map((m) => m.match) },
    );

    return { injectContext: buildCorrection(matches) };
  };
}
