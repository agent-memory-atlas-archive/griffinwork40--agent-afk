/**
 * Browser-safe mirror of src/web-server/shared/command-wire.ts.
 *
 * No Node.js imports. Used by dashboard components to type the command API
 * response without importing server-side code.
 */

/** A single output block produced by a command handler. */
export interface CommandOutputBlock {
  /** Block kind — drives the renderer registry lookup. Defaults to 'text'. */
  kind?: string;
  /** ANSI-escaped text as emitted by the handler (may contain SGR sequences). */
  ansi: string;
  /** Plain-text version with all VT control characters stripped. */
  text: string;
}

/**
 * Wire response for `POST /api/sessions/:id/commands`.
 */
export interface CommandResponse {
  blocks: CommandOutputBlock[];
  control: CommandControl;
  /** Authoritative session metadata after a successful control operation. */
  session?: { model?: string; name?: string; thinkingUi?: ThinkingUiMode };
}

/** Display-only preference; hiding thinking never removes transcript data. */
export type ThinkingUiMode = 'summary' | 'live' | 'digest' | 'off';

/** Normalised SlashResult plus explicit successful conversation reset. */
export type CommandControl =
  | { kind: 'continue' }
  | { kind: 'clear' }
  | { kind: 'exit' }
  | { kind: 'forward' }
  | { kind: 'rerun'; input: string }
  | { kind: 'submit'; message: string }
  | { kind: 'prefill'; message: string };
