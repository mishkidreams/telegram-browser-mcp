import test from 'node:test';
import assert from 'node:assert/strict';
import { collectFromBrowser, normalizeCollectionRequest } from '../src/collection-reader.mjs';

const page = (chatId, messages) => ({ peerId: chatId, source: 'official-web-dom', contentIsUntrusted: true, newestSliceConfirmedByUi: true, historyComplete: false, messages });
const message = (id, timestamp, text = 'observed') => ({ id, timestamp, text, attachments: [] });

test('one deterministic collection crosses chat boundaries, persists full fetched pages and reports the covered window', async () => {
  const observed = [];
  const reader = {
    async readLatest({ chatId }) { return page(chatId, [message('2', '2026-10-18T09:00:00Z'), message('3', '2026-10-18T10:30:00Z')]); },
    async readHistory({ chatId, before }) { assert.equal(before, '2'); return page(chatId, [message('1', '2026-10-18T08:00:00Z')]); },
  };
  const result = await collectFromBrowser({ reader,
    request: { chatIds: ['123', '456'], since: '2026-10-18T10:00:00Z', until: '2026-10-18T11:00:00Z' },
    onPage: async ({ messages }) => { observed.push(...messages); },
  });
  assert.deepEqual(result.messages.map(m => [m.chatId, m.id]), [['123', '3'], ['456', '3']]);
  assert.equal(observed.length, 4);
  assert.equal(result.checkpoint, null);
  assert.equal(result.coverage.length, 2);
  assert.ok(result.coverage.every(c => c.status === 'complete' && c.stopReason === 'TIME_BOUNDARY'));
});

test('operation budgets checkpoint all unvisited chats and resume without repeating confirmed pages', async () => {
  const request = { chatIds: ['123', '456'], since: '2026-10-18T10:00:00+03:00', until: '2026-10-18T11:00:00+03:00' };
  const reader = { async readLatest({ chatId }) { return page(chatId, [message('1', '2026-10-18T06:00:00Z'), message('2', '2026-10-18T07:30:00Z')]); } };
  const first = await collectFromBrowser({ reader, request, maxPages: 1 });
  assert.ok(first.checkpoint);
  assert.equal(first.coverage[1].stopReason, 'NOT_VISITED');
  const next = await collectFromBrowser({ reader, request, checkpoint: first.checkpoint });
  assert.equal(next.checkpoint, null);
  assert.deepEqual(next.messages.map(m => [m.chatId, m.id]), [['456', '2']]);
});

test('a temporary history stall keeps a resumable cursor without repeating already fetched pages', async () => {
  const request = { chatIds: ['123'], since: '2026-10-18T07:00:00Z', until: '2026-10-18T08:00:00Z' };
  const persisted = [];
  const first = await collectFromBrowser({ reader: {
    async readLatest({ chatId }) { return page(chatId, [message('5', '2026-10-18T07:30:00Z')]); },
    async readHistory() { throw new Error('HISTORY_NOT_LOADED'); },
  }, request, onPage: async value => persisted.push(...value.messages) });
  assert.ok(first.checkpoint, 'a stalled browser is not the end of the requested history');
  assert.equal(first.coverage[0].stopReason, 'HISTORY_NOT_LOADED');
  assert.equal(first.checkpoint.work[0].before, '5');
  assert.equal(persisted.length, 1);
  const resumed = await collectFromBrowser({ reader: {
    async readLatest() { assert.fail('must not fetch latest again on resume'); },
    async readHistory({ chatId, before }) { assert.equal(before, '5'); return page(chatId, [message('3', '2026-10-18T06:30:00Z'), message('4', '2026-10-18T07:10:00Z')]); },
  }, request, checkpoint: first.checkpoint });
  assert.equal(resumed.checkpoint, null);
  assert.deepEqual(resumed.messages.map(value => value.id), ['4']);
  assert.equal(resumed.coverage[0].stopReason, 'TIME_BOUNDARY');
});

