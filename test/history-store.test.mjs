import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHistoryStore } from '../src/history-store.mjs';

async function fixture(t, datasetId = 'account-A') {
  const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'tg-history-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: createHistoryStore({ root, datasetId }), directory: path.join(root, 'private', 'history', datasetId) };
}
const message = (id, text, fields = {}) => ({ messageRef: `tgm1:12:${id}`, id, chatId: '12', text, timestamp: null, ...fields });

test('saved verified observations remain readable in UTF-8 files and immutable snapshots', async t => {
  const { root, store } = await fixture(t);
  const records = [message('1', 'Привет 👋\nfull text', { sender: { id: '7', name: 'Test' }, textTruncated: false })];
  const coverage = [{ chatId: '12', state: 'partial', stopReason: 'UNKNOWN_TIMESTAMP' }];
  const request = { chatIds: ['12'], queries: ['Привет'] };
  const checkpoint = { chatId: '12', before: '1' };
  const saved = await store.save({ messages: records, coverage, request, checkpoint });
  assert.match(saved.snapshotId, /^[a-f0-9]{48}$/);
  assert.equal(saved.messageCount, 1);
  assert.equal(saved.coverageCount, 1);
  const loaded = await createHistoryStore({ root, datasetId: 'account-A' }).load({ snapshotId: saved.snapshotId });
  assert.deepEqual(loaded.messages, records.map(record => ({ ...record, observedAt: saved.observedAt })));
  assert.deepEqual(loaded.coverage, coverage.map(record => ({ ...record, observedAt: saved.observedAt })));
  assert.deepEqual(loaded.request, request);
  assert.deepEqual(loaded.checkpoint, checkpoint);
  assert.equal(loaded.observedAt, saved.observedAt);
  assert.equal(JSON.parse((await fs.readFile(saved.historyPath, 'utf8')).trim()).text, 'Привет 👋\nfull text');
  assert.equal(JSON.parse((await fs.readFile(path.join(saved.snapshotPath, 'messages.jsonl'), 'utf8')).trim()).text, 'Привет 👋\nfull text');
  assert.equal(JSON.parse((await fs.readFile(path.join(saved.snapshotPath, 'coverage.jsonl'), 'utf8')).trim()).state, 'partial');
});

test('page checkpoints publish linear-size history segments without creating collection snapshots', async t => {
  const { root, store, directory } = await fixture(t);
  const first = await store.save({ messages: [message('1', 'one')], checkpoint: { before: '1' }, snapshot: false });
  const second = await store.save({ messages: [message('2', 'two')], checkpoint: { before: '2' }, snapshot: false });
  assert.equal(first.snapshotId, null);
  assert.equal(first.snapshotPath, null);
  assert.equal(second.snapshotId, null);
  assert.equal(path.dirname(path.dirname(second.historyPath)), path.join(root, 'private', 'history', 'account-A', 'segments'));
  assert.equal(path.basename(second.historyPath), 'messages.jsonl');
  const segments = await fs.readdir(path.join(directory, 'segments'));
  assert.equal(segments.length, 2);
  const contents = await Promise.all(segments.map(id => fs.readFile(path.join(directory, 'segments', id, 'messages.jsonl'), 'utf8')));
  assert.equal(contents.flatMap(text => text.trim().split('\n')).length, 2);
  const manifests = await Promise.all(segments.map(async id => JSON.parse(await fs.readFile(path.join(directory, 'segments', id, 'manifest.json'), 'utf8'))));
  assert.deepEqual(manifests.map(item => item.checkpoint.before).sort(), ['1', '2']);
  assert.deepEqual(await fs.readdir(path.join(directory, 'snapshots')), []);
});

