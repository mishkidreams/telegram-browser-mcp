import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { defaultPaths, loadRuntimeConfig, validateReaderPolicy, mcpEntryEnvironment } from '../src/runtime-config.mjs';

test('platform defaults keep profile data persistent and downloads temporary without prototype names', () => {
  assert.deepEqual(defaultPaths({ platform: 'win32', home: 'C:\\Users\\example', temp: 'C:\\Temp', env: { LOCALAPPDATA: 'C:\\Local' } }), { dataDir: 'C:\\Local\\telegram-browser-mcp', downloadsDir: 'C:\\Temp\\telegram-browser-mcp\\downloads' });
  assert.deepEqual(defaultPaths({ platform: 'darwin', home: '/Users/example', temp: '/tmp', env: {}, uid: 501 }), { dataDir: '/Users/example/Library/Application Support/telegram-browser-mcp', downloadsDir: '/tmp/telegram-browser-mcp-501/downloads' });
  assert.deepEqual(defaultPaths({ platform: 'linux', home: '/home/example', temp: '/tmp', env: { XDG_DATA_HOME: '/data' }, uid: 1000 }), { dataDir: '/data/telegram-browser-mcp', downloadsDir: '/tmp/telegram-browser-mcp-1000/downloads' });
  const config = loadRuntimeConfig({});
  assert.ok(isAbsolute(config.profileDir));
  assert.notEqual(config.profileDir, config.downloadsDir);
  assert.equal(config.browser, 'chromium');
  assert.doesNotMatch(JSON.stringify(config), /prototype/i);
});

test('MCP env is the configuration: exact string IDs, proxy and independent browser profiles', () => {
  const config = loadRuntimeConfig({ TG_ALLOWED_CHAT_IDS: '321, -100123,321,9007199254740993', TG_PROXY: 'http://127.0.0.1:10808', TG_PROXY_USERNAME: 'local-proxy-user', TG_PROXY_PASSWORD: ' whitespace matters ', TG_BROWSER: 'chrome' });
  assert.deepEqual(config.allowedChatIds, ['321', '-100123', '9007199254740993']);
  assert.equal(config.proxy.password, ' whitespace matters ');
  assert.match(config.profileDir, /profile-chrome$/);
  assert.equal(config.browser, 'chrome');
});

test('no allowlist means no grants and malformed lists never become guessed IDs', () => {
  assert.deepEqual(loadRuntimeConfig({}).allowedChatIds, []);
  assert.throws(() => validateReaderPolicy({ allowedChatIds: [] }), /READ_NOT_AUTHORIZED/);
  for (const value of ['0', '+321', '321,,999', 'name', '321.1', '321_22', '[321]', '321,']) assert.throws(() => loadRuntimeConfig({ TG_ALLOWED_CHAT_IDS: value }), /READ_NOT_AUTHORIZED/);
  assert.throws(() => loadRuntimeConfig({ TG_ALLOWED_CHAT_IDS: 321 }), /READ_NOT_AUTHORIZED/);
});

test('configuration rejects arbitrary executables, relative paths and authenticated SOCKS', () => {
  for (const TG_BROWSER of ['firefox', 'my-browser.exe', 'chrome --no-sandbox']) assert.throws(() => loadRuntimeConfig({ TG_BROWSER }), /INVALID_CONFIGURATION/);
  for (const name of ['TG_DATA_DIR', 'TG_PROFILE_DIR', 'TG_DOWNLOADS_DIR']) assert.throws(() => loadRuntimeConfig({ [name]: '../unsafe' }), /INVALID_CONFIGURATION/);
  assert.deepEqual(loadRuntimeConfig({ TG_PROXY: 'https://user:p%40ss%2B%20@example.invalid:443' }).proxy, { server: 'https://example.invalid', username: 'user', password: 'p@ss+ ' });
  assert.throws(() => loadRuntimeConfig({ TG_PROXY: 'socks5://127.0.0.1:1080', TG_PROXY_USERNAME: 'u' }), /SOCKS_AUTH_UNSUPPORTED/);
});
