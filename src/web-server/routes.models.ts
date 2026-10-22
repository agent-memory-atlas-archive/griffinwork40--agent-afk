/** Authenticated model catalogue for the web surface; no provider requests. */
import type { ServerResponse } from 'node:http';
import { sendJson } from './routes.js';
import { loadConfig } from '../cli/config.js';
import { getSlotBindings, resolveModelInput, SLOT_NAMES, MODEL_ALIASES_HINT } from '../agent/session/model-slots.js';

export interface ModelInfo {
  id: string;
  label: string;
}

/** Resolve aliases in display copy too, so a rebound tier never mislabels its model. */
function modelLabel(id: string): string {
  const resolved = resolveModelInput(id) ?? id;
  const claude = /^claude-(haiku|sonnet|opus|fable)-(\d+)(?:-(\d+))?/.exec(resolved);
  const name = claude
    ? `Claude ${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
    : resolved;
  const display = id.endsWith('_1m') ? `${name} (1M context)` : name;
  return id === resolved ? display : `${id} · ${display}`;
}

/** `default` is the owner's launch model, not a browser-side guess. */
export function handleListModels(res: ServerResponse, defaultModel?: string): void {
  const selected = defaultModel ?? String(loadConfig().model);
  const bindings = getSlotBindings();
  const ids = new Set([
    selected, 'sonnet', 'haiku', 'opus',
    ...MODEL_ALIASES_HINT.filter((id) => !SLOT_NAMES.includes(id as typeof SLOT_NAMES[number])),
    ...SLOT_NAMES.filter((slot) => bindings[slot].id.length > 0),
    ...Object.values(bindings).flatMap((binding) => binding.name ? [binding.name] : []),
  ]);
  sendJson(res, 200, {
    models: [...ids].map((id) => ({ id, label: modelLabel(id) })),
    default: selected,
  });
}
