// Persistent local observations, not a cache. No TTL, eviction, deletion inference,
// browser access, or authorization decisions live here. The caller supplies a
// verified account/profile dataset and currently authorized chat IDs for queries.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensurePrivateDirectory } from './local-storage.mjs';

const datasetPattern = /^[A-Za-z0-9_-]{1,80}$/;
const snapshotPattern = /^[a-f0-9]{48}$/;
const peerPattern = /^-?[1-9]\d{0,19}$/;
const referencePattern = /^tgm1:(-?[1-9]\d{0,19}):([1-9]\d{0,19})(?::([1-9]\d{0,19}))?$/;
// These are operation/parser safety limits, not retention quotas. No existing
// observation is ever removed to satisfy a limit or recover from a disk failure.
const metadataBytes = 1024 * 1024;
const recordBytes = 64 * 1024 * 1024;
const resultBytes = 128 * 1024 * 1024;
const chunkBytes = 64 * 1024;
class HistoryError extends Error {}
const fail = code => { throw new HistoryError(code); };
const cancelled = signal => { if (signal?.aborted) fail('READ_CANCELLED'); };
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function iso(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour < 24 && minute < 60 && second < 60;
}

function normalizeError(error, fallback, signal) {
  if (error instanceof HistoryError) return new Error(error.message);
  if (signal?.aborted || error?.name === 'AbortError') return new Error('READ_CANCELLED');
  if (error?.message === 'LOCAL_STORAGE_UNSAFE' || error?.code === 'ELOOP') return new Error('HISTORY_UNSAFE');
  return new Error(fallback);
}
function encode(value, maxBytes, error) {
  const active = new Set();
  function safeJson(item, depth) {
    if (depth > 32) fail(error);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || active.has(item)) fail(error);
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail(error);
    active.add(item);
    if (Array.isArray(item)) { for (const entry of item) safeJson(entry, depth + 1); }
    else { for (const entry of Object.values(item)) if (entry !== undefined) safeJson(entry, depth + 1); }
    active.delete(item);
  }
  safeJson(value, 0);
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail(error); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > maxBytes) fail(error);
  return encoded;
}
function messageRecord(value, observedAt, error) {
  if (!object(value) || typeof value.text !== 'string' || (value.timestamp !== undefined && value.timestamp !== null && !iso(value.timestamp))) fail(error);
  if (value.previewOnly === true || value.previewRef !== undefined) {
    if (value.previewOnly !== true || typeof value.previewRef !== 'string' || !/^tgp1:[a-f0-9]{64}$/.test(value.previewRef) || typeof value.chatId !== 'string' || !peerPattern.test(value.chatId) || value.id !== undefined || value.messageRef !== undefined || typeof value.query !== 'string' || value.timestamp !== null) fail(error);
  } else {
    const match = typeof value.messageRef === 'string' && referencePattern.exec(value.messageRef);
    if (!match || value.chatId !== match[1] || value.id !== match[2] || value.postId !== match[3]) fail(error);
  }
  return { ...value, timestamp: value.timestamp ?? null, observedAt };
}
function coverageRecord(value, observedAt, error) {
  if (!object(value) || typeof value.chatId !== 'string' || !peerPattern.test(value.chatId)) fail(error);
  return { ...value, observedAt };
}
const recordKey = value => value.messageRef ?? value.previewRef;
const partial = value => value.textTruncated === true || value.partial === true || value.previewOnly === true;
function mergeMessage(older, newer) {
  const merged = { ...older, ...newer, timestamp: newer.timestamp ?? older.timestamp ?? null };
  // Completeness describes this text observation, not inherited history. In
  // particular, a new full edit with omitted flags must clear an old partial flag.
  for (const field of ['textTruncated', 'partial', 'previewOnly', 'textObservedAt']) {
    if (!Object.hasOwn(newer, field)) delete merged[field];
  }
  if (partial(newer) && older.text.length > newer.text.length) {
    merged.text = older.text;
    merged.textTruncated = older.textTruncated === true;
    if ('partial' in older || 'partial' in newer) merged.partial = older.partial === true;
    if ('previewOnly' in older || 'previewOnly' in newer) merged.previewOnly = older.previewOnly === true;
    merged.textObservedAt = older.textObservedAt ?? older.observedAt;
  }
  return merged;
}
function deduplicate(records) {
  const unique = new Map();
  for (const record of records) {
    const key = recordKey(record);
    unique.set(key, unique.has(key) ? mergeMessage(unique.get(key), record) : record);
  }
  return [...unique.values()];
}
async function protectedDirectory(directory) {
  await ensurePrivateDirectory(directory);
}
async function checkedFile(file) {
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !samePath(await fs.realpath(file), file)) fail('HISTORY_UNSAFE');
  return before;
}
async function openRead(file) {
  const before = await checkedFile(file);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const after = await checkedFile(file);
    if (!sameIdentity(before, opened) || !sameIdentity(before, after)) fail('HISTORY_UNSAFE');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function readMetadata(file, signal) {
  cancelled(signal);
  const handle = await openRead(file);
  try {
    if ((await handle.stat()).size > metadataBytes) fail('HISTORY_READ_FAILED');
    const chunks = [];
    let total = 0;
    for (;;) {
      cancelled(signal);
      const buffer = Buffer.allocUnsafe(chunkBytes);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > metadataBytes) fail('HISTORY_READ_FAILED');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { fail('HISTORY_READ_FAILED'); }
  } finally { await handle.close(); }
}
async function* readRecords(file, signal) {
  const handle = await openRead(file);
  let pieces = [], size = 0;
  const decode = () => {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pieces, size))); }
    catch { fail('HISTORY_READ_FAILED'); }
  };
  try {
    for (;;) {
      cancelled(signal);
      const buffer = Buffer.allocUnsafe(chunkBytes);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      let start = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== 10) continue;
        pieces.push(buffer.subarray(start, index)); size += index - start;
        if (!size || size > recordBytes) fail('HISTORY_READ_FAILED');
        yield decode();
        pieces = []; size = 0; start = index + 1;
      }
      if (start < bytesRead) { pieces.push(buffer.subarray(start, bytesRead)); size += bytesRead - start; }
      if (size > recordBytes) fail('HISTORY_READ_FAILED');
    }
    // Writers always finish records with LF. A torn final record is corruption.
    if (size) fail('HISTORY_READ_FAILED');
  } finally { await handle.close(); }
}
async function writeRecords(file, records, signal) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    for await (const record of records) {
      cancelled(signal);
      await handle.writeFile(encode(record, recordBytes, 'HISTORY_WRITE_FAILED') + '\n');
    }
    await handle.sync();
  } finally { await handle.close(); }
}
async function writeMetadata(file, value, signal) {
  cancelled(signal);
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(encode(value, metadataBytes, 'HISTORY_WRITE_FAILED') + '\n', { signal });
    await handle.sync();
  } finally { await handle.close(); }
}

