// Adapted from .afk/smoke-web.mjs. This foreground harness owns server cleanup.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const server = spawn(process.execPath, ['dist/cli/index.js', 'web', '--no-open', '--port', '4802', '--token', 'smoketoken123', '--model', 'haiku'], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (b) => { log += b; });
server.stderr.on('data', (b) => { log += b; });
let browser;
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
try {
  const deadline = Date.now() + 30000;
  while (!/listening/i.test(log)) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(`Server did not listen: ${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  check('server listening', true);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:4802/?token=smoketoken123', { waitUntil: 'networkidle' });
  await page.getByTitle('New Session').click();
  const box = page.getByPlaceholder('Send a message… (/ for commands)');
  await box.waitFor({ timeout: 15000 });
  for (const command of ['/help', '/tokens', '/info', '/diff', '/mcp']) {
    const response = page.waitForResponse((r) => r.url().endsWith('/commands') && r.request().method() === 'POST');
    await box.fill(command);
    await box.press('Enter');
    const res = await response;
    const body = await res.json();
    check(`${command} HTTP`, res.status() === 200, String(res.status()));
    const region = page.getByRole('region', { name: `Output for ${command}`, exact: true });
    await region.waitFor({ timeout: 15000 });
    const kinds = body.blocks?.map((b) => b.kind ?? 'text') ?? [];
    if (command === '/help') check('help structured list', kinds.includes('list') && await region.locator('li').count() > 0, kinds.join(','));
    if (['/tokens', '/info'].includes(command)) check(`${command} key-value panel`, kinds.includes('keyValue') && await region.locator('dl').count() > 0, kinds.join(','));
    if (command === '/diff') check('diff block or sensible empty', kinds.includes('diff') || /no .*changes|no changes/i.test(await region.innerText()), kinds.join(','));
    await region.scrollIntoViewIfNeeded();
    if (command === '/help') await region.locator('li').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/web-parity-s2-${command.slice(1)}.png` });
    await writeFile(`/tmp/web-parity-s2-${command.slice(1)}.json`, JSON.stringify(body, null, 2));
  }
  check('no console errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  check('smoke harness', false, String(error));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise((resolve) => {
    if (server.exitCode !== null) return resolve();
    const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 5000);
    server.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  await writeFile('/tmp/web-parity-s2-server.log', log);
  await writeFile('/tmp/web-parity-s2-smoke.json', JSON.stringify(checks, null, 2));
}
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
