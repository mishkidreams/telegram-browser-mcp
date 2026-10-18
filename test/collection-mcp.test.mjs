import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createReaderServer } from '../src/mcp-server.mjs';
import { collectFromBrowser } from '../src/collection-reader.mjs';

const body = result => JSON.parse(result.content[0].text);
async function fixture(t, execute) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tg-collection-mcp-')));
  let allowedChatIds = ['123', '456'];
  const config = { dataDir: root, profileDir: join(root, 'profile'), downloadsDir: join(root, 'downloads') };
  const server = createReaderServer({ root, config, execute, getPolicy: async () => ({ allowedChatIds }) });
  const client = new Client({ name: 'collection-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  await server.connect(b); await client.connect(a);
  return { root, client, revoke: id => { allowedChatIds = allowedChatIds.filter(x => x !== id); } };
}

test('one collection persists all evidence before byte paging and later local pages never execute a browser', async t => {
  let offline = false;
  const all = Array.from({ length: 60 }, (_, i) => ({ chatId: i < 30 ? '123' : '456', id: String(i + 1), text: 'Данные😀\\\"'.repeat(120), timestamp: '2026-10-18T10:30:00.000Z', timeZone: 'UTC', timestampSource: 'official-web-dom:message-time-title', attachments: [], privateToken: 'NEVER-EGRESS' }));
  const { client, revoke } = await fixture(t, async ({ operation, onPage }) => {
    assert.equal(offline, false, 'local reads must not open the browser adapter');
    assert.equal(operation, 'collect_messages');
    const value = { accountId: '42', source: 'official-web-dom', contentIsUntrusted: true, messages: all,
      coverage: ['123', '456'].map(chatId => ({ chatId, status: 'complete', stopReason: 'TIME_BOUNDARY' })), checkpoint: null };
    await onPage(value);
    return value;
  });
  const tools = await client.listTools();
  assert.equal(tools.tools.find(t => t.name === 'collect_messages').inputSchema.properties.limit.default, 50);
  let response = await client.callTool({ name: 'collect_messages', arguments: { since: '2026-10-18T10:00:00Z', until: '2026-10-18T11:00:00Z' } });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  let result = body(response);
  assert.ok(Buffer.byteLength(response.content[0].text) <= 16 * 1024);
  assert.equal(result.collectedCount, 60);
  assert.doesNotMatch(JSON.stringify(result), /NEVER-EGRESS/);
  const snapshot = (await readFile(join(result.snapshotPath, 'messages.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(snapshot.length, 60);
  assert.doesNotMatch(JSON.stringify(snapshot), /NEVER-EGRESS/);
  offline = true;
  const text = new Map();
  while (true) {
    for (const message of result.messages) text.set(message.messageRef, (text.get(message.messageRef) ?? '') + message.text);
    if (!result.next) break;
    response = await client.callTool({ name: result.next.tool, arguments: result.next.arguments });
    assert.notEqual(response.isError, true);
    assert.ok(Buffer.byteLength(response.content[0].text) <= 16 * 1024);
    result = body(response);
  }
  assert.equal(text.size, 60);
  assert.ok([...text.values()].every(value => value === all[0].text));
  const local = body(await client.callTool({ name: 'collect_messages', arguments: { source: 'local', since: '2026-10-18T10:00:00Z', until: '2026-10-18T11:00:00Z' } }));
  assert.equal(local.collectedCount, 60);
  const wider = body(await client.callTool({ name: 'collect_messages', arguments: { source: 'local', since: '2026-10-01T00:00:00Z', until: '2026-10-31T00:00:00Z' } }));
  assert.equal(wider.collectionStatus, 'partial', 'prior complete coverage must not prove a different requested interval');
  const exact = body(await client.callTool({ name: 'get_message', arguments: { source: 'local', messageRef: 'tgm1:123:1' } }));
  assert.equal(exact.message.text, all[0].text);
  revoke('456');
  const denied = await client.callTool({ name: 'collect_messages', arguments: { source: 'local', since: '2026-10-18T10:00:00Z', until: '2026-10-18T11:00:00Z', chatIds: ['456'] } });
  assert.equal(denied.content[0].text, 'ACCESS_DENIED');
});

test('a public scan resumes a temporary native history stall from its saved cursor and preserves earlier evidence', async t => {
  const calls = [];
  let recovering = false;
  const evidence = { timeZone: 'UTC', timestampSource: 'official-web-dom:message-time-title', attachments: [] };
  const { client } = await fixture(t, async ({ request, checkpoint, onPage, signal }) => {
    const result = await collectFromBrowser({ request, checkpoint, signal,
      onPage: value => onPage({ ...value, accountId: '42' }),
      reader: {
        async readLatest() { calls.push('latest'); return { peerId: '123', source: 'official-web-dom', contentIsUntrusted: true, messages: [{ ...evidence, id: '5', text: 'first evidence', timestamp: '2026-10-18T10:30:00.000Z' }], nextBefore: '5' }; },
        async readHistory({ before }) {
          calls.push(before);
          assert.equal(before, '5');
          if (!recovering) throw new Error('HISTORY_NOT_LOADED');
          return { peerId: '123', source: 'official-web-dom', contentIsUntrusted: true, messages: [
            { ...evidence, id: '3', text: 'older boundary', timestamp: '2026-10-18T09:30:00.000Z' },
            { ...evidence, id: '4', text: 'recovered evidence', timestamp: '2026-10-18T10:10:00.000Z' },
          ], nextBefore: '3' };
        },
      },
    });
    return { ...result, accountId: '42' };
  });
  const first = body(await client.callTool({ name: 'collect_messages', arguments: { chatIds: ['123'], since: '2026-10-18T10:00:00Z', until: '2026-10-18T11:00:00Z' } }));
  assert.equal(first.collectedCount, 1);
  assert.equal(first.collectionStatus, 'partial');
  assert.ok(first.resume, 'the public response must not discard a recoverable native cursor');
  const stored = (await readFile(join(first.snapshotPath, 'messages.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(stored.map(message => message.id), ['5']);
  recovering = true;
  const response = await client.callTool({ name: first.resume.tool, arguments: first.resume.arguments });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  const resumed = body(response);
  assert.deepEqual(calls, ['latest', '5', '5']);
  assert.deepEqual(new Set(resumed.messages.map(message => message.id)), new Set(['4', '5']));
  assert.equal(resumed.resume, null);
  assert.equal(resumed.collectionStatus, 'complete');
  assert.ok(Buffer.byteLength(response.content[0].text) <= 16 * 1024);
});

test('local context infers the stored anchor topic and never merges another verified topic', async t => {
  const messages = ['7', '8', '9'].map((id, index) => ({ id, chatId: '123', text: id, attachments: [], topic: { id: index === 1 ? '2' : '1', name: 'topic' }, timestamp: '2026-10-18T10:30:00.000Z', timeZone: 'UTC', timestampSource: 'official-web-dom:message-time-title' }));
  const { client } = await fixture(t, async ({ onPage }) => {
    const value = { accountId: '42', source: 'official-web-dom', contentIsUntrusted: true, messages, coverage: [{ chatId: '123', status: 'partial', stopReason: 'TOPIC_LIST_NOT_PROVEN_EXHAUSTIVE' }], checkpoint: null };
    await onPage(value); return value;
  });
  const collected = await client.callTool({ name: 'collect_messages', arguments: { chatIds: ['123'], since: '2026-10-18T10:00:00Z', until: '2026-10-18T11:00:00Z' } });
  assert.notEqual(collected.isError, true);
  const result = body(await client.callTool({ name: 'get_message_context', arguments: { source: 'local', messageRef: 'tgm1:123:7', window: { before: 0, after: 2 } } }));
  assert.deepEqual(result.messages.map(message => message.id), ['7', '9']);
});

test('uncertain time-window annotations survive per-page persistence in the final snapshot', async t => {
  const message = { id: '1', chatId: '123', text: 'unknown date', attachments: [] };
  const { client } = await fixture(t, async ({ onPage }) => {
    const value = { accountId: '42', source: 'official-web-dom', contentIsUntrusted: true, messages: [message], coverage: [{ chatId: '123', status: 'partial', stopReason: 'UNKNOWN_TIMESTAMP' }] };
    await onPage(value);
    return { ...value, messages: [{ ...message, windowMatch: 'unknown' }], checkpoint: null };
  });
  const value = body(await client.callTool({ name: 'collect_messages', arguments: { chatIds: ['123'], since: '2026-10-18T10:00:00Z', until: '2026-10-18T11:00:00Z' } }));
  assert.equal(value.messages[0].windowMatch, 'unknown');
  const persisted = JSON.parse((await readFile(value.historyPath, 'utf8')).trim());
  assert.equal(persisted.windowMatch, 'unknown');
});

test('context uses one online call then serves full stored context and huge-message parts completely offline', async t => {
  let offline = false;
  const large = '😀Ж\\\"'.repeat(10_000);
  const evidence = { timestamp: '2026-10-18T10:30:00.000Z', timeZone: 'UTC', timestampSource: 'official-web-dom:message-time-title' };
  const messages = ['7', '8', '9', '10', '11'].map(id => ({ id, text: id === '9' ? large : `neighbor-${id}`, attachments: [], ...evidence }));
  const { client } = await fixture(t, async args => {
    assert.equal(offline, false);
    assert.equal(args.operation, 'get_message_context');
    assert.deepEqual(args.window, { before: 2, after: 2 });
    return { accountId: '42', peerId: '123', source: 'official-web-dom', contentIsUntrusted: true, anchor: messages[2], messages, coverage: { status: 'complete', stopReason: 'COUNT_WINDOW', beforeCount: 2, afterCount: 2, requestedWindow: args.window } };
  });
  const first = await client.callTool({ name: 'get_message_context', arguments: { messageRef: 'tgm1:123:9', window: { before: 2, after: 2 } } });
  assert.notEqual(first.isError, true, JSON.stringify(first));
  assert.equal(body(first).collectedCount, 5);
  offline = true;
  const invalid = await client.callTool({ name: 'get_message_context', arguments: { messageRef: 'tgm1:123:9', source: 'local', window: { before: 2, afterMinutes: 10 } } });
  assert.equal(invalid.content[0].text, 'INVALID_READ_REQUEST');
  const local = await client.callTool({ name: 'get_message_context', arguments: { messageRef: 'tgm1:123:9', source: 'local', window: { before: 1, after: 1 } } });
  assert.equal(body(local).collectedCount, 3);
  assert.equal(body(local).collectionStatus, 'partial');
  let response = await client.callTool({ name: 'get_message', arguments: { messageRef: 'tgm1:123:9', source: 'local' } });
  let restored = '';
  for (;;) {
    assert.notEqual(response.isError, true, JSON.stringify(response));
    assert.ok(Buffer.byteLength(response.content[0].text) <= 16 * 1024);
    const page = body(response);
    for (const message of page.messages) restored += message.text;
    if (!page.next) break;
    response = await client.callTool({ name: page.next.tool, arguments: page.next.arguments });
  }
  assert.equal(restored, large);
});
