import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createReaderServer } from '../src/mcp-server.mjs';
import { ensurePrivateDirectory } from '../src/local-storage.mjs';
import { loadRuntimeConfig } from '../src/runtime-config.mjs';

test('configured stdio entry reads MCP env, ignores hidden policy files and opens no browser', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'telegram-browser-config-'));
  const data = join(root, 'data'), downloads = join(root, 'downloads');
  // These accidental inherited values must NOT become settings in --config mode.
  const inherited = { TG_ALLOWED_CHAT_IDS: '999', TG_PROXY: 'not-a-proxy', TG_BROWSER: 'arbitrary.exe', TG_PROFILE_DIR: '../wrong' };
  // Model app-created storage, not the token-dependent owner of plain mkdir.
  await ensurePrivateDirectory(join(data, 'private'));
  await writeFile(join(data, 'private/reader-policy.json'), JSON.stringify({ allowedChatIds: ['999'] }));
  await writeFile(join(data, 'private/config.json'), JSON.stringify({ accidentalSecret: 'LEGACY-SECRET' }));
  const path = join(root, 'mcp.json');
  await writeFile(path, JSON.stringify({ mcpServers: {
    unrelated: { env: { SECRET: 'OTHER-SERVER-SECRET' } },
    'telegram-browser': { command: 'node', args: ['example'], env: { TG_DATA_DIR: data, TG_DOWNLOADS_DIR: downloads, TG_ALLOWED_CHAT_IDS: '321,-100123' } },
  } }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'serve', '--config', path], env: inherited, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', b => { stderr += b; });
  const client = new Client({ name: 'config-test', version: '1' });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  assert.equal(client.getServerVersion().name, 'telegram-browser-mcp');
  assert.equal(client.getServerVersion().version, '0.8.3');
  const result = await client.callTool({ name: 'list_allowed_chats', arguments: {} });
  assert.deepEqual(JSON.parse(result.content[0].text).allowedChatIds, ['321', '-100123']);
  const denied = await client.callTool({ name: 'get_recent_messages', arguments: { chatId: '999' } });
  assert.equal(denied.content[0].text, 'ACCESS_DENIED');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|999/);
  assert.equal(stderr, '');
  await assert.rejects(access(join(data, 'profile-chromium.owner')));
  await assert.rejects(access(downloads));
});

test('configured TEMP destination saves original bytes outside profile data', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'telegram-browser-export-'));
  const config = loadRuntimeConfig({ TG_DATA_DIR: join(root, 'persistent'), TG_DOWNLOADS_DIR: join(root, 'temporary', 'downloads'), TG_ALLOWED_CHAT_IDS: '321' });
  await ensurePrivateDirectory(config.dataDir);
  await ensurePrivateDirectory(join(config.dataDir, 'private'));
  const bytes = Buffer.from('untrusted file; never execute');
  const server = createReaderServer({ config, getPolicy: async () => ({ allowedChatIds: ['321'] }), execute: async ({ chatId, messageId, attachmentIndex }) => ({ peerId: chatId, messageId, attachmentIndex, source: 'official-web-dom', contentIsUntrusted: true, kind: 'file', filename: '../file.pdf', data: bytes.toString('base64'), variant: 'original' }) });
  const client = new Client({ name: 'export-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  await server.connect(st); await client.connect(ct);
  const result = await client.callTool({ name: 'get_attachment', arguments: { attachmentRef: 'tga1:321:12:0', mode: 'download' } });
  assert.notEqual(result.isError, true);
  const file = JSON.parse(result.content[0].text);
  assert.equal(file.filename, 'file.pdf');
  assert.equal(file.localPath.startsWith(config.downloadsDir), true);
  assert.equal(file.localPath.startsWith(config.dataDir), false);
  assert.deepEqual(await readFile(file.localPath), bytes);
});
