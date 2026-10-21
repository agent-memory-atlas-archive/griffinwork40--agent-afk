/** Derive web availability from positive command requirements. */
import { lookup } from '../cli/slash/registry.js';
import {
  capabilityReason,
  missingCapabilities,
  webCapabilities,
  type SurfaceCapability,
} from '../cli/slash/capabilities.js';

/** Temporary lifecycle/picker deferrals, removed when Stages 3/4 land. */
const DEFERRED: ReadonlyMap<string, string> = new Map([
  ['/rewind', 'not on the web yet: needs an interactive picker; use the REPL for now'],
  ['/fork', 'not on the web yet: forking a session is coming; use the REPL for now'],
  ['/resume', 'not on the web yet: open past sessions from the sidebar (read-only for now)'],
  ['/exit', 'not applicable on the web: close the tab or start a new session'],
  ['/quit', 'not applicable on the web: close the tab or start a new session'],
]);

/** True when the web context cannot satisfy a registered command's requirements. */
export function isGated(
  name: string,
  provided: ReadonlySet<SurfaceCapability> = webCapabilities(),
): boolean {
  return gateReason(name, provided) !== undefined;
}

/** Human-readable reason, preserving the existing GET/POST wire contract. */
export function gateReason(
  name: string,
  provided: ReadonlySet<SurfaceCapability> = webCapabilities(),
): string | undefined {
  const command = lookup(name);
  const deferred = DEFERRED.get(command?.name ?? name);
  if (deferred !== undefined) return deferred;
  // Name fallback keeps boot-time classification safe before registration.
  const missing = missingCapabilities(command ?? { name }, provided);
  return missing.length > 0
    ? `not available on the web: ${missing.map(capabilityReason).join('; ')}`
    : undefined;
}
