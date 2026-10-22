// Coordinator's independent Stage 1 smoke. Owns its server (port 4801).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.SMOKE_PORT ?? 4801);
const server = spawn(process.execPath, ['dist/cli/index.js', 'web', '--no-open', '--port', String(PORT), '--token', 'smoketoken123', '--model', 'haiku'], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (b) => { log += b; });
server.stderr.on('data', (b) => { log += b; });
const checks = [];
const check = (name, ok, detail = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };
let browser;
try {
  const deadline = Date.now() + 30000;
  while (!/listening/i.test(log)) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(`server did not listen: ${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/?token=smoketoken123`, { waitUntil: 'networkidle' });
  await page.getByTitle('New Session').click();
  const box = page.getByPlaceholder('Send a message… (/ for commands)');
  await box.waitFor({ timeout: 15000 });
  const main = page.locator('main');
  const send = async (text) => {
    const res = page.waitForResponse((r) => r.url().endsWith('/commands') && r.request().method() === 'POST', { timeout: 20000 });
    await box.fill(text);
    await box.press('Enter');
    const r = await res;
    await page.waitForTimeout(1200);
    return r.status();
  };

  check('/name HTTP 200', (await send('/name smoke-test')) === 200);
  check('/name updates sidebar', await page.getByText('smoke-test').first().isVisible().catch(() => false));

  check('/model HTTP 200', (await send('/model sonnet')) === 200);
  const selector = await page.locator('select, [role="combobox"], button').filter({ hasText: /sonnet/i }).count();
  check('/model reflected in UI', selector > 0);

  check('/cost HTTP 200', (await send('/cost')) === 200);
  check('/cost output visible', await main.getByText('Session cost').first().isVisible().catch(() => false));
  check('/clear HTTP 200', (await send('/clear')) === 200);
  check('/clear removes earlier output', !(await main.getByText('Session cost').first().isVisible().catch(() => false)));
  await page.screenshot({ path: '/tmp/web-parity-s1-clear.png' });

  const compactStatus = await send('/compact');
  check('/compact responds without server error', compactStatus < 500, String(compactStatus));
  const bodyText = await main.innerText();
  check('/compact message is not an error dump', !/TypeError|stack|undefined/i.test(bodyText.slice(-600)));
  await page.screenshot({ path: '/tmp/web-parity-s1-compact.png' });

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('harness', false, String(err));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
process.exit(checks.every(Boolean) ? 0 : 1);
