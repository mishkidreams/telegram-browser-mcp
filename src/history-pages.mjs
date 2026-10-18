// Presentation only: callers persist the complete snapshot and recheck current
// authorization before calling. A cursor identifies stored data; it grants none.
const budget = 16 * 1024;
const snapshotPattern = /^[a-f0-9]{48}$/;
const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const invalid = () => { throw new Error('INVALID_READ_REQUEST'); };
const natural = value => Number.isSafeInteger(value) && value >= 0;

function checkedCursor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.snapshotId !== 'string' || !snapshotPattern.test(value.snapshotId)) invalid();
  if (value.kind !== 'page' && value.kind !== 'scan') invalid();
  const keys = value.kind === 'page' ? ['kind', 'snapshotId', 'index', 'textOffset', 'coverageIndex'] : ['kind', 'snapshotId'];
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
  if (value.kind === 'page' && ![value.index, value.textOffset, value.coverageIndex].every(natural)) invalid();
  return value.kind === 'page' ? {
    kind: 'page', snapshotId: value.snapshotId, index: value.index,
    textOffset: value.textOffset, coverageIndex: value.coverageIndex,
  } : { kind: 'scan', snapshotId: value.snapshotId };
}

export function encodeHistoryCursor(value) {
  try {
    const cursor = Buffer.from(JSON.stringify(checkedCursor(value)), 'utf8').toString('base64url');
    if (cursor.length > 2048) invalid();
    return cursor;
  } catch { invalid(); }
}

