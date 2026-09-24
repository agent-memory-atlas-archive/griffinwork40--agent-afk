/**
 * Tests for placeholder detection in agent output.
 *
 * Covers:
 *   - Code block extraction (fenced + inline)
 *   - Each placeholder pattern family
 *   - False-positive suppression (HTML tags, type params, real env vars)
 *   - Stop hook lifecycle (injection, budget, subagent skip)
 *   - End-to-end: realistic agent output with mixed placeholders
 */

import { describe, it, expect } from 'vitest';
import {
  extractCodeBlocks,
  detectPlaceholders,
  createPlaceholderDetectHook,
} from './placeholder-detect.js';
import type { StopContext } from './hooks.js';

// ─── extractCodeBlocks ───────────────────────────────────────────────────────

describe('extractCodeBlocks', () => {
  it('extracts fenced code blocks', () => {
    const text = 'Run this:\n```bash\nssh user@host\n```\nDone.';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toBe('ssh user@host\n');
  });

  it('extracts multiple fenced blocks', () => {
    const text = '```\nfirst\n```\ntext\n```\nsecond\n```';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('first');
    expect(blocks[1]).toContain('second');
  });

  it('extracts inline code spans', () => {
    const text = 'Run `ssh your-user@host` to connect.';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toBe('ssh your-user@host');
  });

  it('does not double-extract inline code inside fenced blocks', () => {
    const text = '```\nuse `foo` here\n```\nAlso run `bar`.';
    const blocks = extractCodeBlocks(text);
    // fenced block content + inline `bar`
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('use `foo` here');
    expect(blocks[1]).toBe('bar');
  });

  it('returns empty for text with no code', () => {
    expect(extractCodeBlocks('Just some prose.')).toHaveLength(0);
  });

  it('handles tilde-fenced blocks', () => {
    const text = '~~~\ncommand here\n~~~';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('command here');
  });
});

// ─── detectPlaceholders — pattern families ───────────────────────────────────

describe('detectPlaceholders — angle-bracket', () => {
  it('detects angle-bracket placeholders in code blocks', () => {
    const text = '```\nssh <your-user>@<your-host>\n```';
    const matches = detectPlaceholders(text);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.map((m) => m.match)).toContain('<your-user>');
    expect(matches.map((m) => m.match)).toContain('<your-host>');
  });

  it('detects <insert-token-here> style', () => {
    const text = '```\ncurl -H "Authorization: Bearer <insert-token-here>"\n```';
    const matches = detectPlaceholders(text);
    expect(matches.some((m) => m.match === '<insert-token-here>')).toBe(true);
  });

  it('ignores HTML tags', () => {
    const text = '```html\n<div><span>hello</span></div>\n```';
    const matches = detectPlaceholders(text);
    expect(matches).toHaveLength(0);
  });

  it('ignores TypeScript generic type parameters', () => {
    const text = '```ts\nfunction foo<T>(x: T): Array<string> {}\n```';
    const matches = detectPlaceholders(text);
    expect(matches).toHaveLength(0);
  });

  it('ignores single-letter generics', () => {
    const text = '```\nMap<K, V>\n```';
    const matches = detectPlaceholders(text);
    expect(matches).toHaveLength(0);
  });
});

describe('detectPlaceholders — screaming-snake', () => {
  it('detects YOUR_API_KEY', () => {
    const text = '```\nexport TOKEN=YOUR_API_KEY\n```';
    const matches = detectPlaceholders(text);
    expect(matches.some((m) => m.match === 'YOUR_API_KEY')).toBe(true);
  });

  it('detects REPLACE_WITH_TOKEN', () => {
    const text = '`REPLACE_WITH_TOKEN`';
    const matches = detectPlaceholders(text);
    expect(matches.some((m) => m.match === 'REPLACE_WITH_TOKEN')).toBe(true);
  });

  it('detects INSERT_PASSWORD_HERE', () => {
    const text = '```\nDB_PASS=INSERT_PASSWORD_HERE\n```';
    const matches = detectPlaceholders(text);
    expect(matches.some((m) => m.match === 'INSERT_PASSWORD_HERE')).toBe(true);
  });

  it('does not flag real env var patterns without placeholder prefix', () => {
    const text = '```\nexport NODE_ENV=production\nDATABASE_URL=postgres://...\n```';
    const matches = detectPlaceholders(text);
    // NODE_ENV, DATABASE_URL should not trigger
    expect(matches.filter((m) => m.pattern === 'screaming-snake')).toHaveLength(0);
  });
});

