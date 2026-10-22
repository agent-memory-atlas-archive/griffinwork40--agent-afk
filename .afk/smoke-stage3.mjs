// Real built-server Stage 1/2/3 browser smoke. Run from repository root via a temporary root .mjs
// so Playwright resolves. No mocked requests/events/providers. Owns only its spawned server.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const PORT = Number(process.env.SMOKE_PORT ?? 4806);
const BASE = `http://127.0.0.1:${PORT}`;
const PREFIX = '/tmp/web-parity-s3';
const TOKEN = 'smoketoken123';
const checks = [], errors = [], screenshots = [], commandBodies = [];
let log = '', browser, page, sessionId;
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const server = spawn(process.execPath, ['dist/cli/index.js', 'web', '--no-open', '--port', String(PORT), '--token', TOKEN, '--model', 'haiku'], { stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', b => { log += b; });
server.stderr.on('data', b => { log += b; });
const shot = async (name) => { const path = `${PREFIX}-${name}.png`; await page.screenshot({ path }); screenshots.push(path); return path; };
try {
  const deadline = Date.now() + 30000;
  while (!/listening/i.test(log)) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(`Server did not listen: ${log}`);
    await new Promise(r => setTimeout(r, 100));
  }
  check('server listening on owned port', true, String(PORT));
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'networkidle' });
  const created = page.waitForResponse(r => /\/api\/sessions$/.test(r.url()) && r.request().method() === 'POST');
  await page.getByTitle('New Session').click();
  const creation = await (await created).json();
  sessionId = creation.session?.id ?? creation.session?.sessionId ?? creation.id ?? creation.sessionId;
  const box = page.getByPlaceholder('Send a message… (/ for commands)');
  await box.waitFor({ timeout: 15000 });
  // Observe a second genuine SSE subscription, for exact progress/turn evidence.
  if (!sessionId) sessionId = await page.evaluate(() => location.hash.match(/session[=/]([^/]+)/)?.[1]);
  if (!sessionId) throw new Error(`No session id in creation: ${JSON.stringify(creation)}`);
  await page.evaluate(({ sessionId, TOKEN }) => {
    window.__smokeFrames = []; window.__smokeProgressDom = [];
    const observer = new MutationObserver(() => {
      const el = document.querySelector('[aria-label="Command progress"]');
      if (el) window.__smokeProgressDom.push({ at: Date.now(), text: el.textContent });
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    void (async () => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stream`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        pending += decoder.decode(value, { stream: true });
        const frames = pending.split('\n\n'); pending = frames.pop();
        for (const frame of frames) for (const line of frame.split('\n')) if (line.startsWith('data:')) {
          try { window.__smokeFrames.push({ at: Date.now(), data: JSON.parse(line.slice(5)) }); } catch {}
        }
      }
    })().catch(e => { window.__smokeStreamError = String(e); });
  }, { sessionId, TOKEN });
  const startCommand = async text => {
    const response = page.waitForResponse(r => r.url().endsWith('/commands') && r.request().method() === 'POST', { timeout: 150000 });
    void response.catch(() => {}); // A failed UI action must not prevent finally/server cleanup.
    await box.fill(text); await box.press('Enter'); return { response };
  };
  const finishCommand = async (text, pending) => {
    const res = await pending.response, body = await res.json();
    commandBodies.push({ text, status: res.status(), body });
    await page.getByRole('region', { name: `Output for ${text}`, exact: true }).last().waitFor({ timeout: 20000 });
    check(`${text} HTTP 200`, res.status() === 200, String(res.status()));
    return body;
  };
  const command = async text => finishCommand(text, await startCommand(text));
  await command('/name smoke-stage3');
  check('S1 name updates sidebar', await page.getByText('smoke-stage3', { exact: true }).first().isVisible());
  await command('/model haiku');
  check('S1 explicit model reflects in UI', await page.getByRole('combobox', { name: 'Model' }).inputValue() === 'haiku');
  await command('/cost');
  check('S1 cost visible', await page.locator('main').getByText('Session cost').first().isVisible());
  await command('/clear');
  check('S1 clear removes earlier output', await page.getByRole('region', { name: 'Output for /cost', exact: true }).count() === 0);
  await shot('clear');
  for (const text of ['/help', '/tokens', '/info', '/diff', '/mcp']) {
    const body = await command(text), region = page.getByRole('region', { name: `Output for ${text}`, exact: true }).last();
    const kinds = body.blocks?.map(b => b.kind ?? 'text') ?? [];
    if (text === '/help') check('S2 help structured list', kinds.includes('list') && await region.locator('li').count() > 0, kinds.join(','));
    if (['/tokens', '/info'].includes(text)) check(`S2 ${text} key-value panel`, kinds.includes('keyValue') && await region.locator('dl').count() > 0, kinds.join(','));
    if (text === '/diff') check('S2 diff block or sensible empty', kinds.includes('diff') || /no .*changes|no changes/i.test(await region.innerText()), kinds.join(','));
    await region.scrollIntoViewIfNeeded(); await shot(text.slice(1));
  }
  let pending = await startCommand('/model');
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 15000 });
  check('S3 bare model opens real choice dialog', await dialog.getByRole('radiogroup', { name: 'Choices' }).isVisible(), await dialog.innerText());
  const geometry = await dialog.evaluate(el => {
    const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const choices = el.querySelector('[role="radiogroup"]');
    return { viewport: { width: innerWidth, height: innerHeight }, dialog: rect(el), title: rect(el.querySelector('h2')), footer: rect(el.lastElementChild), choices: { ...rect(choices), scrollHeight: choices.scrollHeight, clientHeight: choices.clientHeight, overflowY: getComputedStyle(choices).overflowY }, optionCount: choices.children.length };
  });
  for (const part of ['dialog', 'title', 'footer']) {
    const r = geometry[part];
    check(`S3 ${part} fully inside viewport`, r.x >= 0 && r.y >= 0 && r.right <= geometry.viewport.width && r.bottom <= geometry.viewport.height && r.height > 0, JSON.stringify(r));
  }
  check('S3 long catalog scrolls only choices', geometry.optionCount >= 20 && geometry.choices.scrollHeight > geometry.choices.clientHeight && geometry.choices.overflowY === 'auto', JSON.stringify(geometry));
  await writeFile(`${PREFIX}-choice-geometry.json`, JSON.stringify(geometry, null, 2));
  await dialog.getByRole('radio', { name: 'sonnet', exact: true }).click();
  check('S3 pointer selects sonnet radio', await dialog.getByRole('radio', { name: 'sonnet', exact: true }).getAttribute('aria-checked') === 'true');
  await shot('choice-fixed');
  await dialog.getByRole('button', { name: 'Select', exact: true }).click();
  await finishCommand('/model', pending);
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => /sonnet/i.test(document.querySelector('[aria-label="Model"]')?.value ?? ''));
  check('S3 choose sonnet updates model header', /sonnet/i.test(await page.getByRole('combobox', { name: 'Model' }).inputValue()));
  await shot('sonnet');
  pending = await startCommand('/model');
  await dialog.waitFor(); await dialog.press('Escape');
  const cancelled = await finishCommand('/model', pending);
  await dialog.waitFor({ state: 'hidden' });
  check('S3 Escape cancels without changing sonnet', /sonnet/i.test(await page.getByRole('combobox', { name: 'Model' }).inputValue()), JSON.stringify(cancelled));
  await shot('cancel');
  // Seed via actual provider through the UI, not journal injection. Three turns exceed default keep=2.
  await command('/model haiku');
  let seeded = 0;
  for (let i = 1; i <= 3; i++) {
    const startIndex = await page.evaluate(() => window.__smokeFrames.length);
    const promptResponse = page.waitForResponse(r => r.url().endsWith('/prompt') && r.request().method() === 'POST', { timeout: 15000 });
    await box.fill(`Smoke test turn ${i}: reply with only the word READY. Do not use tools.`); await box.press('Enter');
    const res = await promptResponse;
    check(`real provider seed ${i} accepted`, res.status() === 202, String(res.status()));
    try { await page.waitForFunction(start => window.__smokeFrames.slice(start).some(f => f.data?.record?.kind === 'done' || f.data?.record?.event?.type === 'done' || f.data?.event?.type === 'done' || f.data?.type === 'done'), startIndex, { timeout: 60000 }); }
    catch { check(`real provider seed ${i} completed`, false, 'No genuine done event within 60s; inspect frames/server log'); break; }
    const frames = await page.evaluate(start => window.__smokeFrames.slice(start), startIndex);
    const failed = frames.some(f => f.data?.record?.kind === 'error' || /"type":"error"/.test(JSON.stringify(f.data)));
    const hasText = frames.some(f => f.data?.record?.kind === 'assistant' && !!f.data.record.text || /"type":"text"|"type":"text_delta"/.test(JSON.stringify(f.data)));
    check(`real provider seed ${i} completed`, !failed && hasText, JSON.stringify(frames).slice(-1800));
    if (failed || !hasText) break;
    seeded++; await page.waitForTimeout(300);
  }
  const frameIndex = await page.evaluate(() => window.__smokeFrames.length);
  pending = await startCommand('/compact');
  let progressVisible = false;
  try { await page.getByLabel('Command progress', { exact: true }).waitFor({ timeout: 20000 }); progressVisible = true; await shot('progress'); }
  catch { await shot('progress-not-visible'); }
  const compactBody = await finishCommand('/compact', pending);
  await page.getByLabel('Command progress', { exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
  const progressFrames = await page.evaluate(start => window.__smokeFrames.slice(start).filter(f => f.data?.type === 'progress'), frameIndex);
  check('S3 compact genuine progress start/end correlated', progressFrames.some(f => f.data.phase === 'start') && progressFrames.some(f => f.data.phase === 'end' && progressFrames.some(s => s.data.phase === 'start' && s.data.corrId === f.data.corrId)), JSON.stringify(progressFrames));
  check('S3 compact progress visible and screenshot captured', progressVisible, `seeded real provider turns=${seeded}`);
  const compactRegion = page.getByRole('region', { name: 'Output for /compact', exact: true });
  const compactText = await compactRegion.innerText();
  check('S1/S3 compact result sensible and no error dump', !/TypeError|stack|undefined/i.test(compactText), compactText);
  check('S3 actual summarization exercised', seeded === 3 && /compacted/i.test(compactText) && !/not compact|skipp|too short|nothing|failed|could not/i.test(compactText), JSON.stringify(compactBody));
  await compactRegion.scrollIntoViewIfNeeded(); await shot('compact-result');
} catch (error) {
  check('smoke harness', false, error.stack ?? String(error));
  if (page) await shot('failure').catch(() => {});
} finally {
  if (page) {
    await writeFile(`${PREFIX}-frames.json`, JSON.stringify(await page.evaluate(() => ({ sessionId: location.href, frames: window.__smokeFrames, progressDom: window.__smokeProgressDom, streamError: window.__smokeStreamError })).catch(() => ({})), null, 2));
    await writeFile(`${PREFIX}-page.txt`, await page.locator('body').innerText().catch(() => 'page unavailable'));
  }
  check('no browser console/page errors', errors.length === 0, errors.join(' | '));
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(resolve => {
    if (server.exitCode !== null) return resolve();
    const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 5000);
    server.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  check('owned server stopped', server.exitCode !== null || server.signalCode !== null, `exit=${server.exitCode} signal=${server.signalCode}`);
  await writeFile(`${PREFIX}-server.log`, log);
  await writeFile(`${PREFIX}-commands.json`, JSON.stringify(commandBodies, null, 2));
  await writeFile(`${PREFIX}-smoke.json`, JSON.stringify({ checks, errors, screenshots, sessionId }, null, 2));
}
process.exitCode = checks.every(c => c.ok) ? 0 : 1;