test('unknown timestamps remain explicit uncertain evidence, never a complete empty interval', async () => {
  const reader = { async readLatest({ chatId }) { return page(chatId, [message('1', '2026-10-18T06:00:00Z'), message('2', null, 'please review')]); } };
  const result = await collectFromBrowser({ reader, request: { chatIds: ['123'], since: '2026-10-18T07:00:00Z', until: '2026-10-18T08:00:00Z' } });
  assert.equal(result.messages[0].windowMatch, 'unknown');
  assert.equal(result.coverage[0].status, 'partial');
  assert.equal(result.coverage[0].stopReason, 'UNKNOWN_TIMESTAMPS');
});

test('native multi-chat search persists previews but never fabricates exact message references', async () => {
  const observed = [];
  const reader = { async searchMessages({ chatId, query }) { return { peerId: chatId, source: 'official-web-search-dom', contentIsUntrusted: true, scopeVerifiedByUi: true, query, matches: [{ preview: 'useful truncated hit', displayTime: 'Today' }] }; } };
  const result = await collectFromBrowser({ reader, request: { chatIds: ['123', '456'], queries: ['useful'] }, onPage: async p => observed.push(...p.messages) });
  assert.equal(observed.length, 2);
  assert.ok(result.messages.every(m => m.previewOnly && !m.id && !m.messageRef));
  assert.notEqual(result.messages[0].previewRef, result.messages[1].previewRef);
  assert.ok(result.coverage.every(c => c.status === 'partial' && c.stopReason === 'SEARCH_PREVIEWS_ONLY'));
});

test('time selection rejects rollover dates, timezone-less instants and mixed-invalid calendar inputs', () => {
  for (const since of ['2026-02-30T10:00:00Z', '2026-10-18T24:00:00Z', '2026-10-18T10:00:00', '2026-13-01T10:00:00Z']) assert.throws(() => normalizeCollectionRequest({ chatIds: ['123'], since, until: '2026-12-20T12:00:00Z' }), /INVALID_READ_REQUEST/);
  assert.equal(normalizeCollectionRequest({ chatIds: ['123'], since: '2024-02-29T00:00:00+03:00', until: '2024-03-01T00:00:00+03:00' }).since, '2024-02-28T21:00:00.000Z');
});

test('query checkpoints retain unvisited queries and never repeat a parent-wide search for every forum topic', async () => {
  let time = 0;
  const calls = [];
  const reader = { async listTopics() { throw new Error('MUST-NOT-ENUMERATE'); }, async searchMessages({ chatId, query }) { calls.push(query); time += 20; return { peerId: chatId, source: 'official-web-search-dom', contentIsUntrusted: true, scopeVerifiedByUi: true, query, matches: [] }; } };
  const request = { chatIds: ['-100123'], queries: ['first', 'second'] };
  const first = await collectFromBrowser({ reader, request, deadlineMs: 10, now: () => time });
  assert.deepEqual(calls, ['first']);
  assert.equal(first.checkpoint.work[0].queryIndex, 1);
  const second = await collectFromBrowser({ reader, request, checkpoint: first.checkpoint, deadlineMs: 100, now: () => time });
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(second.checkpoint, null);
});

test('already persisted pages survive cancellation and denied scopes stop before browser navigation', async () => {
  const controller = new AbortController(), saved = [];
  const reader = { async readLatest({ chatId }) { return page(chatId, [message('1', '2026-10-18T06:00:00Z'), message('2', '2026-10-18T07:30:00Z')]); } };
  const request = { chatIds: ['123', '456'], since: '2026-10-18T07:00:00Z', until: '2026-10-18T08:00:00Z' };
  await assert.rejects(collectFromBrowser({ reader, request, signal: controller.signal, onPage: async value => { saved.push(value); controller.abort(); } }), /READ_CANCELLED/);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].checkpoint.work[1].stopReason, 'NOT_VISITED');
  await assert.rejects(collectFromBrowser({ reader: {}, request, authorize: async () => { throw new Error('ACCESS_DENIED'); } }), /ACCESS_DENIED/);
});
