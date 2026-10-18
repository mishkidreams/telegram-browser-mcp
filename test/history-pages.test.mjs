import test from 'node:test';
import assert from 'node:assert/strict';
import { pageHistory, encodeHistoryCursor, decodeHistoryCursor } from '../src/history-pages.mjs';

const snapshotId = 'a'.repeat(48);
const observedAt = '2026-06-04T10:00:00.000Z';
const snapshot = (changes = {}) => ({
  snapshotId, observedAt,
  messages: [{ chatId: '321', id: '1', messageRef: 'tgm1:321:1', text: 'Hello' }],
  coverage: [{ chatId: '321', status: 'complete' }],
  request: { chatIds: ['321'], source: 'telegram' }, checkpoint: null,
  snapshotPath: 'C:/private/history/snapshots/' + snapshotId,
  historyPath: 'C:/private/history/chats',
  ...changes,
});
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('a persisted snapshot has stable references and independently complete collection and delivery', () => {
  const input = snapshot();
  const original = structuredClone(input);
  const result = pageHistory(input);
  assert.equal(result.snapshotId, snapshotId);
  assert.equal(result.observedAt, observedAt);
  assert.equal(result.snapshotPath, input.snapshotPath);
  assert.equal(result.historyPath, input.historyPath);
  assert.equal(result.collectedCount, 1);
  assert.equal(result.returnedCount, 1);
  assert.equal(result.contentIsUntrusted, true);
  assert.equal(result.collectionStatus, 'complete');
  assert.equal(result.messages[0].messageRef, 'tgm1:321:1');
  assert.equal(result.messages[0].text, 'Hello');
  assert.deepEqual(result.coverage, [{ chatId: '321', status: 'complete' }]);
  assert.equal(result.pagination.complete, true);
  assert.equal(result.next, null);
  assert.equal(result.resume, null);
  assert.ok(bytes(result) <= 16 * 1024);
  assert.deepEqual(input, original);
});

test('normal history preserves a separate verified online older-page continuation', () => {
  const result = pageHistory(snapshot({ request: { source: 'telegram', operation: 'get_history', chatIds: ['321'], nextBefore: '1' } }));
  assert.deepEqual(result.older, { tool: 'get_history', arguments: { chatId: '321', before: '1', limit: 50 } });
  assert.equal(result.next, null, 'snapshot delivery and online older history are different');
  assert.ok(bytes(result) <= 16 * 1024);
});

test('an untouched local scope reports unknown freshness and gaps instead of inventing a current observation', () => {
  const result = pageHistory(snapshot({ observedAt: null, messages: [], request: { source: 'local' }, coverage: [{ chatId: '321', state: 'unknown', stopReason: 'LOCAL_HISTORY_GAP' }] }));
  assert.equal(result.observedAt, null);
  assert.equal(result.collectionSource, 'local');
  assert.equal(result.collectionStatus, 'partial');
  assert.equal(result.collectedCount, 0);
  assert.equal(result.coverage[0].stopReason, 'LOCAL_HISTORY_GAP');
});

test('count pagination reads the same snapshot locally without duplicate or skipped messages', () => {
  const input = snapshot({ messages: Array.from({ length: 123 }, (_, i) => ({
    chatId: '321', id: String(i + 1), messageRef: `tgm1:321:${i + 1}`, text: `message ${i + 1}`,
  })) });
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const result = pageHistory(input, { cursor, limit: 2 });
    seen.push(...result.messages.map(item => item.id));
    assert.ok(result.messages.length <= 2);
    assert.ok(bytes(result) <= 16 * 1024);
    assert.equal(result.snapshotPath, input.snapshotPath);
    assert.equal(result.collectionStatus, 'complete');
    if (result.next) {
      assert.equal(result.next.tool, 'collect_messages');
      assert.equal(result.next.arguments.source, 'local');
      assert.equal(result.next.arguments.limit, 2);
      assert.equal(decodeHistoryCursor(result.next.arguments.cursor).snapshotId, snapshotId);
    }
    cursor = result.next?.arguments.cursor;
    assert.ok(++pages < 100);
  } while (cursor);
  assert.deepEqual(seen, Array.from({ length: 123 }, (_, i) => String(i + 1)));
});

test('the default desired message count is 50 and the maximum is 100', () => {
  const input = snapshot({ messages: Array.from({ length: 101 }, (_, i) => ({
    chatId: '321', id: String(i + 1), messageRef: `tgm1:321:${i + 1}`, text: '',
  })) });
  assert.equal(pageHistory(input).returnedCount, 50);
  assert.equal(pageHistory(input, { limit: 100 }).returnedCount, 100);
});

