import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const out = path.resolve('.afk/layout-smoke');
await mkdir(out, { recursive: true });
const state = await mkdtemp(path.join(os.tmpdir(), 'afk-layout-'));
const port = 4812, token = 'layout-local-smoke';
const result = { state, assertions: [], errors: [], posts: [], screenshots: [] };
let log = '', browser;
const server = spawn(process.execPath, ['dist/cli/index.js', 'web', '--no-open', '--port', String(port), '--token', token, '--model', 'haiku'], {
  env: { ...process.env, AFK_STATE_DIR: state }, stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { log += chunk; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function pass(name) { result.assertions.push({ name, status: 'PASS' }); console.log(`PASS ${name}`); }
async function shot(page, name) { const file = `${out}/${name}.png`; await page.screenshot({ path: file }); result.screenshots.push(file); }
try {
  const deadline = Date.now() + 30000;
  while (!/listening/.test(log)) { if (server.exitCode !== null || Date.now() > deadline) throw new Error(log); await sleep(100); }
  assert.match(log, new RegExp(`:${port}`));
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (message) => { if (message.type() === 'error') result.errors.push(message.text()); });
  page.on('pageerror', (error) => result.errors.push(String(error)));
  page.on('request', (request) => {
    if (request.url().endsWith('/api/sessions') && request.method() === 'POST') result.posts.push(request.postDataJSON());
  });
  await page.goto(`http://127.0.0.1:${port}/?token=${token}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Your next idea starts here' }).waitFor();
  await shot(page, '01-welcome-desktop');
  const box = () => page.locator('textarea');
  const create = async () => {
    const response = page.waitForResponse((r) => r.url().endsWith('/api/sessions') && r.request().method() === 'POST');
    await page.getByTitle('New Session', { exact: true }).click();
    await page.getByTitle('New Session', { exact: true }).filter({ hasText: 'Starting…' }).waitFor();
    assert.equal(await page.getByTitle('New Session', { exact: true }).isDisabled(), true);
    const data = await (await response).json();
    await box().waitFor({ timeout: 30000 });
    await page.waitForFunction((id) => new URL(location.href).searchParams.get('session') === id, data.session.id);
    return data.session.id;
  };
  const first = await create();
  pass('welcome and clear Starting… state');
  assert.equal(result.posts[0].model, undefined);
  await page.getByTitle('Session model', { exact: true }).filter({ hasText: 'haiku' }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Model', exact: true }).inputValue(), 'haiku');
  const label = await page.getByRole('combobox', { name: 'Model', exact: true }).locator('option:checked').textContent();
  assert.match(label, /Claude Haiku/);
  pass('launch --model haiku honored: POST omits override, header and picker show Haiku');
  await page.getByRole('button', { name: 'Explore this project', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea')?.value === 'Give me a concise overview of this project and its architecture.');
  assert.equal(await box().inputValue(), 'Give me a concise overview of this project and its architecture.');
  pass('suggestion fills editable composer');
  await shot(page, '02-suggestions-desktop');
  const command = async (text) => { await box().fill(text); await box().press('Enter'); await page.waitForFunction(() => document.querySelector('textarea')?.value === ''); };
  await command('/cost');
  await page.locator('main').getByText('/cost', { exact: true }).waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await box().waitFor();
  assert.equal(new URL(page.url()).searchParams.get('session'), first);
  await page.locator('main').getByText('/cost', { exact: true }).waitFor();
  await page.getByTitle('Session model', { exact: true }).filter({ hasText: 'haiku' }).waitFor();
  pass('reload restores selected session, command history, and authoritative model');
  await box().fill('Do not use tools. Write a markdown guide of about 1000 words with 18 numbered sections about clear technical writing. Start with LAYOUT_BEGIN and finish with LAYOUT_END.');
  await box().press('Enter');
  await page.getByTitle('Stop', { exact: true }).waitFor({ timeout: 20000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await box().waitFor();
  assert.equal(new URL(page.url()).searchParams.get('session'), first);
  await page.getByTitle('Stop', { exact: true }).waitFor({ timeout: 15000 });
  pass('mid-turn reload restores the same live conversation and Stop');
  await page.waitForFunction(() => document.querySelector('main')?.textContent?.includes('LAYOUT_END') && !document.querySelector('button[title="Stop"]'), null, { timeout: 120000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('main')?.textContent?.includes('LAYOUT_END'));
  pass('reload restores completed transcript');
  const transcript = page.getByTestId('transcript-scroll');
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    await sleep(400);
    await transcript.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    await sleep(300);
    const geometry = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { transcript: rect('[data-testid="transcript-scroll"]'), drawer: rect('[role="dialog"][aria-label="Sidebar"]'), drawerChild: rect('[role="dialog"][aria-label="Sidebar"] aside'), composer: rect('textarea'), dock: rect('[data-testid="composer-dock"]'), header: rect('main header'), viewport: { width: innerWidth, height: innerHeight }, scrollHeight: document.querySelector('[data-testid="transcript-scroll"]').scrollHeight };
    });
    result[name] = geometry;
    assert.ok(geometry.scrollHeight > geometry.transcript.height + 200, 'must test a genuinely long transcript');
    assert.ok(geometry.composer.y >= 0 && geometry.composer.bottom <= viewport.height, 'composer visible at transcript top');
    assert.ok(geometry.composer.right <= viewport.width, 'composer fits horizontally');
    assert.ok(geometry.header.bottom <= geometry.transcript.top + 1, 'header stays outside transcript');
    if (name === 'mobile') {
      assert.ok(Math.max(geometry.drawer.right, geometry.drawerChild.right) <= geometry.transcript.left + 0.5, 'closed drawer zero overlap');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
    }
    const jump = page.getByRole('button', { name: 'New messages', exact: true });
    await jump.waitFor();
    const jumpBox = await jump.boundingBox();
    assert.ok(jumpBox.y + jumpBox.height <= geometry.dock.y + 1, 'jump above composer dock');
    await shot(page, `03-long-top-${name}`);
    await jump.click();
    await page.waitForFunction(() => { const e = document.querySelector('[data-testid="transcript-scroll"]'); return e.scrollHeight - e.scrollTop - e.clientHeight < 55; });
    pass(`${name}: composer fixed in viewport, transcript-only scroll, jump to latest`);
    if (name === 'mobile') {
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
      await sleep(250);
      await shot(page, '04-mobile-drawer-open');
      const idle = page.locator('[role="dialog"][aria-label="Sidebar"] aside .group').filter({ hasText: 'Idle' });
      assert.ok(await idle.count() > 0);
      assert.equal(await idle.locator('.animate-pulse').count(), 0);
      pass('idle session badge does not animate');
      await page.mouse.click(370, 400);
      await sleep(300);
      assert.ok((await page.locator('[role="dialog"][aria-label="Sidebar"]').boundingBox()).x + (await page.locator('[role="dialog"][aria-label="Sidebar"]').boundingBox()).width <= 0.5);
      await shot(page, '05-mobile-drawer-closed');
      pass('mobile closed drawer zero overlap after open/close');
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const second = await create();
  assert.notEqual(first, second);
  await page.goBack();
  await page.waitForFunction((id) => new URL(location.href).searchParams.get('session') === id && document.querySelector('main')?.textContent?.includes('LAYOUT_END'), first);
  await page.goForward();
  await page.waitForFunction((id) => new URL(location.href).searchParams.get('session') === id && document.querySelector('main')?.textContent?.includes('What can we work on?'), second);
  pass('back and forward switch conversations and transcript');
  await box().fill('/model');
  await box().press('Enter');
  const choice = page.getByRole('dialog').filter({ has: page.getByRole('radiogroup') });
  await choice.waitFor();
  await choice.getByRole('radio').filter({ hasText: 'haiku · Claude Haiku' }).waitFor();
  await shot(page, '06-model-choice-desktop');
  await choice.getByRole('button', { name: 'Cancel', exact: true }).click();
  pass('slash model dialog shows resolved human-readable labels');
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('sonnet');
  await page.waitForFunction(() => document.querySelector('[title="Session model"]')?.textContent?.includes('sonnet'));
  await create();
  assert.equal(result.posts.at(-1).model, 'sonnet');
  await page.getByTitle('Session model', { exact: true }).filter({ hasText: 'sonnet' }).waitFor();
  pass('deliberate model choice is preserved in new-session POST and header');
  assert.deepEqual(result.errors, []);
  pass('no browser console or page errors');
} catch (error) {
  result.error = String(error.stack ?? error);
  console.error(result.error);
  if (browser) { const pages = browser.contexts().flatMap((context) => context.pages()); if (pages[0]) await shot(pages[0], 'failure'); }
  process.exitCode = 1;
} finally {
  await writeFile(`${out}/results.json`, JSON.stringify(result, null, 2));
  await writeFile(`${out}/server.log`, log);
  await browser?.close();
  server.kill('SIGTERM');
  for (let i = 0; i < 50 && server.exitCode === null; i++) await sleep(100);
  if (server.exitCode === null) server.kill('SIGKILL');
  console.log(JSON.stringify(result, null, 2));
}
