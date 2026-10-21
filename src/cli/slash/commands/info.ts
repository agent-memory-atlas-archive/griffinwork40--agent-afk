/**
 * Information / introspection commands:
 *   /cost /tokens /history /model /tools /mcp /debug /usage
 *
 * These all read from SessionStats or session metadata and format for
 * display. `/model` mutates state by calling `session.setModel()`.
 *
 * `/cost` vs `/usage`: /cost is session-local spend (this conversation's
 * turn-by-turn API cost); /usage is the operator's account-wide Claude
 * subscription quota (5h/7d rolling windows). Different axes — cross-
 * referenced in each other's output.
 */

import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import { formatCost, formatTokens } from '../../format-utils.js';
import { MODEL_CONTEXT_LIMITS } from '../../model-limits.js';
import { renderDebugBanner } from '../../debug-banner.js';
import { isModelAvailable } from '../../../agent/auth/model-availability.js';
import {
  MODEL_ALIASES_HINT,
  unconfiguredSlotError,
} from '../../../agent/session/model-slots.js';
import { isValidModelArg } from '../../../agent/session/model-validate.js';
import { runPicker } from '../../render/picker.js';
import { historyCmd } from './info.history.js';
import { mcpCmd } from './info.mcp.js';
import { usageCmd } from './info.usage.js';
import { tokensCmd } from './info.tokens.js';
import { infoCmd } from './info.session.js';
import type { SlashCommand, SlashContext } from '../types.js';
import type { AgentModelInput } from '../../../agent/types.js';
import { errorMessage } from '../../../utils/errors.js';

const costCmd: SlashCommand = {
  name: '/cost',
  summary: 'Show total and per-turn cost',
  hint: 'When you want a dollar breakdown of this session — total, average per turn, and the recent turn-by-turn series.',
  async handler(ctx) {
    const { stats, out } = ctx;
    out.line();
    out.line(palette.bold('Session cost'));
    out.line(divider());
    out.line(`  total       ${palette.success(formatCost(stats.totalCostUsd))}`);
    out.line(`  turns       ${palette.meta(String(stats.totalTurns))}`);
    if (stats.totalTurns > 0) {
      const avg = stats.totalCostUsd / stats.totalTurns;
      out.line(`  avg/turn    ${palette.meta(formatCost(avg))}`);
    }
    if (stats.turnCosts.length > 0) {
      const last5 = stats.turnCosts.slice(-5).map(formatCost).join(palette.dim(' · '));
      out.line(`  last 5      ${last5}`);
    }
    if (stats.unpricedTurns > 0) {
      out.line(`  unpriced    ${palette.warning(`${stats.unpricedTurns} turn${stats.unpricedTurns === 1 ? '' : 's'} had no cost metadata — total may be understated`)}`);
    }
    out.line();
    out.line(palette.dim('  This is session-local spend. For account-wide subscription quota, see /usage.'));
    out.line();
    return 'continue';
  },
};

/**
 * Validate + apply a model target (mid-session, live). Shared by the text-arg
 * path (`/model <name>`) and the interactive picker (bare `/model` on a TTY).
 * Writes all user-facing output via ctx.out; never throws.
 */
async function switchModel(ctx: SlashContext, target: string): Promise<void> {
  // Accept slot tier names / configured custom names, the built-in identity
  // aliases (claude-*, grok-*, gpt-*, org/model HF ids, …). Bare unknown
  // strings (e.g. typos) are rejected — they'd silently fall through to a
  // provider and produce an unhelpful API error at turn time.
  if (!isValidModelArg(target)) {
    ctx.out.warn(`Unknown model: ${target}. Aliases: ${MODEL_ALIASES_HINT.join(', ')}  (or a full model id)`);
    return;
  }
  // Reject an unconfigured capability tier (e.g. an empty `local` slot) at the
  // point of selection — otherwise the empty id reaches the provider as an
  // opaque empty-model error or a silent cloud fallback.
  const unconfigured = unconfiguredSlotError(target);
  if (unconfigured) {
    ctx.out.warn(unconfigured);
    return;
  }
  try {
    await ctx.session.current.setModel(target as AgentModelInput);
    ctx.stats.model = target as AgentModelInput;
    ctx.ui.repaintStatusLine();
    ctx.out.success(`Model switched to ${palette.brand(target)}`);
  } catch (err) {
    ctx.out.error(`Failed to switch model: ${errorMessage(err)}`);
  }
}

