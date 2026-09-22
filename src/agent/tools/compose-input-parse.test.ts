import { describe, it, expect } from 'vitest';
import { parseComposeInput } from './compose-input-parse.js';

/** Minimal valid input helper. */
function minimal(nodeOverrides?: Record<string, unknown>, topOverrides?: Record<string, unknown>) {
  return {
    nodes: [{ id: 'a', prompt: 'do something', ...nodeOverrides }],
    ...topOverrides,
  };
}

describe('parseComposeInput — per-node max_tool_rounds', () => {
  it('accepts a valid per-node max_tool_rounds', () => {
    const { parsed } = parseComposeInput(minimal({ max_tool_rounds: 10 }));
    expect(parsed.nodes[0]!.max_tool_rounds).toBe(10);
  });

  it('omits max_tool_rounds when not provided', () => {
    const { parsed } = parseComposeInput(minimal());
    expect(parsed.nodes[0]!.max_tool_rounds).toBeUndefined();
  });

  it('rejects zero max_tool_rounds', () => {
    expect(() => parseComposeInput(minimal({ max_tool_rounds: 0 }))).toThrow(
      /positive finite number/,
    );
  });

  it('rejects negative max_tool_rounds', () => {
    expect(() => parseComposeInput(minimal({ max_tool_rounds: -5 }))).toThrow(
      /positive finite number/,
    );
  });

  it('rejects fractional max_tool_rounds', () => {
    expect(() => parseComposeInput(minimal({ max_tool_rounds: 1.5 }))).toThrow(
      /must be an integer/,
    );
  });

  it('rejects max_tool_rounds above 1000', () => {
    expect(() => parseComposeInput(minimal({ max_tool_rounds: 1001 }))).toThrow(
      /must be at most 1000/,
    );
  });

  it('accepts boundary value 1', () => {
    const { parsed } = parseComposeInput(minimal({ max_tool_rounds: 1 }));
    expect(parsed.nodes[0]!.max_tool_rounds).toBe(1);
  });

  it('accepts boundary value 1000', () => {
    const { parsed } = parseComposeInput(minimal({ max_tool_rounds: 1000 }));
    expect(parsed.nodes[0]!.max_tool_rounds).toBe(1000);
  });

  it('rejects non-number max_tool_rounds', () => {
    expect(() => parseComposeInput(minimal({ max_tool_rounds: 'ten' }))).toThrow(
      /positive finite number/,
    );
  });

  it('per-node value is independent across nodes', () => {
    const { parsed } = parseComposeInput({
      nodes: [
        { id: 'a', prompt: 'task a', max_tool_rounds: 5 },
        { id: 'b', prompt: 'task b', max_tool_rounds: 20 },
        { id: 'c', prompt: 'task c' },
      ],
    });
    expect(parsed.nodes[0]!.max_tool_rounds).toBe(5);
    expect(parsed.nodes[1]!.max_tool_rounds).toBe(20);
    expect(parsed.nodes[2]!.max_tool_rounds).toBeUndefined();
  });
});

describe('parseComposeInput — per-node max_turns', () => {
  it('accepts a valid per-node max_turns', () => {
    const { parsed } = parseComposeInput(minimal({ max_turns: 5 }));
    expect(parsed.nodes[0]!.max_turns).toBe(5);
  });

  it('omits max_turns when not provided', () => {
    const { parsed } = parseComposeInput(minimal());
    expect(parsed.nodes[0]!.max_turns).toBeUndefined();
  });

  it('rejects zero max_turns', () => {
    expect(() => parseComposeInput(minimal({ max_turns: 0 }))).toThrow(
      /positive integer/,
    );
  });

  it('rejects negative max_turns', () => {
    expect(() => parseComposeInput(minimal({ max_turns: -1 }))).toThrow(
      /positive integer/,
    );
  });

  it('rejects fractional max_turns', () => {
    expect(() => parseComposeInput(minimal({ max_turns: 2.5 }))).toThrow(
      /positive integer/,
    );
  });

  it('rejects non-number max_turns', () => {
    expect(() => parseComposeInput(minimal({ max_turns: 'five' }))).toThrow(
      /positive integer/,
    );
  });

  it('accepts boundary value 1', () => {
    const { parsed } = parseComposeInput(minimal({ max_turns: 1 }));
    expect(parsed.nodes[0]!.max_turns).toBe(1);
  });

  it('per-node max_turns is independent across nodes', () => {
    const { parsed } = parseComposeInput({
      nodes: [
        { id: 'a', prompt: 'task a', max_turns: 3 },
        { id: 'b', prompt: 'task b' },
      ],
    });
    expect(parsed.nodes[0]!.max_turns).toBe(3);
    expect(parsed.nodes[1]!.max_turns).toBeUndefined();
  });

  it('can combine max_turns and max_tool_rounds on same node', () => {
    const { parsed } = parseComposeInput(minimal({ max_turns: 4, max_tool_rounds: 50 }));
    expect(parsed.nodes[0]!.max_turns).toBe(4);
    expect(parsed.nodes[0]!.max_tool_rounds).toBe(50);
  });
});

describe('parseComposeInput — compose-level fields still work', () => {
  it('accepts max_tool_rounds_per_node at compose level', () => {
    const { parsed } = parseComposeInput(minimal({}, { max_tool_rounds_per_node: 30 }));
    expect(parsed.max_tool_rounds_per_node).toBe(30);
  });

  it('per-node max_tool_rounds coexists with compose-level max_tool_rounds_per_node', () => {
    const { parsed } = parseComposeInput({
      nodes: [{ id: 'a', prompt: 'task a', max_tool_rounds: 7 }],
      max_tool_rounds_per_node: 100,
    });
    expect(parsed.nodes[0]!.max_tool_rounds).toBe(7);
    expect(parsed.max_tool_rounds_per_node).toBe(100);
  });
});