/**
 * Each snapshot contains the collection's own messages.jsonl/coverage.jsonl,
 * and history is an append-only chain of immutable page segments, each containing
 * readable messages.jsonl/coverage.jsonl plus request/checkpoint metadata. The
 * bounded head.json is the ONLY mutable commit point. A snapshot:false page adds
 * one segment, not a cumulative copy. Earlier files are never rewritten/removed.
 * historyPath is the committed page segment's messages.jsonl; query() reads the
 * complete committed segment chain. Interrupted
 * staging directories/locks are not automatically garbage-collected.
 */
export function createHistoryStore({ root, datasetId } = {}) {
  if (typeof root !== 'string' || !root.trim() || /[\x00-\x1f]/.test(root) || typeof datasetId !== 'string' || !datasetPattern.test(datasetId)) fail('HISTORY_UNSAFE');
  const directory = path.join(path.resolve(root), 'private', 'history', datasetId);
  const snapshots = path.join(directory, 'snapshots');
  const segments = path.join(directory, 'segments');
  const headPath = path.join(directory, 'head.json');
  const snapshotPathFor = snapshotId => path.join(snapshots, snapshotId);

  async function head(signal) {
    let value;
    try { value = await readMetadata(headPath, signal); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    if (!object(value) || value.version !== 1 || value.datasetId !== datasetId || typeof value.segmentId !== 'string' || !snapshotPattern.test(value.segmentId) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !iso(value.observedAt)) fail('HISTORY_READ_FAILED');
    return value;
  }
  async function withLock(action, signal) {
    cancelled(signal);
    await protectedDirectory(directory);
    const lockPath = path.join(directory, '.lock');
    let lock;
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await checkedFile(lockPath);
      fail('HISTORY_BUSY');
    }
    const identity = await lock.stat({ bigint: true });
    try { return await action(); }
    finally {
      await lock.close();
      // Never unlink a lock replaced by another owner or a redirected file.
      const current = await checkedFile(lockPath);
      if (!sameIdentity(identity, current)) fail('HISTORY_UNSAFE');
      await fs.unlink(lockPath);
    }
  }
  return {
    async save({ messages = [], coverage = [], request = {}, checkpoint = null, snapshot = true, signal } = {}) {
      const staging = new Set();
      try {
        cancelled(signal);
        if (!Array.isArray(messages) || !Array.isArray(coverage) || !object(request) || (checkpoint !== null && !object(checkpoint)) || typeof snapshot !== 'boolean') fail('HISTORY_WRITE_FAILED');
        return await withLock(async () => {
          const previous = await head(signal);
          const sequence = (previous?.sequence ?? 0) + 1;
          if (!Number.isSafeInteger(sequence)) fail('HISTORY_WRITE_FAILED');
          await protectedDirectory(snapshots);
          await protectedDirectory(segments);
          const id = randomBytes(24).toString('hex');
          const observedAt = new Date().toISOString();
          const records = deduplicate(messages.map(value => messageRecord(value, observedAt, 'HISTORY_WRITE_FAILED')));
          const covered = coverage.map(value => coverageRecord(value, observedAt, 'HISTORY_WRITE_FAILED'));
          const metadata = { version: 1, kind: 'online', datasetId, snapshotId: snapshot ? id : null, segmentId: id, previous: previous?.segmentId ?? null, sequence, observedAt, createdAt: observedAt, messageCount: records.length, coverageCount: covered.length, request, checkpoint };
          encode(metadata, metadataBytes - 1, 'HISTORY_WRITE_FAILED');
          const destinations = [path.join(segments, id), ...(snapshot ? [snapshotPathFor(id)] : [])];
          for (const destination of destinations) {
            const pending = path.join(path.dirname(destination), '.pending-' + id);
            staging.add(pending);
            await protectedDirectory(pending);
            await writeRecords(path.join(pending, 'messages.jsonl'), records, signal);
            await writeRecords(path.join(pending, 'coverage.jsonl'), covered, signal);
            await writeMetadata(path.join(pending, 'manifest.json'), metadata, signal);
          }
          const headTemp = path.join(directory, '.head-' + id + '.tmp');
          staging.add(headTemp);
          await writeMetadata(headTemp, { version: 1, datasetId, segmentId: id, sequence, observedAt }, signal);
          for (const destination of destinations) {
            const pending = path.join(path.dirname(destination), '.pending-' + id);
            await protectedDirectory(pending);
            cancelled(signal);
            await fs.rename(pending, destination); staging.delete(pending);
          }
          cancelled(signal);
          await fs.rename(headTemp, headPath); staging.delete(headTemp);
          return { snapshotId: snapshot ? id : null, snapshotPath: snapshot ? snapshotPathFor(id) : null, historyPath: path.join(segments, id, 'messages.jsonl'), observedAt, messageCount: records.length, coverageCount: covered.length };
        }, signal);
      } catch (error) { throw normalizeError(error, 'HISTORY_WRITE_FAILED', signal); }
      finally {
        // Only this operation's uncommitted staging files can be removed.
        for (const temporary of staging) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
      }
    },
    async snapshot({ messages = [], coverage = [], request = {}, checkpoint = null, signal } = {}) {
      let pending;
      try {
        cancelled(signal);
        if (!Array.isArray(messages) || !Array.isArray(coverage) || !object(request) || (checkpoint !== null && !object(checkpoint))) fail('HISTORY_WRITE_FAILED');
        return await withLock(async () => {
          const freshness = value => {
            const observedAt = value?.observedAt ?? null;
            if (observedAt !== null && !iso(observedAt)) fail('HISTORY_WRITE_FAILED');
            return observedAt;
          };
          const records = deduplicate(messages.map(value => messageRecord(value, freshness(value), 'HISTORY_WRITE_FAILED')));
          const covered = coverage.map(value => coverageRecord(value, freshness(value), 'HISTORY_WRITE_FAILED'));
          let observedAt = null;
          for (const record of [...records, ...covered]) if (record.observedAt !== null && (observedAt === null || Date.parse(record.observedAt) > Date.parse(observedAt))) observedAt = record.observedAt;
          const snapshotId = randomBytes(24).toString('hex'), createdAt = new Date().toISOString();
          const snapshotPath = snapshotPathFor(snapshotId);
          const metadata = { version: 1, kind: 'local', datasetId, snapshotId, createdAt, observedAt, messageCount: records.length, coverageCount: covered.length, request, checkpoint };
          encode(metadata, metadataBytes - 1, 'HISTORY_WRITE_FAILED');
          await protectedDirectory(snapshots);
          pending = path.join(snapshots, '.pending-' + snapshotId);
          await protectedDirectory(pending);
          await writeRecords(path.join(pending, 'messages.jsonl'), records, signal);
          await writeRecords(path.join(pending, 'coverage.jsonl'), covered, signal);
          await writeMetadata(path.join(pending, 'manifest.json'), metadata, signal);
          await protectedDirectory(pending);
          cancelled(signal);
          await fs.rename(pending, snapshotPath); pending = undefined;
          return { snapshotId, snapshotPath, historyPath: path.join(snapshotPath, 'messages.jsonl'), observedAt, messageCount: records.length, coverageCount: covered.length };
        }, signal);
      } catch (error) { throw normalizeError(error, 'HISTORY_WRITE_FAILED', signal); }
      finally { if (pending) await fs.rm(pending, { recursive: true, force: true }).catch(() => {}); }
    },
    async query({ chatIds, since, until, queries = [], signal } = {}) {
      try {
        cancelled(signal);
        if (!Array.isArray(chatIds) || chatIds.length > 1000 || chatIds.some(id => typeof id !== 'string' || !peerPattern.test(id))) fail('HISTORY_READ_FAILED');
        if ((since !== undefined && !iso(since)) || (until !== undefined && !iso(until)) || (since !== undefined && until !== undefined && Date.parse(since) >= Date.parse(until)) || !Array.isArray(queries) || queries.length > 1000 || queries.some(query => typeof query !== 'string' || !query.length || query.length > 4096)) fail('HISTORY_READ_FAILED');
        const allowed = new Set(chatIds), terms = queries.map(query => query.toLowerCase());
        const start = since === undefined ? -Infinity : Date.parse(since), end = until === undefined ? Infinity : Date.parse(until);
        const dated = since !== undefined || until !== undefined;
        return await withLock(async () => {
          const current = await head(signal);
          let segmentId = current?.segmentId ?? null, sequence = current?.sequence ?? 0;
          let bytes = 0;
          const messages = new Map(), coverage = [];
          while (segmentId !== null) {
            cancelled(signal);
            const segmentPath = path.join(segments, segmentId);
            await protectedDirectory(segmentPath);
            const metadata = await readMetadata(path.join(segmentPath, 'manifest.json'), signal);
            if (!object(metadata) || metadata.version !== 1 || metadata.datasetId !== datasetId || metadata.segmentId !== segmentId || metadata.sequence !== sequence || !iso(metadata.observedAt) || !Number.isSafeInteger(metadata.messageCount) || metadata.messageCount < 0 || !Number.isSafeInteger(metadata.coverageCount) || metadata.coverageCount < 0 || (metadata.previous !== null && (typeof metadata.previous !== 'string' || !snapshotPattern.test(metadata.previous)))) fail('HISTORY_READ_FAILED');
            let messageCount = 0, coverageCount = 0;
            for await (const value of readRecords(path.join(segmentPath, 'messages.jsonl'), signal)) {
              if (value.observedAt !== metadata.observedAt) fail('HISTORY_READ_FAILED');
              const record = messageRecord(value, metadata.observedAt, 'HISTORY_READ_FAILED');
              messageCount++;
              if (!allowed.has(record.chatId)) continue;
              const key = recordKey(record), newer = messages.get(key);
              const merged = newer ? mergeMessage(record, newer) : record;
              bytes += Buffer.byteLength(encode(merged, recordBytes, 'HISTORY_READ_FAILED')) - (newer ? Buffer.byteLength(JSON.stringify(newer)) : 0);
              if (bytes > resultBytes) fail('HISTORY_READ_FAILED');
              messages.set(key, merged);
            }
            for await (const value of readRecords(path.join(segmentPath, 'coverage.jsonl'), signal)) {
              if (value.observedAt !== metadata.observedAt) fail('HISTORY_READ_FAILED');
              const record = coverageRecord(value, metadata.observedAt, 'HISTORY_READ_FAILED');
              coverageCount++;
              if (!allowed.has(record.chatId)) continue;
              bytes += Buffer.byteLength(encode(record, recordBytes, 'HISTORY_READ_FAILED'));
              if (bytes > resultBytes) fail('HISTORY_READ_FAILED');
              coverage.push(record);
            }
            if (messageCount !== metadata.messageCount || coverageCount !== metadata.coverageCount) fail('HISTORY_READ_FAILED');
            segmentId = metadata.previous; sequence--;
            if ((sequence === 0) !== (segmentId === null)) fail('HISTORY_READ_FAILED');
          }
          const unknown = new Map();
          const selected = [...messages.values()].filter(record => {
            if (dated && record.timestamp === null) {
              unknown.set(record.chatId, (unknown.get(record.chatId) ?? 0) + 1);
              return false;
            }
            const time = record.timestamp === null ? null : Date.parse(record.timestamp);
            return (!dated || (time >= start && time < end)) && (!terms.length || terms.some(term => record.text.toLowerCase().includes(term)));
          });
          const sorted = selected.sort((left, right) => {
            if ((left.timestamp === null) !== (right.timestamp === null)) return left.timestamp === null ? 1 : -1;
            const time = left.timestamp === null ? 0 : Date.parse(left.timestamp) - Date.parse(right.timestamp);
            if (time) return time;
            if (left.chatId !== right.chatId) return BigInt(left.chatId) < BigInt(right.chatId) ? -1 : 1;
            if (left.id !== undefined && right.id !== undefined) return BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0;
            return recordKey(left) < recordKey(right) ? -1 : recordKey(left) > recordKey(right) ? 1 : 0;
          });
          for (const chatId of allowed) {
            if (!coverage.some(record => record.chatId === chatId)) coverage.push({ chatId, state: 'unknown', stopReason: 'LOCAL_HISTORY_GAP', since: since ?? null, until: until ?? null, observedAt: current?.observedAt ?? null });
            if (unknown.has(chatId)) coverage.push({ chatId, state: 'partial', stopReason: 'UNKNOWN_TIMESTAMP', unknownTimestampCount: unknown.get(chatId), since: since ?? null, until: until ?? null, observedAt: current?.observedAt ?? null });
          }
          return { messages: sorted, coverage, observedAt: current?.observedAt ?? null };
        }, signal);
      } catch (error) { throw normalizeError(error, 'HISTORY_READ_FAILED', signal); }
    },
    async load({ snapshotId, signal } = {}) {
      try {
        cancelled(signal);
        if (typeof snapshotId !== 'string' || !snapshotPattern.test(snapshotId)) fail('HISTORY_UNSAFE');
        const snapshotPath = snapshotPathFor(snapshotId);
        try { await fs.lstat(snapshotPath); } catch (error) { if (error?.code === 'ENOENT') fail('HISTORY_NOT_FOUND'); throw error; }
        await protectedDirectory(snapshotPath);
        const metadata = await readMetadata(path.join(snapshotPath, 'manifest.json'), signal);
        if (!object(metadata) || metadata.version !== 1 || !['online', 'local'].includes(metadata.kind) || metadata.datasetId !== datasetId || metadata.snapshotId !== snapshotId || !iso(metadata.createdAt) || (metadata.observedAt !== null && !iso(metadata.observedAt)) || (metadata.kind === 'online' && metadata.observedAt === null) || !Number.isSafeInteger(metadata.messageCount) || metadata.messageCount < 0 || !Number.isSafeInteger(metadata.coverageCount) || metadata.coverageCount < 0 || !object(metadata.request) || (metadata.checkpoint !== null && !object(metadata.checkpoint))) fail('HISTORY_READ_FAILED');
        const messages = [], coverage = [];
        let bytes = 0;
        for await (const value of readRecords(path.join(snapshotPath, 'messages.jsonl'), signal)) {
          bytes += Buffer.byteLength(encode(value, recordBytes, 'HISTORY_READ_FAILED'));
          if (bytes > resultBytes) fail('HISTORY_READ_FAILED');
          if ((value.observedAt !== null && !iso(value.observedAt)) || (metadata.kind === 'online' && value.observedAt !== metadata.observedAt)) fail('HISTORY_READ_FAILED');
          messages.push(messageRecord(value, value.observedAt, 'HISTORY_READ_FAILED'));
        }
        for await (const value of readRecords(path.join(snapshotPath, 'coverage.jsonl'), signal)) {
          bytes += Buffer.byteLength(encode(value, recordBytes, 'HISTORY_READ_FAILED'));
          if (bytes > resultBytes || (value.observedAt !== null && !iso(value.observedAt)) || (metadata.kind === 'online' && value.observedAt !== metadata.observedAt)) fail('HISTORY_READ_FAILED');
          coverage.push(coverageRecord(value, value.observedAt, 'HISTORY_READ_FAILED'));
        }
        if (messages.length !== metadata.messageCount || coverage.length !== metadata.coverageCount) fail('HISTORY_READ_FAILED');
        return { snapshotId, snapshotPath, historyPath: metadata.kind === 'local' ? path.join(snapshotPath, 'messages.jsonl') : path.join(segments, snapshotId, 'messages.jsonl'), observedAt: metadata.observedAt, createdAt: metadata.createdAt, messages, coverage, request: metadata.request, checkpoint: metadata.checkpoint };
      } catch (error) { throw normalizeError(error, 'HISTORY_READ_FAILED', signal); }
    },
  };
}
