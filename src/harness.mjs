// Private browser runtime. No generic browser controls exposed to MCP.
import { createServer } from 'node:http';
import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { chromium } from 'playwright';
import { createChatReader } from './chat-reader.mjs';
import { createConversationReader } from './conversation-reader.mjs';
import { readAccountIdentity as inspectAccountIdentity } from './message-metadata.mjs';
import { normalizeProxy } from './proxy-config.mjs';

const WIDTH = 1280, HEIGHT = 800;
const ASSETS = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/viewer.js', ['viewer.js', 'text/javascript; charset=utf-8']], ['/viewer.css', ['viewer.css', 'text/css; charset=utf-8']]]);
const fixture = `<!doctype html><meta charset="utf-8"><title>Local synthetic challenge</title>
<style>body{font:20px sans-serif;margin:0;background:#eef3f8;color:#142033}h1{position:absolute;left:40px;top:15px;font-size:24px}input{position:absolute;left:40px;top:100px;width:340px;height:36px;font-size:20px}button{position:absolute;left:40px;top:165px;width:300px;height:40px;font-size:18px}#result{position:absolute;left:40px;top:230px}</style>
<h1>Локальная проверка: введи любой текст и нажми кнопку</h1><input id="answer" autocomplete="off"><input id="slider" type="range" min="0" max="100" value="0" style="left:500px;width:300px"><button id="solve">Подтвердить на этой странице</button><p id="result">Это не Telegram и не настоящая CAPTCHA.</p>
<script>document.querySelector('#answer').value=localStorage.getItem('synthetic-answer')||'';document.body.dataset.solved=localStorage.getItem('synthetic-solved')||'';document.querySelector('#solve').onclick=()=>{localStorage.setItem('synthetic-answer',document.querySelector('#answer').value);localStorage.setItem('synthetic-solved','yes');document.body.dataset.solved='yes';document.querySelector('#result').textContent='Подтверждено в той же headless-вкладке';};</script>`;

function equalToken(value, token) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && value.length === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token));
}

export const validateProxy = normalizeProxy;