test('preview records keep their preview identity and query across text parts, never inventing a message reference', () => {
  const previewRef = 'tgp1:' + 'b'.repeat(64);
  const text = 'preview 😺 '.repeat(5000);
  const input = snapshot({ messages: [{ chatId: '321', previewRef, previewOnly: true, text,
    query: 'release plan', displayTime: 'Today 10:00', timestamp: null }] });
  let cursor;
  const parts = [];
  do {
    const result = pageHistory(input, { cursor });
    assert.ok(bytes(result) <= 16384);
    assert.equal(result.source, 'local');
    const item = result.messages[0];
    assert.equal(item.previewRef, previewRef);
    assert.equal(item.previewOnly, true);
    assert.equal(item.query, 'release plan');
    assert.equal(item.displayTime, 'Today 10:00');
    assert.equal(item.timestamp, null);
    assert.equal(Object.hasOwn(item, 'messageRef'), false);
    assert.equal(Object.hasOwn(item, 'id'), false);
    parts.push(item.text);
    cursor = result.next?.arguments.cursor;
    assert.ok(parts.length < 100);
  } while (cursor);
  assert.equal(parts.join(''), text);
});

test('normalized evidence and context coverage survive projection without losing uncertainty', () => {
  const input = snapshot({
    messages: [{ chatId: '321', id: '1', messageRef: 'tgm1:321:1', text: 'evidence',
      timestamp: '2026-06-04T10:00:00Z', timestampSource: 'official-web-dom:message-time-title',
      mentioned: null, topic: { id: '10', name: 'Release' }, windowMatch: 'unknown' }],
    coverage: [{ chatId: '321', state: 'partial', status: 'partial', observedCount: 55, unknownTimestamps: 3,
      unknownTimestampCount: 3, requestedWindow: { beforeMinutes: 5, afterMinutes: 10 },
      beforeCount: 4, afterCount: 6, replyTo: 'unavailable' }],
  });
  const result = pageHistory(input);
  assert.equal(result.messages[0].timestampSource, 'official-web-dom:message-time-title');
  assert.equal(result.messages[0].mentioned, null);
  assert.deepEqual(result.messages[0].topic, { id: '10', name: 'Release' });
  assert.equal(result.messages[0].windowMatch, 'unknown');
  assert.deepEqual(result.coverage, input.coverage);
  assert.equal(result.collectionStatus, 'partial');
  assert.equal(pageHistory(snapshot({ coverage: [{ chatId: '321', state: 'complete' }] })).collectionStatus, 'complete');
  assert.equal(pageHistory(snapshot({ coverage: [{ chatId: '321', status: 'complete', state: 'partial' }] })).collectionStatus, 'partial');
  assert.equal(pageHistory(snapshot({ coverage: [{ chatId: '321', status: 'complete', unknownTimestamps: 1 }] })).collectionStatus, 'partial');
});

test('metadata-only overflow is projected safely without changing persisted messages or coverage', () => {
  const enormous = '😺'.repeat(100000);
  const input = snapshot({
    messages: [{ chatId: '321', id: '1', messageRef: 'tgm1:321:1', text: '',
      timestamp: null, sender: { id: '777', displayName: 'Alice', token: 'DO_NOT_LEAK' },
      topic: { id: '10', title: enormous }, attachments: [{ index: 0, kind: 'file', attachmentRef: 'tga1:321:1:0', filename: enormous, url: 'DO_NOT_LEAK' }],
      displayTime: enormous, session: 'DO_NOT_LEAK', url: 'DO_NOT_LEAK',
    }],
    coverage: [{ chatId: '321', topicId: '10', status: 'partial', stopReason: enormous,
      requested: { since: '2026-06-04T00:00:00Z', until: '2026-06-05T00:00:00Z', session: 'DO_NOT_LEAK' }, secret: 'DO_NOT_LEAK' }],
  });
  const original = structuredClone(input);
  const result = pageHistory(input);
  assert.ok(bytes(result) <= 16384);
  assert.equal(result.messages[0].text, '');
  assert.equal(result.messages[0].metadataOmitted, true);
  assert.equal(result.messages[0].sender.id, '777');
  assert.equal(result.messages[0].sender.displayName, 'Alice');
  assert.equal(result.coverage[0].metadataOmitted, true);
  assert.equal(result.coverage[0].status, 'partial');
  assert.equal(result.coverage[0].topicId, '10');
  assert.deepEqual(result.coverage[0].requested, { since: '2026-06-04T00:00:00Z', until: '2026-06-05T00:00:00Z' });
  assert.equal(result.snapshotPath, input.snapshotPath);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_LEAK/);
  assert.deepEqual(input, original);
});

