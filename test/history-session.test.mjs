import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHistorySession } from '../src/history-session.mjs';

test('offline identity needs no browser and account/profile datasets never mix after a verified switch', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tg-history-account-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = createHistorySession({ root, profileDir: join(root, 'profile-a') });
  const b = createHistorySession({ root, profileDir: join(root, 'profile-b') });
  assert.equal(await a.local(), null);
  await assert.rejects(a.online('not-an-account'), /HISTORY_IDENTITY_UNAVAILABLE/);
  const first = await a.online('42');
  const saved = await first.store.save({ messages: [{ chatId: '123', id: '1', messageRef: 'tgm1:123:1', text: 'account42', timestamp: null }] });
  assert.equal((await a.local()).datasetId, first.datasetId);
  assert.equal(await b.local(), null);
  const otherProfile = await b.online('42');
  assert.notEqual(otherProfile.datasetId, first.datasetId);
  assert.equal((await otherProfile.store.query({ chatIds: ['123'] })).messages.length, 0);
  const otherAccount = await a.online('43');
  assert.notEqual(otherAccount.datasetId, first.datasetId);
  assert.equal((await otherAccount.store.query({ chatIds: ['123'] })).messages.length, 0);
  assert.match(await readFile(saved.historyPath, 'utf8'), /account42/);
  assert.equal((await a.online('42')).datasetId, first.datasetId);
  assert.equal((await (await a.local()).store.query({ chatIds: ['123'] })).messages[0].text, 'account42');
});