export async function startHarness({ mode, profileDir, proxy, browser = 'chromium', timeoutMs = 15 * 60_000, readPolicy }) {
  if (!['chromium', 'chrome'].includes(browser) || !['fixture', 'telegram'].includes(mode) || !isAbsolute(profileDir) || !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30 * 60_000) throw new Error('INVALID_CONFIGURATION');
  if (mode === 'telegram') proxy = validateProxy(proxy);
  await mkdir(profileDir, { recursive: true });
  let lease;
  try { lease = await open(profileDir + '.owner', 'wx'); } catch { throw new Error('PROFILE_BUSY'); }
  await lease.writeFile(String(process.pid));
  const token = randomBytes(32).toString('base64url');
  let state = 'NEEDS_USER', context, page, cdp, socket, port, reader, conversation, closed = false, timer, streamStarted = false;
  let inputTail = Promise.resolve();
  const status = () => ({ mode, state, headless: true, operatorConnected: socket?.readyState === WebSocket.OPEN, liveReadImplemented: !!reader });
  const send = value => { if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 2_000_000) socket.send(JSON.stringify(value)); };
  const sendStatus = () => send({ type: 'status', ...status(), pageOrigin: page ? new URL(page.url()).origin : null });
  const ready = async () => {
    if (!page || page.isClosed()) return false;
    if (mode === 'fixture') return page.evaluate(() => document.body.dataset.solved === 'yes');
    return page.evaluate(() => location.origin === 'https://web.telegram.org' && location.pathname.startsWith('/a/') && !!document.querySelector('#LeftColumn') && !!document.querySelector('#MiddleColumn'));
  };
  const stopStream = async () => {
    if (streamStarted) { streamStarted = false; await cdp?.send('Page.stopScreencast').catch(() => {}); }
  };
  const headers = () => ({ 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
  const server = createServer(async (req, res) => {
    if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const asset = ASSETS.get(req.url);
    if (!asset) { res.writeHead(404).end(); return; }
    try {
      const body = await readFile(new URL('../web/' + asset[0], import.meta.url));
      res.writeHead(200, { ...headers(), 'Content-Type': asset[1] }).end(body);
    } catch { res.writeHead(500).end('VIEWER_UNAVAILABLE'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false, handleProtocols: protocols => protocols.has('operator-v1') ? 'operator-v1' : false });
  server.on('upgrade', (req, netSocket, head) => {
    const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map(v => v.trim());
    const origin = `http://127.0.0.1:${port}`;
    const auth = protocols.length === 2 && protocols[0] === 'operator-v1' && equalToken(protocols[1], token);
    if (req.url !== '/operator' || req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== origin || !auth || state !== 'NEEDS_USER' || socket) {
      netSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, netSocket, head, ws => wss.emit('connection', ws, req));
  });

  async function input(message) {
    if (state !== 'NEEDS_USER') throw new Error('OPERATOR_INACTIVE');
    if (!message || typeof message !== 'object') throw new Error('INVALID_INPUT');
    if (message.type === 'pointer') {
      if (!['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(message.event) || !Number.isFinite(message.x) || !Number.isFinite(message.y) || message.x < 0 || message.x >= WIDTH || message.y < 0 || message.y >= HEIGHT || !['none', 'left', 'right', 'middle'].includes(message.button) || !Number.isInteger(message.buttons) || message.buttons < 0 || message.buttons > 7) throw new Error('INVALID_INPUT');
      const params = { type: message.event, x: message.x, y: message.y, button: message.button, buttons: message.buttons, clickCount: ['mousePressed', 'mouseReleased'].includes(message.event) ? 1 : 0 };
      if (message.event === 'mouseWheel') { if (![message.deltaX, message.deltaY].every(n => Number.isFinite(n) && Math.abs(n) <= 4000)) throw new Error('INVALID_INPUT'); params.deltaX = message.deltaX; params.deltaY = message.deltaY; }
      await cdp.send('Input.dispatchMouseEvent', params);
    } else if (message.type === 'key') {
      if (!['keyDown', 'keyUp'].includes(message.event) || typeof message.key !== 'string' || message.key.length > 40 || typeof message.code !== 'string' || message.code.length > 40 || !Number.isInteger(message.modifiers) || message.modifiers < 0 || message.modifiers > 15 || typeof message.text !== 'string' || message.text.length > 8 || !Number.isInteger(message.virtualKey) || message.virtualKey < 0 || message.virtualKey > 255) throw new Error('INVALID_INPUT');
      await cdp.send('Input.dispatchKeyEvent', { type: message.event, key: message.key, code: message.code, modifiers: message.modifiers, text: message.text, windowsVirtualKeyCode: message.virtualKey });
    } else if (message.type === 'text') {
      if (typeof message.text !== 'string' || message.text.length > 2048) throw new Error('INVALID_INPUT');
      await cdp.send('Input.insertText', { text: message.text });
    } else if (message.type === 'resume') {
      if (await ready()) { state = 'READY'; clearTimeout(timer); await stopStream(); } else send({ type: 'notice', code: 'NOT_READY' });
      sendStatus();
    } else if (message.type === 'cancel') {
      state = 'BLOCKED'; clearTimeout(timer); await stopStream(); sendStatus();
    } else throw new Error('INVALID_INPUT');
  }

  wss.on('connection', ws => {
    socket = ws;
    ws.on('error', () => {});
    ws.on('message', raw => {
      // Never log raw messages: these may contain a human's password or code.
      inputTail = inputTail.then(async () => { if (socket !== ws) return; await input(JSON.parse(raw.toString('utf8'))); }).catch(() => send({ type: 'notice', code: 'INPUT_REJECTED' }));
    });
    ws.on('close', () => { if (socket === ws) { socket = undefined; void stopStream(); } });
    sendStatus();
    void (async () => {
      try {
        streamStarted = true;
        await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 75, maxWidth: WIDTH, maxHeight: HEIGHT });
        const frame = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 75 });
        send({ type: 'frame', data: frame.data, width: WIDTH, height: HEIGHT });
      } catch { send({ type: 'notice', code: 'STREAM_UNAVAILABLE' }); }
    })();
  });

  async function close() {
    if (closed) return;
    closed = true; clearTimeout(timer); state = 'CLOSED';
    socket?.terminate();
    await stopStream();
    await context?.close().catch(() => {});
    wss.close();
    server.closeAllConnections();
    await new Promise(resolve => server.listening ? server.close(resolve) : resolve());
    await lease.close(); await unlink(profileDir + '.owner').catch(() => {});
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    port = server.address().port;
    context = await chromium.launchPersistentContext(profileDir, { channel: browser, headless: true, chromiumSandbox: true, viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, acceptDownloads: false, ignoreHTTPSErrors: false, ...(mode === 'telegram' ? { proxy } : {}), args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'], env: { ...process.env, DEBUG: '', PWDEBUG: '', CHROME_LOG_FILE: '' } });
    page = context.pages()[0] ?? await context.newPage();
    page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
    if (mode === 'fixture') {
      // A stable synthetic origin permits a genuine persistence test. All fixture
      // requests are intercepted locally; no .invalid network request is made.
      await context.route('**/*', route => route.request().url() === 'https://fixture.invalid/' ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture }) : route.abort());
      await page.goto('https://fixture.invalid/', { waitUntil: 'domcontentloaded' });
    } else await page.goto('https://web.telegram.org/a/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (mode === 'telegram' && readPolicy) {
      reader = createChatReader(page, readPolicy);
      conversation = createConversationReader(page, { baseReader: reader, allowedChatIds: readPolicy.allowedChatIds, timeoutMs: readPolicy.timeoutMs });
    }
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) sendStatus(); });
    cdp = await context.newCDPSession(page);
    cdp.on('Page.screencastFrame', frame => {
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      if (state === 'NEEDS_USER') send({ type: 'frame', data: frame.data, width: WIDTH, height: HEIGHT });
    });
    timer = setTimeout(() => { state = 'BLOCKED'; void stopStream(); sendStatus(); }, timeoutMs);
    timer.unref();
    return {
      viewerUrl: `http://127.0.0.1:${port}/#${token}`, status, close,
      async readFixture() {
        if (state !== 'READY') throw new Error(state);
        if (mode !== 'fixture') throw new Error('FIXTURE_ONLY');
        return page.evaluate(() => ({ text: document.querySelector('#answer').value, solved: document.body.dataset.solved === 'yes', slider: Number(document.querySelector('#slider').value) }));
      },
      async checkClientUi() { return { signedInUiDetected: await ready() }; },
      async readAccountIdentity() {
        if (!reader) throw new Error('READ_NOT_AUTHORIZED');
        if (socket || !['NEEDS_USER', 'READY'].includes(state)) throw new Error('READ_UNAVAILABLE');
        clearTimeout(timer); state = 'READING';
        try { return await inspectAccountIdentity(page); }
        finally { if (!closed) state = 'READY'; }
      },
      async readContext(request) {
        if (!conversation) throw new Error('READ_NOT_AUTHORIZED');
        if (socket || !['NEEDS_USER', 'READY'].includes(state)) throw new Error('READ_UNAVAILABLE');
        clearTimeout(timer); state = 'READING';
        try { return await conversation.context(request); }
        finally { if (!closed) state = 'READY'; }
      },
      async listTopics(request) {
        if (!conversation) throw new Error('READ_NOT_AUTHORIZED');
        if (socket || !['NEEDS_USER', 'READY'].includes(state)) throw new Error('READ_UNAVAILABLE');
        clearTimeout(timer); state = 'READING';
        try { return await conversation.topics(request); }
        finally { if (!closed) state = 'READY'; }
      },
      async readTopicHistory(request) {
        if (!conversation) throw new Error('READ_NOT_AUTHORIZED');
        if (socket || !['NEEDS_USER', 'READY'].includes(state)) throw new Error('READ_UNAVAILABLE');
        clearTimeout(timer); state = 'READING';
        try { return await conversation.topicHistory(request); }
        finally { if (!closed) state = 'READY'; }
      },
      async readMetadata(request) {
        if (!reader) throw new Error('READ_NOT_AUTHORIZED');
        if (socket || !['NEEDS_USER', 'READY'].includes(state)) throw new Error('READ_UNAVAILABLE');
        clearTimeout(timer); state = 'READING';
        try { return await reader.metadata(request); }
        finally { if (!closed) state = 'READY'; }
      },
      async resolveUsername(request) {
        if (!reader) throw new Error('READ_NOT_AUTHORIZED');
        if (socket || !['NEEDS_USER', 'READY'].includes(state)) throw new Error('READ_UNAVAILABLE');
        clearTimeout(timer); state = 'READING';
        try { return await reader.resolveUsername(request); }
        finally { if (!closed) state = 'READY'; }
      },
      async readMessage(request) {
        if (!reader) throw new Error('READ_NOT_AUTHORIZED');
        if (socket || !['NEEDS_USER', 'READY'].includes(state)) throw new Error('READ_UNAVAILABLE');
        clearTimeout(timer); state = 'READING';
        try { return await reader.message(request); }
        finally { if (!closed) state = 'READY'; }
      },
      async readAttachment(request) {
        if (!reader) throw new Error('READ_NOT_AUTHORIZED');
        if (socket || !['NEEDS_USER', 'READY'].includes(state)) throw new Error('READ_UNAVAILABLE');
        clearTimeout(timer); state = 'READING';
        try { return await reader.attachment(request); }
        finally { if (!closed) state = 'READY'; }
      },
      async readPostComments(request) {
        if (!reader) throw new Error('READ_NOT_AUTHORIZED');
        if (socket || !['NEEDS_USER', 'READY'].includes(state)) throw new Error('READ_UNAVAILABLE');
        clearTimeout(timer); state = 'READING';
        try { return await reader.comments(request); }
        finally { if (!closed) state = 'READY'; }
      },
      async searchMessages(request) {
        if (!reader) throw new Error('READ_NOT_AUTHORIZED');
        if (socket || !['NEEDS_USER', 'READY'].includes(state)) throw new Error('READ_UNAVAILABLE');
        clearTimeout(timer); state = 'READING';
        try { return await reader.search(request); }
        finally { if (!closed) state = 'READY'; }
      },
      async readHistory(request) {
        if (!reader) throw new Error('READ_NOT_AUTHORIZED');
        if (socket || !['NEEDS_USER', 'READY'].includes(state)) throw new Error('READ_UNAVAILABLE');
        clearTimeout(timer); state = 'READING';
        try { return await reader.history(request); }
        finally { if (!closed) state = 'READY'; }
      },
      async readLatest(request) {
        if (!reader) throw new Error('READ_NOT_AUTHORIZED');
        if (socket || !['NEEDS_USER', 'READY'].includes(state)) throw new Error('READ_UNAVAILABLE');
        clearTimeout(timer); state = 'READING';
        try { return await reader.latest(request); }
        finally { if (!closed) state = 'READY'; }
      },
    };
  } catch (error) {
    await close();
    if (String(error).includes("Executable doesn't exist")) throw new Error('BROWSER_INSTALL_REQUIRED');
    throw new Error(mode === 'telegram' ? 'TELEGRAM_LOAD_FAILED' : 'BROWSER_START_FAILED');
  }
}