test('interleaved empty, huge and ordinary records continue without gaps while coverage pages advance', () => {
  const input = snapshot({
    checkpoint: { next: 'work' },
    messages: Array.from({ length: 31 }, (_, i) => ({ chatId: '321', id: String(i + 1), messageRef: `tgm1:321:${i + 1}`,
      text: i % 3 === 0 ? '' : i % 3 === 1 ? '\\😺Ж\n'.repeat(8000) : `message-${i}`, displayTime: '10:00' })),
    coverage: Array.from({ length: 400 }, (_, i) => ({ chatId: '321', topicId: String(i + 1), status: 'complete' })),
  });
  const textById = new Map(input.messages.map(message => [message.id, '']));
  const finished = [];
  const topics = [];
  let cursor;
  let pageCount = 0;
  do {
    const result = pageHistory(input, { cursor, limit: 3 });
    assert.ok(bytes(result) <= 16384);
    assert.equal(result.collectionStatus, 'partial');
    assert.ok(result.resume);
    for (const item of result.messages) {
      assert.equal(item.textPart.offset, textById.get(item.id).length);
      textById.set(item.id, textById.get(item.id) + item.text);
      if (item.textPart.complete) finished.push(item.id);
    }
    topics.push(...result.coverage.map(item => item.topicId));
    cursor = result.next?.arguments.cursor;
    assert.ok(++pageCount < 200);
  } while (cursor);
  assert.deepEqual(finished, input.messages.map(item => item.id));
  assert.deepEqual([...textById.values()], input.messages.map(item => item.text));
  assert.deepEqual(topics, Array.from({ length: 400 }, (_, i) => String(i + 1)));
});

test('coverage is paginated without loss even with no messages; checkpoint and gaps stay partial', () => {
  const coverage = Array.from({ length: 2000 }, (_, i) => ({
    chatId: '321', topicId: String(i + 1), status: i === 1999 ? 'timeout' : 'complete',
    stopReason: i === 1999 ? 'DEADLINE' : 'INTERVAL_BOUNDARY',
  }));
  const input = snapshot({ messages: [], coverage, checkpoint: { nextChat: 2, secret: 'do not inline' } });
  const seen = [];
  let cursor;
  let pageCount = 0;
  do {
    const result = pageHistory(input, { cursor });
    assert.ok(bytes(result) <= 16384);
    assert.equal(result.collectionStatus, 'partial');
    assert.equal(result.returnedCount, 0);
    assert.equal(result.resume.tool, 'collect_messages');
    assert.equal(result.resume.arguments.source, 'telegram');
    assert.deepEqual(decodeHistoryCursor(result.resume.arguments.cursor), { kind: 'scan', snapshotId });
    assert.doesNotMatch(JSON.stringify(result), /do not inline/);
    seen.push(...result.coverage.map(item => item.topicId));
    cursor = result.next?.arguments.cursor;
    assert.ok(++pageCount < 100);
  } while (cursor);
  assert.ok(pageCount > 1);
  assert.deepEqual(seen, Array.from({ length: 2000 }, (_, i) => String(i + 1)));
  for (const coverage of [[], [{ chatId: '321', status: 'partial' }], [{ chatId: '321' }]]) {
    const result = pageHistory(snapshot({ checkpoint: null, coverage }));
    assert.equal(result.collectionStatus, 'partial');
    assert.equal(result.resume, null);
  }
});

test('cursor codecs reject malformed, ambiguous and oversized tokens with one fixed error', () => {
  const values = [{ kind: 'scan', snapshotId }, { kind: 'page', snapshotId, index: 2, textOffset: 4, coverageIndex: 1 }];
  for (const value of values) {
    const encoded = encodeHistoryCursor(value);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.ok(encoded.length <= 2048);
    assert.deepEqual(decodeHistoryCursor(encoded), value);
  }
  const page = values[1];
  for (const value of [null, [], {}, { ...page, unexpected: true }, { ...page, kind: 'other' },
    { ...page, snapshotId: 'A'.repeat(48) }, { ...page, snapshotId: { toString: () => snapshotId } },
    { ...page, index: -1 }, { ...page, index: 1.5 }, { ...page, index: '2' },
    { ...page, textOffset: Infinity }, { ...page, coverageIndex: Number.MAX_SAFE_INTEGER + 1 },
    { kind: 'scan', snapshotId, index: 0 }, Object.create({ kind: 'other', snapshotId })]) {
    assert.throws(() => encodeHistoryCursor(value), { message: 'INVALID_READ_REQUEST' });
  }
  const raw = text => Buffer.from(text, 'utf8').toString('base64url');
  const valid = encodeHistoryCursor(page);
  for (const value of [undefined, null, true, '', '=', 'a'.repeat(2049), valid + '=', valid + '/',
    raw('null'), raw('[]'), raw('{}'), raw('{'), Buffer.from([255]).toString('base64url'),
    raw('\uFEFF' + JSON.stringify(values[0])),
    raw(`{"kind":"scan","snapshotId":"${snapshotId}","kind":"scan"}`),
    raw(` {"kind":"scan","snapshotId":"${snapshotId}"}`),
    raw(`{"kind":"scan","snapshotId":"${snapshotId}","path":"/secret"}`)]) {
    assert.throws(() => decodeHistoryCursor(value), { message: 'INVALID_READ_REQUEST' });
  }
});

