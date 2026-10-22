/**
 * Server-side wire types for the command execution API.
 *
 * Kept in a sub-directory with NO imports from `cli/slash` so it can be
 * imported by both server routes and (via the dashboard mirror) the browser.
 */

/** A single output block produced by a command handler. */
export interface CommandOutputBlock {
  /** ANSI-escaped text as emitted by the handler (may contain SGR sequences). */
  ansi: string;
  /** Plain-text version with all VT control characters stripped. */
  text: string;
}

/**
 * Wire response for `POST /api/sessions/:id/commands`.
 *
 * `control` encodes the `SlashResult` variant normalised to a plain object
 * so the browser can act on it without importing CLI types.
 */
export interface CommandResponse {
  blocks: CommandOutputBlock[];
  control: CommandControl;
}

/** Normalised `SlashResult` for the wire. All 6 variants represented. */
export type CommandControl =
  | { kind: 'continue' }
  | { kind: 'exit' }
  | { kind: 'forward' }
  | { kind: 'rerun'; input: string }
  | { kind: 'submit'; message: string }
  | { kind: 'prefill'; message: string };