test('local queries deduplicate page observations, retain longer full text, and accept newer full edits without deletion inference', async t => {
  const { store } = await fixture(t);
  const original = await store.save({ messages: [message('1', 'original full detail', { textTruncated: false }), message('2', 'not seen again')] });
  await store.save({ messages: [message('1', 'original', { textTruncated: true }), message('3', 'other message'), message('3', 'other full message')] , snapshot: false });
  const retained = await store.query({ chatIds: ['12'] });
  assert.deepEqual(retained.messages.map(item => [item.id, item.text]), [['1', 'original full detail'], ['2', 'not seen again'], ['3', 'other full message']]);
  assert.equal(retained.messages[0].textTruncated, false);
  await store.save({ messages: [message('1', 'edited', { textTruncated: false })] });
  assert.equal((await store.query({ chatIds: ['12'] })).messages.find(item => item.id === '1').text, 'edited');
  assert.equal((await store.load({ snapshotId: original.snapshotId })).messages[0].text, 'original full detail');
});

test('queries enforce explicit chat scope, inclusive/exclusive ISO bounds, literal case-insensitive OR, and unknown-date gaps', async t => {
  const { store } = await fixture(t);
  await store.save({ messages: [
    message('1', 'Alpha [x]', { timestamp: '2026-03-02T00:00:00Z' }),
    message('2', 'БЕТА work', { timestamp: '2026-03-02T12:00:00+00:00' }),
    message('3', 'Alpha', { timestamp: '2026-03-03T00:00:00Z' }),
    message('4', 'Alpha unknown date'),
    message('5', 'Alpha wrong chat', { chatId: '13', messageRef: 'tgm1:13:5', timestamp: '2026-03-02T12:00:00Z' }),
    message('6', 'Alpha before', { timestamp: '2026-03-01T23:59:59Z' }),
  ], coverage: [{ chatId: '12', state: 'partial', since: '2026-03-02T00:00:00Z', until: '2026-03-03T00:00:00Z' }, { chatId: '13', state: 'complete' }] });
  const result = await store.query({ chatIds: ['12', '99'], since: '2026-03-02T00:00:00Z', until: '2026-03-03T00:00:00Z', queries: ['[X]', 'бета'] });
  assert.deepEqual(result.messages.map(record => record.id), ['1', '2']);
  assert.equal(result.coverage.some(record => record.chatId === '13'), false);
  assert.equal(result.coverage.some(record => record.chatId === '12' && record.stopReason === 'UNKNOWN_TIMESTAMP'), true);
  assert.equal(result.coverage.some(record => record.chatId === '99' && record.stopReason === 'LOCAL_HISTORY_GAP'), true);
  assert.deepEqual((await store.query({ chatIds: ['12'], queries: ['a.*'] })).messages, []);
  assert.equal((await store.query({ chatIds: ['12'], queries: ['UNKNOWN'] })).messages[0].id, '4');
  await assert.rejects(store.query({ queries: ['Alpha'] }), { message: 'HISTORY_READ_FAILED' });
  await assert.rejects(store.query({ chatIds: ['12'], since: 'yesterday' }), { message: 'HISTORY_READ_FAILED' });
  await assert.rejects(store.query({ chatIds: ['12'], since: '2026-03-03T00:00:00Z', until: '2026-03-02T00:00:00Z' }), { message: 'HISTORY_READ_FAILED' });
});

test('preview observations retain their separate identity and never acquire fabricated message references', async t => {
  const { store } = await fixture(t);
  const preview = { chatId: '12', previewRef: 'tgp1:' + 'a'.repeat(64), previewOnly: true, text: 'Alpha preview', query: 'Alpha', displayTime: 'Yesterday', timestamp: null };
  const saved = await store.save({ messages: [preview, { ...preview, text: 'Alpha preview with more detail' }, message('1', 'Alpha full')] });
  assert.equal(saved.messageCount, 2);
  const loaded = await store.load({ snapshotId: saved.snapshotId });
  const local = await store.query({ chatIds: ['12'], queries: ['ALPHA'] });
  assert.equal(local.messages.length, 2);
  const persisted = loaded.messages.find(record => record.previewOnly);
  assert.equal(persisted.text, 'Alpha preview with more detail');
  assert.equal(persisted.id, undefined);
  assert.equal(persisted.messageRef, undefined);
  assert.equal(local.messages.find(record => record.previewOnly).previewRef, preview.previewRef);
  await assert.rejects(store.save({ messages: [{ ...preview, messageRef: 'tgm1:12:2', id: '2' }] }), { message: 'HISTORY_WRITE_FAILED' });
});