export function decodeHistoryCursor(value) {
  try {
    if (typeof value !== 'string' || !value.length || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) invalid();
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const cursor = checkedCursor(JSON.parse(json));
    // Accept only our canonical representation, rejecting duplicate JSON keys,
    // alternate numeric forms and other ambiguous encodings.
    if (Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url') !== value) invalid();
    return cursor;
  } catch { invalid(); }
}

const peerPattern = /^-?[1-9]\d{0,19}$/;
const referencePattern = /^tgm1:(-?[1-9]\d{0,19}):([1-9]\d{0,19})(?::([1-9]\d{0,19}))?$/;
const intervalFields = { since: 128, until: 128, timeZone: 128 };
const topicFields = { id: 20, topicId: 20, title: 256, name: 256, chatId: 21 };
const messageFields = {
  timestamp: 128, timestampSource: 128, observedAt: 128, displayTime: 256, timeZone: 128,
  mentioned: 'boolean', windowMatch: 32,
  outgoing: 'boolean', nonTextOnly: 'boolean', textTruncated: 'boolean',
  omittedReason: 64, lastGroupedMessageId: 20, postId: 20, query: 1024,
  sender: { id: 21, chatId: 21, displayName: 256, name: 256, username: 128 },
  replyTo: { messageRef: 128, chatId: 21, id: 20, messageId: 20, postId: 20, verified: 'boolean' },
  topic: topicFields, mentionsSelf: 'boolean', mentionOfSelf: 'boolean',
  attachments: [{ index: 'number', kind: 16, attachmentRef: 128, messageId: 20, filename: 128, mimeType: 128, sizeBytes: 'number' }],
  source: 32, contentIsUntrusted: 'boolean', previewOnly: 'boolean', metadataOmitted: 'boolean',
};
const coverageFields = {
  topicId: 20, topic: topicFields, status: 64, state: 64, stopReason: 256,
  observedCount: 'number', unknownTimestamps: 'number', unknownTimestampCount: 'number',
  requestedWindow: { before: 'number', after: 'number', beforeMinutes: 'number', afterMinutes: 'number' },
  beforeCount: 'number', afterCount: 'number', replyTo: 32,
  observedAt: 128, checkedAt: 128, checked: 'boolean', timestampUnknown: 'boolean',
  since: 128, until: 128, timeZone: 128,
  requestedSince: 128, requestedUntil: 128, coveredSince: 128, coveredUntil: 128,
  requested: intervalFields, covered: intervalFields, requestedInterval: intervalFields, coveredInterval: intervalFields,
  nextBefore: 20, query: 1024, metadataOmitted: 'boolean',
};

// Only explicit, bounded data fields cross this boundary. Never spread arbitrary
// stored metadata (including nested secrets, URLs or browser/session properties).
function select(value, schema, ignored = []) {
  if (value === null) return { value: null, omitted: false };
  if (typeof schema === 'number') return typeof value === 'string' && value.length <= schema
    ? { value, omitted: false } : { omitted: true };
  if (schema === 'boolean' || schema === 'number') return (schema === 'boolean' ? typeof value === 'boolean' : natural(value))
    ? { value, omitted: false } : { omitted: true };
  if (Array.isArray(schema)) {
    if (!Array.isArray(value) || value.length > 32) return { omitted: true };
    const items = value.map(item => select(item, schema[0]));
    return { value: items.filter(item => Object.hasOwn(item, 'value')).map(item => item.value), omitted: items.some(item => item.omitted) };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { omitted: true };
  const output = {};
  let omitted = false;
  for (const key of Object.keys(value)) {
    if (ignored.includes(key) || value[key] === undefined) continue;
    if (!Object.hasOwn(schema, key)) { omitted = true; continue; }
    const item = select(value[key], schema[key]);
    if (Object.hasOwn(item, 'value')) output[key] = item.value;
    omitted ||= item.omitted;
  }
  return { value: output, omitted };
}

function messageMetadata(message) {
  if (!message || typeof message.text !== 'string' || typeof message.chatId !== 'string' || !peerPattern.test(message.chatId)) invalid();
  let identity;
  if (message.previewOnly === true) {
    if (typeof message.previewRef !== 'string' || !/^tgp1:[a-f0-9]{64}$/.test(message.previewRef)) invalid();
    identity = { chatId: message.chatId, previewRef: message.previewRef, previewOnly: true };
  } else {
    const match = typeof message.messageRef === 'string' && referencePattern.exec(message.messageRef);
    if (!match || match[1] !== message.chatId || match[2] !== message.id) invalid();
    identity = { chatId: message.chatId, id: message.id, messageRef: message.messageRef };
  }
  const projected = select(message, messageFields, ['chatId', 'id', 'messageRef', 'previewRef', 'previewOnly', 'text']);
  // Metadata is presentation, not retention. The full record remains in the
  // returned snapshot/history path; text and stable identity are never trimmed.
  if (size(projected.value) > 2048) return { ...identity, metadataOmitted: true };
  return { ...identity, ...projected.value, ...(projected.omitted ? { metadataOmitted: true } : {}) };
}

function coverageMetadata(record) {
  if (!record || typeof record.chatId !== 'string' || !peerPattern.test(record.chatId)) invalid();
  const projected = select(record, coverageFields, ['chatId']);
  if (size(projected.value) > 2048) return {
    chatId: record.chatId,
    ...(typeof record.topicId === 'string' && record.topicId.length <= 20 ? { topicId: record.topicId } : {}),
    ...(typeof record.status === 'string' && record.status.length <= 64 ? { status: record.status } : {}),
    ...(typeof record.state === 'string' && record.state.length <= 64 ? { state: record.state } : {}),
    metadataOmitted: true,
  };
  return { chatId: record.chatId, ...projected.value, ...(projected.omitted ? { metadataOmitted: true } : {}) };
}

// Offsets are UTF-16 string indices. Never cut between a paired surrogate.
function safeEnd(text, end) {
  return end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end]) ? end - 1 : end;
}