test('pageHistory rejects cursors outside this snapshot, scan cursors, invalid offsets and invalid limits', () => {
  const input = snapshot({ messages: [{ chatId: '321', id: '1', messageRef: 'tgm1:321:1', text: 'a😺b' }] });
  const base = { kind: 'page', snapshotId, index: 0, textOffset: 0, coverageIndex: 0 };
  for (const value of [{ ...base, snapshotId: 'b'.repeat(48) }, { kind: 'scan', snapshotId },
    { ...base, index: 2 }, { ...base, index: 1, textOffset: 1 }, { ...base, textOffset: 2 },
    { ...base, textOffset: 4 }, { ...base, coverageIndex: 2 }]) {
    assert.throws(() => pageHistory(input, { cursor: encodeHistoryCursor(value) }), { message: 'INVALID_READ_REQUEST' });
  }
  for (const limit of [0, 101, 1.5, '2', null, Infinity]) {
    assert.throws(() => pageHistory(input, { limit }), { message: 'INVALID_READ_REQUEST' });
  }
  assert.equal(pageHistory(input, { limit: 100 }).messages[0].text, 'a😺b');
  assert.throws(() => pageHistory(input, null), { message: 'INVALID_READ_REQUEST' });
});

test('exact 16 KiB safe envelopes are allowed; one extra byte fails with OUTPUT_TOO_LARGE', () => {
  const input = snapshot({ messages: [], coverage: [], historyPath: undefined, snapshotPath: 'p' });
  const baseBytes = bytes(pageHistory(input));
  input.snapshotPath = 'p'.repeat(16384 - baseBytes + 1);
  assert.equal(bytes(pageHistory(input)), 16384);
  input.snapshotPath += 'p';
  assert.throws(() => pageHistory(input), { message: 'OUTPUT_TOO_LARGE' });
});

for (const [name, unit] of [['ASCII', 'x'], ['Cyrillic', 'Ж'], ['emoji', '😺'], ['JSON escapes', '\\"\n\t\\']]) {
  test(`${name} text fits at exactly 16 KiB and resumes after crossing the encoded-byte boundary`, () => {
    const originalText = unit.repeat(1000);
    const input = snapshot({ coverage: [], historyPath: undefined, snapshotPath: 'p', messages: [
      { chatId: '321', id: '1', messageRef: 'tgm1:321:1', text: originalText },
    ] });
    input.snapshotPath += 'p'.repeat(16384 - bytes(pageHistory(input)));
    const exact = pageHistory(input);
    assert.equal(bytes(exact), 16384);
    assert.equal(exact.next, null);
    input.messages[0].text += unit;
    let cursor;
    let text = '';
    let pages = 0;
    do {
      const result = pageHistory(input, { cursor });
      assert.ok(bytes(result) <= 16384);
      const part = result.messages[0];
      assert.equal(part.textPart.offset, text.length);
      text += part.text;
      cursor = result.next?.arguments.cursor;
      assert.ok(++pages < 30);
    } while (cursor);
    assert.ok(pages > 1);
    assert.equal(text, originalText + unit);
  });

  test(`a huge ${name} message is delivered in lossless byte-bounded parts`, () => {
    const text = unit.repeat(25000);
    const input = snapshot({ messages: [{ chatId: '321', id: '1', messageRef: 'tgm1:321:1', text }] });
    const original = structuredClone(input);
    const parts = [];
    let cursor;
    let offset = 0;
    do {
      const result = pageHistory(input, { cursor });
      assert.ok(bytes(result) <= 16384, `entire serialized response: ${bytes(result)}`);
      assert.equal(result.returnedCount, 1);
      const message = result.messages[0];
      assert.equal(message.messageRef, 'tgm1:321:1');
      assert.equal(message.textPart.offset, offset);
      assert.equal(message.textPart.total, text.length);
      assert.equal(message.textPart.end, offset + message.text.length);
      assert.equal(message.textPart.complete, message.textPart.end === text.length);
      assert.ok(message.text.length > 0);
      assert.doesNotMatch(message.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      parts.push(message.text);
      offset = message.textPart.end;
      cursor = result.next?.arguments.cursor;
      if (cursor) {
        const decoded = decodeHistoryCursor(cursor);
        assert.equal(decoded.index, 0);
        assert.equal(decoded.textOffset, offset);
      }
      assert.ok(parts.length < 100);
    } while (cursor);
    assert.equal(parts.join(''), text);
    assert.deepEqual(input, original);
  });
}
