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
  // Terminal-UI commands — require readline/compositor machinery
  ['/clear',       'requires terminal readline (not available on web)'],
  ['/compact',     'requires terminal readline (not available on web)'],
  ['/copy',        'copies to the system clipboard (not available on web)'],
  ['/editor',      'requires a local $EDITOR process (not available on web)'],
  ['/exit',        'exits the REPL process — no equivalent on web'],
  ['/fast',        'toggles fast-mode state on the local REPL session'],
  ['/font-size',   'controls terminal font size (not available on web)'],
  ['/fork',        'forks the terminal session (not available on web)'],
  ['/ghost',       'toggles terminal ghost-text suggestions (not available on web)'],
  ['/keys',        'shows terminal keybindings (not available on web)'],
  ['/model',       'switches REPL model mid-session (use web session settings instead)'],
  ['/quit',        'exits the REPL process — no equivalent on web'],
  ['/reauth',      'triggers interactive re-authentication in the terminal'],
  ['/resume',      'resumes a session in the terminal REPL (not available on web)'],
  ['/rewind',      'rewinds terminal REPL history (not available on web)'],
  ['/sh',          'opens an interactive shell (not available on web)'],
  ['/suggestions', 'manages terminal input history (not available on web)'],
  ['/tasks:view',  'requires terminal TUI (not available on web)'],
  ['/theme',       'changes terminal color theme (not available on web)'],
  ['/thinking',    'controls terminal thinking-display mode (not available on web)'],
  // Stage 0 additions from A5 — require plan/AFK/session-management machinery
  ['/afk',         'enables AFK (autonomous) mode on the local REPL session'],
  ['/init',        'initializes a new agent project via interactive prompts'],
  ['/name',        'sets session name in the local REPL session store'],
  ['/plan',        'toggles plan mode on the local REPL session'],
  ['/retry',       'retries the last turn in the terminal REPL'],
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
