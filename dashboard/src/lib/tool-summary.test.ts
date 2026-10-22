import { describe, it, expect } from 'vitest';
import { toolSummary } from './tool-summary';

describe('toolSummary', () => {
  it.each(['read_file', 'edit_file', 'write_file'])('shows distinct cwd-relative %s paths', name => {
    expect(toolSummary(name, '{"file_path":"/repo/a/config.ts"}', '/repo')).toBe('a/config.ts');
    expect(toolSummary(name, ' /repo/b/config.ts', '/repo/')).toBe('b/config.ts');
    expect(toolSummary(name, '/repository/a.ts', '/repo')).toBe('/repository/a.ts');
    expect(toolSummary(name, 'C:\\repo\\a.ts', 'C:\\repo')).toBe('a.ts');
  });
  it.each([
    ['bash', '{"command":"echo first\\necho second"}', 'echo first'],
    ['grep', '{"pattern":"foo|bar","path":"/repo"}', 'foo|bar'],
    ['glob', '{"pattern":"**/*.ts"}', '**/*.ts'],
    ['web_request', '{"url":"https://example.com/path"}', 'example.com'],
    ['web_scrape', 'https://example.com/path', 'example.com'],
    ['web_scrape', '{"query":"test search"}', 'test search'],
    ['agent', '{"prompt":"Investigate the renderer\\nCarefully"}', 'Investigate the renderer'],
    ['unknown', ' raw preview ', 'raw preview'],
    ['read_file', '{"file_path":', '{"file_path":'],
    ['bash', 'echo first\necho second', 'echo first'],
    ['read_file', 'null', 'null'],
  ])('summarizes %s %s', (name, input, expected) => expect(toolSummary(name, input)).toBe(expected));
});