describe('detectPlaceholders — your-prefix', () => {
  it('detects your-user', () => {
    const text = '```\nssh your-user@192.168.1.1\n```';
    const matches = detectPlaceholders(text);
    expect(matches.some((m) => m.match === 'your-user')).toBe(true);
  });

  it('detects your_password', () => {
    const text = '`mysql -p your_password`';
    const matches = detectPlaceholders(text);
    expect(matches.some((m) => m.match === 'your_password')).toBe(true);
  });

  it('detects your-api-key', () => {
    const text = '```\ncurl -H "X-API-Key: your-api-key" https://api.com\n```';
    const matches = detectPlaceholders(text);
    expect(matches.some((m) => m.match === 'your-api-key')).toBe(true);
  });
});

describe('detectPlaceholders — example domain', () => {
  it('detects example.com', () => {
    const text = '```\ncurl https://example.com/api/v1\n```';
    const matches = detectPlaceholders(text);
    expect(matches.some((m) => m.pattern === 'example-domain')).toBe(true);
  });

  it('detects user@example.com', () => {
    const text = '`git config user.email user@example.com`';
    const matches = detectPlaceholders(text);
    expect(matches.some((m) => m.match === 'user@example.com')).toBe(true);
  });

  it('detects example.org and example.net', () => {
    const text = '```\nping example.org\ndig example.net\n```';
    const matches = detectPlaceholders(text);
    expect(matches.filter((m) => m.pattern === 'example-domain')).toHaveLength(2);
  });
});

describe('detectPlaceholders — xxx-run', () => {
  it('detects xxx.xxx.xxx.xxx as IP placeholder', () => {
    const text = '```\nssh root@xxx.xxx.xxx.xxx\n```';
    const matches = detectPlaceholders(text);
    expect(matches.some((m) => m.pattern === 'xxx-run')).toBe(true);
  });

  it('detects xxxx-xxxx-xxxx', () => {
    const text = '`TOKEN=xxxx-xxxx-xxxx`';
    const matches = detectPlaceholders(text);
    expect(matches.some((m) => m.pattern === 'xxx-run')).toBe(true);
  });
});

describe('detectPlaceholders — replace-me', () => {
  it('detects REPLACE_ME', () => {
    const text = '```\nAPI_KEY=REPLACE_ME\n```';
    const matches = detectPlaceholders(text);
    expect(matches.some((m) => m.match === 'REPLACE_ME')).toBe(true);
  });

  it('detects CHANGEME', () => {
    const text = '`password: CHANGEME`';
    const matches = detectPlaceholders(text);
    expect(matches.some((m) => m.match === 'CHANGEME')).toBe(true);
  });

  it('detects PLACEHOLDER', () => {
    const text = '```\nconst url = "PLACEHOLDER"\n```';
    const matches = detectPlaceholders(text);
    expect(matches.some((m) => m.match === 'PLACEHOLDER')).toBe(true);
  });
});

// ─── detectPlaceholders — false-positive resistance ──────────────────────────

describe('detectPlaceholders — false positives', () => {
  it('does not flag prose outside code blocks', () => {
    const text = 'Replace your-api-key with the actual key.';
    expect(detectPlaceholders(text)).toHaveLength(0);
  });

  it('deduplicates repeated matches', () => {
    const text = '```\nssh your-user@host1\nssh your-user@host2\n```';
    const matches = detectPlaceholders(text);
    const yourUserMatches = matches.filter((m) => m.match === 'your-user');
    expect(yourUserMatches).toHaveLength(1);
  });

  it('does not flag common HTML elements', () => {
    const text = '```html\n<div><p>text</p><br><img><a href="x">link</a></div>\n```';
    expect(detectPlaceholders(text)).toHaveLength(0);
  });

  it('does not flag primitive type names', () => {
    const text = '```ts\nconst x: Array<string> = [];\nconst y: Map<number, boolean> = new Map();\n```';
    expect(detectPlaceholders(text)).toHaveLength(0);
  });
});

