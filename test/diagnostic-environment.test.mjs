import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const help = 'telegram-browser-mcp [serve|login|install-browser] [--config MCP_JSON_PATH] [--server telegram-browser]\n';

async function temporaryRoot(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'telegram-browser-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function environment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(TG_|DEBUG$|DEBUG_FILE$|PWDEBUG|CHROME_LOG_FILE$|npm_(?:package_)?config_pwdebug)/i.test(key)) delete env[key];
  }
  return { ...env, ...overrides };
}

function runCli(args, env) {
  return spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15_000 });
}

test('CLI help never opens an inherited Playwright diagnostic file', async t => {
  const root = await temporaryRoot(t);
  const debugFile = join(root, 'playwright-diagnostics.log');
  const result = runCli([cli, '--help'], environment({
    DEBUG: 'pw:*', PWDEBUG: '1', DEBUG_FILE: debugFile, CHROME_LOG_FILE: join(root, 'chrome-diagnostics.log'),
  }));
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, help);
  assert.equal(result.stderr, '');
  await assert.rejects(access(debugFile), { code: 'ENOENT' });
});

test('CLI clears diagnostics before Playwright initializes while preserving ordinary environment', async t => {
  const root = await temporaryRoot(t);
  // Probe the external dependency boundary, not CLI internals. register() works on Node 22.
  const dependency = `
    for (const key of [
      'DEBUG', 'DEBUG_FILE', 'PWDEBUG', 'PWDEBUGIMPL', 'CHROME_LOG_FILE',
      'npm_config_pwdebug', 'npm_package_config_pwdebug',
      'npm_config_pwdebugimpl', 'npm_package_config_pwdebugimpl',
    ]) {
      if (process.env[key] !== undefined) throw new Error('UNSAFE_DIAGNOSTIC_ENVIRONMENT:' + key);
    }
    if (process.env.DIAGNOSTIC_TEST_ORDINARY !== 'retained'
      || process.env.TG_ALLOWED_CHAT_IDS !== '321,-100123'
      || process.env.PLAYWRIGHT_BROWSERS_PATH !== 'synthetic-browser-cache') throw new Error('ORDINARY_ENVIRONMENT_CHANGED');
    process.stdout.write('PLAYWRIGHT_INITIALIZED_WITH_SAFE_ENV\\n');
    export const chromium = {};
  `;
  const dependencyUrl = 'data:text/javascript,' + encodeURIComponent(dependency);
  const loaderUrl = 'data:text/javascript,' + encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'playwright') return { url: ${JSON.stringify(dependencyUrl)}, shortCircuit: true };
      return nextResolve(specifier, context);
    }
  `);
  const preloadUrl = 'data:text/javascript,' + encodeURIComponent(`
    import { register } from 'node:module';
    register(${JSON.stringify(loaderUrl)});
  `);
  const parentEnvironment = { ...process.env };
  const result = runCli(['--import', preloadUrl, cli, '--help'], environment({
    DEBUG: 'pw:*', DEBUG_FILE: join(root, 'playwright.log'), PWDEBUG: '1', PWDEBUGIMPL: '1',
    CHROME_LOG_FILE: join(root, 'chrome.log'),
    npm_config_pwdebug: 'console', npm_package_config_pwdebug: '1',
    npm_config_pwdebugimpl: '1', npm_package_config_pwdebugimpl: '1',
    DIAGNOSTIC_TEST_ORDINARY: 'retained', TG_ALLOWED_CHAT_IDS: '321,-100123',
    PLAYWRIGHT_BROWSERS_PATH: 'synthetic-browser-cache',
  }));
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'PLAYWRIGHT_INITIALIZED_WITH_SAFE_ENV\n' + help);
  assert.equal(result.stderr, '');
  assert.equal(Object.keys(process.env).length, Object.keys(parentEnvironment).length);
  assert.equal(Object.entries(parentEnvironment).every(([key, value]) => process.env[key] === value), true, 'parent process environment must remain unchanged');
});

test('diagnostic cleanup preserves stdio MCP settings and quiet browser-free local tools', async t => {
  const root = await temporaryRoot(t);
  const data = join(root, 'data'), debugFile = join(root, 'playwright.log');
  const transport = new StdioClientTransport({
    command: process.execPath, args: [cli, 'serve'], stderr: 'pipe',
    env: environment({
      DEBUG: 'pw:*', DEBUG_FILE: debugFile, PWDEBUG: '1', PWDEBUGIMPL: '1',
      CHROME_LOG_FILE: join(root, 'chrome.log'), npm_config_pwdebug: 'console',
      TG_DATA_DIR: data, TG_DOWNLOADS_DIR: join(root, 'downloads'), TG_ALLOWED_CHAT_IDS: '321,-100123',
    }),
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'diagnostic-environment-test', version: '1' });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'telegram-browser-mcp');
    const result = await client.callTool({ name: 'list_allowed_chats', arguments: {} });
    assert.deepEqual(JSON.parse(result.content[0].text).allowedChatIds, ['321', '-100123']);
    const denied = await client.callTool({ name: 'get_recent_messages', arguments: { chatId: '999' } });
    assert.equal(denied.content[0].text, 'ACCESS_DENIED');
  } finally {
    await client.close();
  }
  assert.equal(stderr, '');
  await assert.rejects(access(debugFile), { code: 'ENOENT' });
  await assert.rejects(access(join(data, 'profile-chromium.owner')), { code: 'ENOENT' });
});

test('diagnostic cleanup preserves fixed CLI error codes without echoing input', async t => {
  const root = await temporaryRoot(t);
  const debugFile = join(root, 'playwright.log');
  const result = runCli([cli, 'invalid-SYNTHETIC-SECRET'], environment({
    DEBUG: 'pw:*', DEBUG_FILE: debugFile, PWDEBUG: '1', CHROME_LOG_FILE: join(root, 'chrome.log'),
  }));
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'INVALID_CONFIGURATION\n');
  await assert.rejects(access(debugFile), { code: 'ENOENT' });
});
