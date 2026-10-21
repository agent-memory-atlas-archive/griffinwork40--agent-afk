/**
 * Canonical gate list for commands that cannot run on the web surface.
 *
 * A "gated" command is one that requires terminal machinery, interactive
 * stdio, or other capabilities that do not exist in the web context. These
 * commands are blocked at the API layer rather than silently failing.
 *
 * Invariant: Stage 1 replaces this with requires: SurfaceCapability[] on
 * each command registration, deriving the gate list from the capability set
 * rather than a hard-coded map. For Stage 0, a flat map is sufficient.
 *
 * Key: command name (with leading `/`).
 * Value: human-readable reason shown in the 409 response.
 */
const GATE_MAP: ReadonlyMap<string, string> = new Map([
  // Session control: needs the shared session-control service (Stage 1).
  ['/clear',       'not on the web yet: session control is coming; start a new session instead'],
  ['/compact',     'not on the web yet: session control is coming; use the REPL for now'],
  ['/model',       'not on the web yet: pick the model when creating a session'],
  ['/fast',        'not on the web yet: session control is coming; use the REPL for now'],
  ['/thinking',    'not on the web yet: session control is coming; use the REPL for now'],
  ['/plan',        'not on the web yet: permission-mode control is coming; use the REPL for now'],
  ['/afk',         'not on the web yet: permission-mode control is coming; use the REPL for now'],
  ['/name',        'not on the web yet: session rename is coming; use the REPL for now'],
  ['/retry',       'not on the web yet: retry is coming; resend your last message instead'],
  ['/reauth',      'not on the web yet: re-authentication runs in the REPL'],
  ['/init',        'not on the web yet: /init writes AFK.md through the REPL console'],
  // Interactive pickers: need choice requests (Stage 3).
  ['/rewind',      'not on the web yet: needs an interactive picker; use the REPL for now'],
  // Session lifecycle: needs web session lifecycle (Stage 4).
  ['/fork',        'not on the web yet: forking a session is coming; use the REPL for now'],
  ['/resume',      'not on the web yet: open past sessions from the sidebar (read-only for now)'],
  ['/exit',        'not applicable on the web: close the tab or start a new session'],
  ['/quit',        'not applicable on the web: close the tab or start a new session'],
  // Terminal-only affordances with a browser-native equivalent.
  ['/editor',      'not applicable on the web: the composer is already a full editor'],
  ['/copy',        'not applicable on the web: use the copy buttons on messages and code'],
  ['/font-size',   'not applicable on the web: use browser zoom'],
  ['/theme',       'not applicable on the web: the dashboard follows your system theme'],
  ['/ghost',       'not applicable on the web: terminal ghost-text only'],
  ['/suggestions', 'not applicable on the web: terminal input history only'],
  ['/keys',        'not applicable on the web: terminal keybindings only'],
  ['/sh',          'not on the web yet: shell jobs are listed in the Jobs view'],
  ['/tasks:view',  'not on the web yet: open subagents from the transcript instead'],
]);

/**
 * True if `name` is blocked from running on the web surface.
 */
export function isGated(name: string): boolean {
  return GATE_MAP.has(name);
}

/**
 * Human-readable reason for the gate, or `undefined` if not gated.
 */
export function gateReason(name: string): string | undefined {
  return GATE_MAP.get(name);
}