export function pageHistory(snapshot, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid();
  const { cursor, limit = 50 } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
  if (!snapshot || typeof snapshot.snapshotId !== 'string' || !snapshotPattern.test(snapshot.snapshotId) || (snapshot.observedAt !== null && typeof snapshot.observedAt !== 'string') || !Array.isArray(snapshot.messages) || !Array.isArray(snapshot.coverage)) invalid();
  for (const path of [snapshot.snapshotPath, snapshot.historyPath]) if (path !== undefined && path !== null && typeof path !== 'string') invalid();
  let state = cursor === undefined ? { kind: 'page', snapshotId: snapshot.snapshotId, index: 0, textOffset: 0, coverageIndex: 0 } : decodeHistoryCursor(cursor);
  if (state.kind !== 'page' || state.snapshotId !== snapshot.snapshotId || state.index > snapshot.messages.length || state.coverageIndex > snapshot.coverage.length) invalid();
  if (state.textOffset && (state.index === snapshot.messages.length || typeof snapshot.messages[state.index]?.text !== 'string' || state.textOffset >= snapshot.messages[state.index].text.length || safeEnd(snapshot.messages[state.index].text, state.textOffset) !== state.textOffset)) invalid();
  const start = { ...state };
  const messages = [];
  const coverage = [];
  const collectionStatus = snapshot.checkpoint === null && snapshot.coverage.length > 0 && snapshot.coverage.every(item =>
    item && (item.status ?? item.state) === 'complete'
    && (item.status === undefined || item.status === 'complete') && (item.state === undefined || item.state === 'complete')
    && !(item.unknownTimestamps > 0) && !(item.unknownTimestampCount > 0)) ? 'complete' : 'partial';
  const result = (position, items = messages, statuses = coverage) => {
    const complete = position.index === snapshot.messages.length && position.coverageIndex === snapshot.coverage.length;
    return {
      snapshotId: snapshot.snapshotId, observedAt: snapshot.observedAt,
      ...(snapshot.snapshotPath !== undefined ? { snapshotPath: snapshot.snapshotPath } : {}),
      ...(snapshot.historyPath !== undefined ? { historyPath: snapshot.historyPath } : {}),
      ...(['get_recent_messages', 'get_history'].includes(snapshot.request?.operation) && snapshot.request.chatIds?.length === 1 && typeof snapshot.request.chatIds[0] === 'string' && peerPattern.test(snapshot.request.chatIds[0]) && typeof snapshot.request.nextBefore === 'string' && /^[1-9]\d{0,19}$/.test(snapshot.request.nextBefore)
        ? { older: { tool: 'get_history', arguments: { chatId: snapshot.request.chatIds[0], before: snapshot.request.nextBefore, limit } } } : {}),
      collectedCount: snapshot.messages.length, returnedCount: items.length,
      contentIsUntrusted: true, source: 'local', collectionSource: snapshot.request?.source === 'local' ? 'local' : 'telegram', collectionStatus,
      messages: items, coverage: statuses,
      pagination: { complete, index: position.index, textOffset: position.textOffset, coverageIndex: position.coverageIndex },
      next: complete ? null : { tool: 'collect_messages', arguments: { source: 'local', cursor: encodeHistoryCursor(position), limit } },
      resume: snapshot.checkpoint !== null && snapshot.checkpoint !== undefined ? {
        tool: 'collect_messages', arguments: { source: 'telegram', cursor: encodeHistoryCursor({ kind: 'scan', snapshotId: snapshot.snapshotId }), limit },
      } : null,
    };
  };
  while (state.coverageIndex < snapshot.coverage.length) {
    const item = coverageMetadata(snapshot.coverage[state.coverageIndex]);
    const position = { ...state, coverageIndex: state.coverageIndex + 1 };
    if (size(result(position, messages, [...coverage, item])) > budget) break;
    coverage.push(item);
    state = position;
  }
  while (state.index < snapshot.messages.length && messages.length < limit) {
    const message = snapshot.messages[state.index];
    const metadata = messageMetadata(message);
    const { text } = message;
    const offset = state.textOffset;
    const candidate = end => {
      const complete = end === text.length;
      const position = { ...state, index: state.index + (complete ? 1 : 0), textOffset: complete ? 0 : end };
      const item = { ...metadata, text: text.slice(offset, end), textPart: { offset, end, total: text.length, complete } };
      return { position, item };
    };
    const fits = part => size(result(part.position, [...messages, part.item])) <= budget;
    let part = candidate(text.length);
    if (text.length - offset > budget || !fits(part)) {
      let low = 0, high = Math.min(text.length - offset - 1, budget);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const end = safeEnd(text, offset + middle);
        if (end === offset || fits(candidate(end))) low = middle;
        else high = middle - 1;
      }
      const end = safeEnd(text, offset + low);
      if (end === offset) break;
      part = candidate(end);
    }
    messages.push(part.item);
    state = part.position;
    if (!part.item.textPart.complete) break;
  }
  const output = result(state);
  const progressed = state.index !== start.index || state.textOffset !== start.textOffset || state.coverageIndex !== start.coverageIndex;
  if (size(output) > budget || (!output.pagination.complete && !progressed)) throw new Error('OUTPUT_TOO_LARGE');
  return output;
}