test('dataset and snapshot names cannot escape their namespace, and accounts remain isolated', async t => {
  const { root, store } = await fixture(t);
  for (const datasetId of ['', '.', '..', '../other', 'a/b', 'a\\b', 'a.b', 'кириллица', 'a'.repeat(81)]) {
    assert.throws(() => createHistoryStore({ root, datasetId }), { message: 'HISTORY_UNSAFE' });
  }
  const saved = await store.save({ messages: [message('1', 'account A only')] });
  const other = createHistoryStore({ root, datasetId: 'account-B' });
  assert.deepEqual((await other.query({ chatIds: ['12'] })).messages, []);
  await assert.rejects(other.load({ snapshotId: saved.snapshotId }), { message: 'HISTORY_NOT_FOUND' });
  for (const snapshotId of ['..', '../head.json', 'A'.repeat(48), 'a'.repeat(49), '/absolute']) {
    await assert.rejects(store.load({ snapshotId }), { message: 'HISTORY_UNSAFE' });
  }
});

test('malformed timestamps and non-JSON records fail safely without changing prior committed observations', async t => {
  const { store, directory } = await fixture(t);
  const saved = await store.save({ messages: [message('1', 'prior text')] });
  const beforeHead = await fs.readFile(path.join(directory, 'head.json'), 'utf8');
  const beforeFile = await fs.readFile(saved.historyPath, 'utf8');
  await assert.rejects(store.save({ messages: [message('2', 'bad time', { timestamp: '2026-02-30T00:00:00Z' })] }), { message: 'HISTORY_WRITE_FAILED' });
  await assert.rejects(store.save({ messages: [message('2', 'bad metadata', { sender: () => 'secret' })] }), { message: 'HISTORY_WRITE_FAILED' });
  await assert.rejects(store.save({ request: { huge: 'x'.repeat(1024 * 1024) } }), { message: 'HISTORY_WRITE_FAILED' });
  assert.equal(await fs.readFile(path.join(directory, 'head.json'), 'utf8'), beforeHead);
  assert.equal(await fs.readFile(saved.historyPath, 'utf8'), beforeFile);
  assert.equal((await store.load({ snapshotId: saved.snapshotId })).messages[0].text, 'prior text');
});

test('exclusive history locks report fixed busy errors while immutable snapshots remain readable', async t => {
  const { store, directory } = await fixture(t);
  const saved = await store.save({ messages: [message('1', 'retained')] });
  await fs.writeFile(path.join(directory, '.lock'), '', { flag: 'wx', mode: 0o600 });
  await assert.rejects(store.save({ messages: [message('2', 'blocked')] }), { message: 'HISTORY_BUSY' });
  await assert.rejects(store.query({ chatIds: ['12'] }), { message: 'HISTORY_BUSY' });
  assert.equal((await store.load({ snapshotId: saved.snapshotId })).messages[0].text, 'retained');
});

test('cancellation is sanitized and never replaces prior committed history', async t => {
  const { store, directory } = await fixture(t);
  const prior = await store.save({ messages: [message('1', 'before cancel')] });
  const original = await fs.readFile(path.join(directory, 'head.json'), 'utf8');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('private native reason')), 0);
  try { await assert.rejects(store.save({ messages: [message('2', 'must not publish')], signal: controller.signal }), { message: 'READ_CANCELLED' }); }
  finally { clearTimeout(timer); }
  assert.equal(await fs.readFile(path.join(directory, 'head.json'), 'utf8'), original);
  assert.deepEqual((await store.query({ chatIds: ['12'] })).messages.map(record => record.id), ['1']);
  await assert.rejects(store.query({ chatIds: ['12'], signal: controller.signal }), { message: 'READ_CANCELLED' });
  await assert.rejects(store.load({ snapshotId: prior.snapshotId, signal: controller.signal }), { message: 'READ_CANCELLED' });
});