// ─── End-to-end: realistic agent output ──────────────────────────────────────

describe('detectPlaceholders — realistic output', () => {
  it('catches the original failure case: ssh your-user@mac-mini-ip', () => {
    const text = [
      'To connect to your Mac Mini:',
      '',
      '```bash',
      '# SSH into the Mac Mini first',
      'ssh your-user@mac-mini-ip',
      '',
      '# Enable the screen sharing service',
      'sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist',
      '```',
      '',
      'Then from your MacBook Pro:',
      '',
      '```bash',
      'open vnc://mac-mini-ip',
      '```',
    ].join('\n');

    const matches = detectPlaceholders(text);
    expect(matches.some((m) => m.match === 'your-user')).toBe(true);
    // mac-mini-ip triggers via angle-bracket or your-prefix depending on context
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('catches curl with placeholder token', () => {
    const text = [
      'Make the API call:',
      '',
      '```bash',
      'curl -X POST https://api.example.com/v1/data \\',
      '  -H "Authorization: Bearer YOUR_API_TOKEN" \\',
      '  -H "Content-Type: application/json"',
      '```',
    ].join('\n');

    const matches = detectPlaceholders(text);
    expect(matches.some((m) => m.match === 'YOUR_API_TOKEN')).toBe(true);
    expect(matches.some((m) => m.pattern === 'example-domain')).toBe(true);
  });

  it('does not flag resolved commands', () => {
    const text = [
      'Run this:',
      '',
      '```bash',
      'ssh griffin@192.168.1.42',
      'open vnc://Griffins-Mac-mini.local',
      '```',
    ].join('\n');

    expect(detectPlaceholders(text)).toHaveLength(0);
  });
});

// ─── Stop hook lifecycle ─────────────────────────────────────────────────────

describe('createPlaceholderDetectHook', () => {
  const makeStopContext = (text?: string, overrides?: Partial<StopContext>): StopContext & { lastAssistantText?: string } => ({
    event: 'Stop',
    sessionId: 's-1',
    ...overrides,
    ...(text !== undefined ? { lastAssistantText: text } : {}),
  });

  it('returns injectContext when placeholders are found', () => {
    const hook = createPlaceholderDetectHook();
    const result = hook(makeStopContext('Run `ssh your-user@host` to connect.'));
    expect(result.injectContext).toBeDefined();
    expect(result.injectContext).toContain('placeholder-detect');
    expect(result.injectContext).toContain('your-user');
  });

  it('returns empty decision when no placeholders found', () => {
    const hook = createPlaceholderDetectHook();
    const result = hook(makeStopContext('Run `ssh griffin@192.168.1.42` to connect.'));
    expect(result.injectContext).toBeUndefined();
  });

  it('returns empty decision when lastAssistantText is absent', () => {
    const hook = createPlaceholderDetectHook();
    const result = hook(makeStopContext());
    expect(result.injectContext).toBeUndefined();
  });

  it('skips subagent turns (parentSessionId set)', () => {
    const hook = createPlaceholderDetectHook();
    const result = hook(makeStopContext(
      'Run `ssh your-user@host`',
      { parentSessionId: 'parent-1' },
    ));
    expect(result.injectContext).toBeUndefined();
  });

  it('respects injection budget (max 2 per session)', () => {
    const hook = createPlaceholderDetectHook();
    const text = 'Run `ssh your-user@host` now.';

    const r1 = hook(makeStopContext(text));
    expect(r1.injectContext).toBeDefined();

    const r2 = hook(makeStopContext(text));
    expect(r2.injectContext).toBeDefined();

    // Third injection should be suppressed (budget exhausted)
    const r3 = hook(makeStopContext(text));
    expect(r3.injectContext).toBeUndefined();
  });

  it('ignores non-Stop events', () => {
    const hook = createPlaceholderDetectHook();
    const result = hook({ event: 'SessionEnd', sessionId: 's-1' });
    expect(result.injectContext).toBeUndefined();
  });

  it('does not block — decision field is never set', () => {
    const hook = createPlaceholderDetectHook();
    const result = hook(makeStopContext('Run `ssh your-user@host`.'));
    expect(result.decision).toBeUndefined();
    expect(result.continue).toBeUndefined();
  });
});
