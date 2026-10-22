type Input = Record<string, unknown>;
type Summarizer = (input: Input) => string;
const text = (input: Input, key: string) => typeof input[key] === 'string' ? input[key] as string : '';
const field = (key: string): Summarizer => input => text(input, key);
const host: Summarizer = input => {
  const url = text(input, 'url');
  try { return new URL(url).host; } catch { return url || text(input, 'query'); }
};

/** One registry for both the compact spine and standalone tool cards. */
const summaries: Record<string, Summarizer> = {
  read_file: field('file_path'), edit_file: field('file_path'), write_file: field('file_path'),
  list_directory: field('path'), extract_document: field('file_path'),
  bash: field('command'), grep: field('pattern'), glob: field('pattern'),
  web_scrape: host, web_request: host, browser_open: host,
  agent: field('prompt'), remote_agent: field('prompt'), skill: field('name'),
};
const pathTools = new Set(['read_file', 'edit_file', 'write_file', 'list_directory', 'extract_document']);

/** Accept structured inputs and legacy ledger previews; never discard an unknown preview. */
export function toolSummary(name: string, preview: string, cwd?: string): string {
  let summary = preview.trim();
  try {
    const input: unknown = JSON.parse(summary);
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      summary = summaries[name]?.(input as Input) || summary;
    }
  } catch { /* Ledger previews are normally already formatted, not JSON. */ }
  if (pathTools.has(name) && cwd) {
    const root = cwd.replace(/[\\/]+$/, '').replaceAll('\\', '/');
    const path = summary.replaceAll('\\', '/');
    if (path.startsWith(`${root}/`)) summary = path.slice(root.length + 1);
  }
  if (['web_scrape', 'web_request', 'browser_open'].includes(name)) {
    try { summary = new URL(summary).host; } catch { /* Search queries stay readable. */ }
  }
  return summary.split(/\r?\n/, 1)[0] ?? '';
}
