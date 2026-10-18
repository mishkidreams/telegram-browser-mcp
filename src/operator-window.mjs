// Human-only localhost viewer. Never expose its context, frames or capability to MCP.
import { isAbsolute } from 'node:path';
import { chromium } from 'playwright';

export async function openOperatorWindow({ profileDir, viewerUrl, browser = 'chromium', onClosed = () => {} }) {
  let context, closing = false, notified = false;
  const notify = () => {
    if (!closing && !notified) { notified = true; onClosed(); }
  };
  try {
    const url = new URL(viewerUrl);
    if (!['chromium', 'chrome'].includes(browser) || !isAbsolute(profileDir) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || !/^#[A-Za-z0-9_-]{43}$/.test(url.hash)) throw new Error();
    // Let Playwright apply the supported Chromium launch configuration, then
    // explicitly navigate. A raw executable spawn left an empty app window on
    // this machine, even with a valid server and a fresh operator profile.
    context = await chromium.launchPersistentContext(profileDir, {
      channel: browser, headless: false, chromiumSandbox: true,
      viewport: { width: 1280, height: 900 }, acceptDownloads: false,
      ignoreHTTPSErrors: false, timeout: 15_000,
      args: ['--no-proxy-server', '--disable-extensions', '--disable-sync', '--disable-background-mode', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      env: { ...process.env, DEBUG: '', PWDEBUG: '', CHROME_LOG_FILE: '' },
    });
    // The operator frontend is local-only. The separate real Telegram context
    // keeps its configured mandatory proxy; do not change that connection.
    const assets = new Set(['/', '/viewer.js', '/viewer.css']);
    await context.route('**/*', route => {
      const request = route.request();
      let target;
      try { target = new URL(request.url()); } catch { return route.abort(); }
      return target.origin === url.origin && assets.has(target.pathname) && !target.search && request.method() === 'GET' ? route.continue() : route.abort();
    });
    const page = context.pages()[0] ?? await context.newPage();
    page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
    page.on('popup', popup => void popup.close().catch(() => {}));
    page.on('close', notify);
    context.on('close', notify);
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    // These checks read only the local viewer's static controls and whether an
    // image has loaded, never Telegram DOM, pixels, QR tokens or input values.
    await page.waitForFunction(() => {
      const image = document.querySelector('#screen');
      return document.querySelector('#state')?.textContent === 'NEEDS_USER' && !!document.querySelector('#resume') && image && !image.hidden && image.naturalWidth > 0;
    }, null, { timeout: 5000 });
    return {
      async close() {
        if (closing) return;
        closing = true;
        await context.close().catch(() => {});
      },
    };
  } catch {
    closing = true;
    await context?.close().catch(() => {});
    // Browser errors can contain the capability URL. Never pass them upstream.
    throw new Error('OPERATOR_WINDOW_FAILED');
  }
}
