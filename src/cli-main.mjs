#!/usr/bin/env node
// stdout is reserved for MCP in serve mode. Never print settings, pixels or input.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadRuntimeConfig, mcpEntryEnvironment } from './runtime-config.mjs';
import { ensurePrivateDirectory } from './local-storage.mjs';
import { createReaderServer } from './mcp-server.mjs';
import { startHarness } from './harness.mjs';
import { openOperatorWindow } from './operator-window.mjs';

const actions = new Set(['serve', 'login', 'install-browser']);
const args = process.argv.slice(2), action = args.shift() ?? 'serve';
let harness, viewer;
try {
  if (action === '--help') {
    console.log('telegram-browser-mcp [serve|login|install-browser] [--config MCP_JSON_PATH] [--server telegram-browser]');
  } else {
    if (!actions.has(action)) throw new Error('INVALID_CONFIGURATION');
    let configFile, serverName = 'telegram-browser';
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (!value) throw new Error('INVALID_CONFIGURATION');
      if (flag === '--config' && !configFile) configFile = value;
      else if (flag === '--server' && /^[\w-]+$/.test(value)) serverName = value;
      else throw new Error('INVALID_CONFIGURATION');
    }
    let env = { ...process.env };
    if (configFile) {
      const raw = await readFile(configFile, 'utf8');
      if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('INVALID_CONFIGURATION');
      const entry = JSON.parse(raw)?.mcpServers?.[serverName];
      env = mcpEntryEnvironment(entry);
    }
    const config = loadRuntimeConfig(env);
    // The same resolved configuration supplies the policy both before and after a read.
    const getPolicy = async () => {
      const { validateReaderPolicy } = await import('./runtime-config.mjs');
      return validateReaderPolicy({ allowedChatIds: loadRuntimeConfig(env).allowedChatIds });
    };
    if (action === 'install-browser') {
      if (config.browser === 'chrome') {
        console.log('TG_BROWSER=chrome uses locally installed Google Chrome; install it from Google. No managed Chromium download requested.');
      } else {
        const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
        const child = spawn(process.execPath, [cli, 'install', 'chromium', '--no-shell'], { stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: '1' } });
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        if (code !== 0) throw new Error('BROWSER_INSTALL_FAILED');
      }
    } else {
      await ensurePrivateDirectory(config.dataDir);
      await ensurePrivateDirectory(join(config.dataDir, 'private'));
      await ensurePrivateDirectory(config.profileDir);
      if (action === 'serve') {
        await createReaderServer({ root: config.dataDir, config, getPolicy }).connect(new StdioServerTransport());
      } else {
        harness = await startHarness({ mode: 'telegram', profileDir: config.profileDir, proxy: config.proxy, browser: config.browser });
        const operatorProfile = join(config.dataDir, 'operator-' + config.browser);
        await ensurePrivateDirectory(operatorProfile);
        let cancelled = false;
        viewer = await openOperatorWindow({ profileDir: operatorProfile, viewerUrl: harness.viewerUrl, browser: config.browser, onClosed: () => { cancelled = true; } });
        console.error('Local Telegram login viewer opened. Sign in there, then click Done. No input or screen is recorded.');
        while (!cancelled && harness.status().state === 'NEEDS_USER') await new Promise(resolve => setTimeout(resolve, 250));
        if (cancelled || harness.status().state !== 'READY') throw new Error('LOGIN_NOT_COMPLETED');
        await harness.close(); harness = undefined;
        await viewer.close(); viewer = undefined;
        console.error('LOGIN_COMPLETE');
      }
    }
  }
} catch (error) {
  const safe = new Set(['INVALID_CONFIGURATION', 'READ_NOT_AUTHORIZED', 'PROXY_REQUIRED', 'INVALID_PROXY', 'SOCKS_AUTH_UNSUPPORTED', 'PROFILE_BUSY', 'BROWSER_INSTALL_REQUIRED', 'BROWSER_START_FAILED', 'BROWSER_INSTALL_FAILED', 'TELEGRAM_LOAD_FAILED', 'OPERATOR_WINDOW_FAILED', 'LOGIN_NOT_COMPLETED', 'LOCAL_STORAGE_UNSAFE', 'LOCAL_STORAGE_FAILED']);
  console.error(safe.has(error?.message) ? error.message : 'START_FAILED');
  process.exitCode = 1;
} finally {
  await viewer?.close();
  await harness?.close();
}
