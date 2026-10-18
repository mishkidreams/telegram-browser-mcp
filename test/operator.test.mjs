import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startHarness, validateProxy } from '../src/harness.mjs';
import { WebSocket } from 'ws';
import { request } from 'node:http';

test('same-page human input, explicit resume and synthetic profile persistence after restart', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-viewer-test-'));
  let harness, viewer;
  t.after(async () => {
    await viewer?.close();
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  });
  harness = await startHarness({ mode: 'fixture', profileDir: join(root, 'profile') });
  assert.equal(harness.status().state, 'NEEDS_USER');
  await assert.rejects(harness.readFixture(), /NEEDS_USER/);
  viewer = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: true });
  const page = await viewer.newPage();
  await page.goto(harness.viewerUrl);
  await page.locator('#screen').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#screen').naturalWidth > 0);
  const scale = await page.locator('#screen').evaluate(img => img.clientWidth / 1280);
  await page.locator('#screen').click({ position: { x: 80 * scale, y: 120 * scale } });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'screen');
  await page.keyboard.type('LOCAL-HUMAN-ONLY');
  assert.equal(await page.locator('#notice').textContent(), '');
  const rect = await page.locator('#screen').boundingBox();
  await page.mouse.move(rect.x + 507 * scale, rect.y + 120 * scale);
  await page.mouse.down();
  await page.mouse.move(rect.x + 799 * scale, rect.y + 120 * scale, { steps: 6 });
  await page.mouse.up();
  await page.locator('#screen').click({ position: { x: 100 * scale, y: 185 * scale } });
  await page.locator('#resume').click();
  await page.waitForFunction(() => document.querySelector('#state').textContent === 'READY');
  assert.deepEqual(await harness.readFixture(), { text: 'LOCAL-HUMAN-ONLY', solved: true, slider: 100 });
  assert.equal(harness.status().state, 'READY');
  await viewer.close(); viewer = undefined;
  await harness.close(); harness = undefined;
  harness = await startHarness({ mode: 'fixture', profileDir: join(root, 'profile') });
  assert.deepEqual(await harness.checkClientUi(), { signedInUiDetected: true });
});

async function fixtureHarness(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'telegram-viewer-security-'));
  const h = await startHarness({ mode: 'fixture', profileDir: join(root, 'profile'), ...options });
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }); });
  return h;
}
function openOperator(h, overrides = {}) {
  const url = new URL(h.viewerUrl);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${url.host}/operator`, ['operator-v1', overrides.token ?? url.hash.slice(1)], { origin: overrides.origin ?? url.origin });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, response) => { ws.terminate(); reject(new Error(`HTTP_${response.statusCode}`)); });
    ws.on('error', () => reject(new Error('SOCKET_FAILED')));
  });
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('STATE_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('operator socket rejects wrong capability, foreign Origin and a second operator', async t => {
  const h = await fixtureHarness(t);
  await assert.rejects(openOperator(h, { token: 'A'.repeat(43) }), /HTTP_403/);
  await assert.rejects(openOperator(h, { origin: 'https://untrusted.example' }), /HTTP_403/);
  const ws = await openOperator(h);
  await assert.rejects(openOperator(h), /HTTP_403/);
  ws.close();
  await until(() => !h.status().operatorConnected);
  assert.equal(h.status().state, 'NEEDS_USER');
});

test('unverified completion stays paused and cancellation cannot resume work', async t => {
  const h = await fixtureHarness(t);
  const ws = await openOperator(h);
  ws.send(JSON.stringify({ type: 'resume' }));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(h.status().state, 'NEEDS_USER');
  ws.send(JSON.stringify({ type: 'cancel' }));
  await until(() => h.status().state === 'BLOCKED');
  await assert.rejects(h.readFixture(), /BLOCKED/);
  ws.send(JSON.stringify({ type: 'resume' }));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.status().state, 'BLOCKED');
  ws.close();
});

test('operator timeout fails closed', async t => {
  const h = await fixtureHarness(t, { timeoutMs: 100 });
  await until(() => h.status().state === 'BLOCKED');
  await assert.rejects(h.readFixture(), /BLOCKED/);
  await assert.rejects(openOperator(h), /HTTP_403/);
});

test('a second process cannot open the same profile through this harness', async t => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-profile-lock-'));
  const profileDir = join(root, 'profile');
  const h = await startHarness({ mode: 'fixture', profileDir });
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(startHarness({ mode: 'fixture', profileDir }), /PROFILE_BUSY/);
});

test('HTTP viewer rejects rebinding Host and forbids caching', async t => {
  const h = await fixtureHarness(t);
  const url = new URL(h.viewerUrl); url.hash = '';
  const get = host => new Promise((resolve, reject) => {
    const req = request(url, { headers: { Host: host } }, res => { res.resume(); resolve({ code: res.statusCode, cache: res.headers['cache-control'] }); });
    req.on('error', reject); req.end();
  });
  assert.equal((await get('attacker.example')).code, 403);
  assert.deepEqual(await get(url.host), { code: 200, cache: 'no-store' });
});

test('unreachable explicit proxy fails instead of opening Telegram directly', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-proxy-failure-'));
  try {
    await assert.rejects(startHarness({ mode: 'telegram', profileDir: join(root, 'profile'), proxy: { server: 'http://127.0.0.1:9' } }), /TELEGRAM_LOAD_FAILED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Telegram requires an explicit valid proxy and refuses direct fallback configuration', async () => {
  assert.throws(() => validateProxy(), /PROXY_REQUIRED/);
  assert.deepEqual(validateProxy({ server: 'http://username:password@localhost:8080' }), { server: 'http://localhost:8080', username: 'username', password: 'password' });
  assert.throws(() => validateProxy({ server: 'http://localhost:8080', bypass: '*' }), /INVALID_PROXY/);
  assert.throws(() => validateProxy({ server: 'socks5://localhost:8080', username: 'x' }), /SOCKS_AUTH_UNSUPPORTED/);
  assert.deepEqual(validateProxy({ server: 'http://localhost:8080', username: 'x', password: ' y ' }), { server: 'http://localhost:8080', username: 'x', password: ' y ' });
});
