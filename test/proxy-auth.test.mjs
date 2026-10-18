import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { normalizeProxy } from '../src/proxy-config.mjs';

test('inline proxy credentials reach a real Chromium HTTP proxy authentication handshake', { timeout: 20_000 }, async () => {
  const expected = 'Basic ' + Buffer.from('fixture-user:p@ss:word+ ').toString('base64');
  let authenticated = false, challenges = 0, browser;
  const sockets = new Set();
  const proxy = createServer((request, response) => {
    if (request.headers['proxy-authorization'] !== expected) {
      challenges++;
      response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="synthetic-fixture"', 'Connection': 'close' });
      response.end();
      return;
    }
    if (request.url === 'http://proxy-fixture.invalid/proof') {
      authenticated = true;
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('SYNTHETIC_PROXY_OK');
    } else { response.writeHead(404); response.end(); }
  });
  proxy.on('connect', (_request, socket) => socket.destroy());
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true,
      proxy: normalizeProxy('http://fixture-user:p%40ss%3Aword%2B%20@127.0.0.1:' + proxy.address().port) });
    const page = await browser.newPage();
    await page.goto('http://proxy-fixture.invalid/proof');
    assert.equal(await page.textContent('body'), 'SYNTHETIC_PROXY_OK');
    assert.equal(authenticated, true);
    assert.ok(challenges >= 1);
  } finally {
    await browser?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => proxy.close(resolve));
  }
});
