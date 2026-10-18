import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeConfig, mcpEntryEnvironment } from '../src/runtime-config.mjs';

test('explicit MCP config strips every inherited TG setting while preserving OS context', () => {
  const ambient = { PATH: '/bin', HOME: '/example', TG_ALLOWED_CHAT_IDS: '999', TG_PROXY: 'bad', TG_BROWSER: 'wrong', TG_PROFILE_DIR: '../unsafe', TG_UNRECOGNIZED: 'ambient' };
  const env = mcpEntryEnvironment({ env: { TG_PROXY: 'http://127.0.0.1:10808', TG_ALLOWED_CHAT_IDS: '321' } }, ambient);
  assert.deepEqual(env, { PATH: '/bin', HOME: '/example', TG_PROXY: 'http://127.0.0.1:10808', TG_ALLOWED_CHAT_IDS: '321' });
  const config = loadRuntimeConfig(env);
  assert.equal(config.browser, 'chromium');
  assert.deepEqual(config.allowedChatIds, ['321']);
  assert.ok(config.profileDir.endsWith('profile-chromium'));
  assert.deepEqual(loadRuntimeConfig(mcpEntryEnvironment({}, ambient)).allowedChatIds, []);
});

test('config substitutions are explicit and safe; malformed/unknown settings fail without revealing values', () => {
  assert.deepEqual(mcpEntryEnvironment({ env: { TG_PROXY_PASSWORD: '${MY_PROXY_PASSWORD}' } }, { MY_PROXY_PASSWORD: ' secret whitespace ' }).TG_PROXY_PASSWORD, ' secret whitespace ');
  for (const entry of [undefined, { env: [] }, { env: null }, { env: { TG_PROXY: 42 } }, { env: { TG_PROXYY: 'secret' } }, { env: { TG_PROXY: '!command secret' } }, { env: { TG_PROXY: '${MISSING_SECRET}' } }]) {
    assert.throws(() => mcpEntryEnvironment(entry, {}), error => error.message === 'INVALID_CONFIGURATION');
  }
});