const modelCmd: SlashCommand = {
  name: '/model',
  usage: '/model [local|small|medium|large|opus|sonnet|haiku|fable|org/model]',
  summary: 'Switch the active model mid-session',
  hint: 'Switch the capability tier (local/small/medium/large — or your configured names) or pass a full model id. Bare `/model` opens an interactive picker on a TTY. Upgrade to large for a hard problem, downshift to small for cheap iteration — context carries over. Also accepts HuggingFace-style ids (e.g. mlx-community/Qwen3-30B-A3B-4bit).',
  async handler(ctx, args) {
    const target = args.trim().toLowerCase();
    if (target) {
      await switchModel(ctx, target);
      return 'continue';
    }

    // No argument: open an arrow-key picker on a TTY; fall back to the current
    // model + alias list on non-TTY surfaces (Telegram, daemon, tests).
    const compositor = ctx.getCompositor?.() ?? null;
    if (compositor) {
      // P2 follow-up: runPicker's `options: readonly string[]` uses the same
      // string as both rendered label and selected value (see `choice` below
      // fed straight to `switchModel`), so there is no clean label≠value split
      // to hang an availability marker on without corrupting selection — left
      // un-annotated; picker would need a { label, value } option shape first.
      const options = [...MODEL_ALIASES_HINT];
      const currentIdx = options.indexOf(ctx.stats.model as (typeof MODEL_ALIASES_HINT)[number]);
      const picked = await runPicker(compositor, {
        header: [
          palette.bold('Switch model'),
          palette.dim(`current: ${ctx.stats.model}`),
          palette.dim('or type a full id: /model <org/model>'),
          '',
        ],
        options,
        initialIndex: currentIdx >= 0 ? currentIdx : 0,
      });
      const choice = picked?.[0];
      if (choice) await switchModel(ctx, choice);
      return 'continue';
    }

    ctx.out.info(`Current model: ${palette.brand(ctx.stats.model)}`);
    const aliasList = MODEL_ALIASES_HINT.map((alias) =>
      isModelAvailable(alias) ? alias : `${alias} (needs sign-in)`,
    ).join(', ');
    ctx.out.line(palette.dim(`  Aliases: ${aliasList}  (or any org/model HF id)`));
    return 'continue';
  },
};

const toolsCmd: SlashCommand = {
  name: '/tools',
  summary: 'List tools available to the session',
  async handler(ctx) {
    try {
      const meta = await ctx.session.current.waitForInitialization();
      const tools = meta.tools ?? [];
      if (tools.length === 0) {
        ctx.out.info('No tools reported by the session.');
        return 'continue';
      }
      ctx.out.line();
      ctx.out.line(palette.bold(`Tools  (${tools.length})`));
      ctx.out.line(divider());
      const columns = 3;
      const rows = Math.ceil(tools.length / columns);
      const colWidth = Math.max(...tools.map((t) => t.length)) + 2;
      for (let r = 0; r < rows; r++) {
        const row: string[] = [];
        for (let c = 0; c < columns; c++) {
          const idx = c * rows + r;
          if (idx < tools.length) row.push(tools[idx]!.padEnd(colWidth));
        }
        ctx.out.line('  ' + row.join(''));
      }
      ctx.out.line();
    } catch (err) {
      ctx.out.error(`Could not read session tools: ${errorMessage(err)}`);
    }
    return 'continue';
  },
};


const limitsCmd: SlashCommand = {
  name: '/limits',
  summary: 'Show known per-model context-window limits',
  async handler(ctx) {
    ctx.out.line();
    ctx.out.line(palette.bold('Context-window limits'));
    ctx.out.line(divider());
    for (const [model, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
      const marker = model === ctx.stats.model ? palette.brand(' ← active') : '';
      ctx.out.line(`  ${palette.warning(model.padEnd(12))} ${palette.meta(formatTokens(limit))}${marker}`);
    }
    ctx.out.line();
    return 'continue';
  },
};

const debugCmd: SlashCommand = {
  name: '/debug',
  summary: 'Show SDK session metadata (tools, MCP, skills, plugins, etc.)',
  hint: 'When something feels broken and you want to inspect what the session actually loaded — tools, MCP servers, plugins, system prompt source.',
  async handler(ctx) {
    try {
      const meta = await ctx.session.current.waitForInitialization();
      ctx.out.line();
      ctx.out.line(renderDebugBanner(meta));
      ctx.out.line();
    } catch (err) {
      ctx.out.error(`Could not read session metadata: ${errorMessage(err)}`);
    }
    return 'continue';
  },
};

export const infoCommands: SlashCommand[] = [
  costCmd, tokensCmd, historyCmd, modelCmd, toolsCmd, mcpCmd, limitsCmd, debugCmd, usageCmd, infoCmd,
];