test('corrupt and oversized metadata and torn JSONL fail with fixed read errors', async t => {
  const { store, directory } = await fixture(t);
  const saved = await store.save({ messages: [message('1', 'safe record')] });
  await fs.writeFile(path.join(saved.snapshotPath, 'messages.jsonl'), '{"nativeSecret":"DO_NOT_ECHO"}');
  await assert.rejects(store.load({ snapshotId: saved.snapshotId }), { message: 'HISTORY_READ_FAILED' });
  await fs.truncate(path.join(directory, 'head.json'), 2 * 1024 * 1024);
  await assert.rejects(store.query({ chatIds: ['12'] }), { message: 'HISTORY_READ_FAILED' });
  await assert.rejects(store.save({ messages: [message('2', 'cannot overwrite corrupt head')] }), { message: 'HISTORY_READ_FAILED' });
});

test('redirected history directories are rejected without reading or modifying their targets', async t => {
  const { root, store } = await fixture(t);
  const outside = path.join(root, 'synthetic-outside');
  await fs.mkdir(outside);
  await fs.mkdir(path.join(root, 'private'));
  const sentinel = path.join(outside, 'sentinel.txt');
  await fs.writeFile(sentinel, 'unchanged');
  try { await fs.symlink(outside, path.join(root, 'private', 'history'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('OS does not permit synthetic directory links'); return; } throw error; }
  await assert.rejects(store.save({ messages: [message('1', 'must not escape')] }), { message: 'HISTORY_UNSAFE' });
  await assert.rejects(store.query({ chatIds: ['12'] }), { message: 'HISTORY_UNSAFE' });
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged');
  assert.deepEqual(await fs.readdir(outside), ['sentinel.txt']);
});

test('long UTF-8 records survive chunk boundaries and old observations are not evicted', async t => {
  const { store } = await fixture(t);
  const text = 'Текст 👋 "quoted" \\ slash\n'.repeat(12_000);
  const saved = await store.save({ messages: [message('1', text, { timestamp: '2000-01-01T00:00:00Z' })] });
  await fs.utimes(saved.historyPath, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
  assert.equal((await store.load({ snapshotId: saved.snapshotId })).messages[0].text, text);
  assert.equal((await store.query({ chatIds: ['12'], since: '1999-01-01T00:00:00Z', until: '2001-01-01T00:00:00Z' })).messages[0].text, text);
});

test('local-only snapshots preserve observation freshness without re-ingesting or advancing history', async t => {
  const { store, directory } = await fixture(t);
  await store.save({ messages: [message('1', 'online observation')], coverage: [{ chatId: '12', state: 'partial' }] });
  const head = await fs.readFile(path.join(directory, 'head.json'), 'utf8');
  const segments = await fs.readdir(path.join(directory, 'segments'));
  const old = '2001-02-03T04:05:06.000Z';
  const records = [message('1', 'local selected text', { observedAt: old })];
  const coverage = [{ chatId: '12', state: 'unknown', observedAt: null }];
  const saved = await store.snapshot({ messages: records, coverage, request: { source: 'local' }, checkpoint: { next: 1 } });
  const loaded = await store.load({ snapshotId: saved.snapshotId });
  assert.deepEqual(loaded.messages, records);
  assert.deepEqual(loaded.coverage, coverage);
  assert.equal(saved.observedAt, old);
  assert.equal(saved.historyPath, path.join(saved.snapshotPath, 'messages.jsonl'));
  const manifest = JSON.parse(await fs.readFile(path.join(saved.snapshotPath, 'manifest.json'), 'utf8'));
  assert.match(manifest.createdAt, /^\d{4}-/);
  assert.equal(await fs.readFile(path.join(directory, 'head.json'), 'utf8'), head);
  assert.deepEqual(await fs.readdir(path.join(directory, 'segments')), segments);
  assert.equal((await store.query({ chatIds: ['12'] })).messages[0].text, 'online observation');
});

test('a newer full edit without truncation flags cannot inherit an older partial marker', async t => {
  const { store } = await fixture(t);
  await store.save({ messages: [message('1', 'the long original complete text', { textTruncated: false })], snapshot: false });
  await store.save({ messages: [message('1', 'the long', { textTruncated: true })], snapshot: false });
  await store.save({ messages: [message('1', 'new edit')] , snapshot: false });
  const result = await store.query({ chatIds: ['12'] });
  assert.equal(result.messages[0].text, 'new edit');
  assert.notEqual(result.messages[0].textTruncated, true);
});
