// Deterministic traversal only. Semantic relevance belongs to the calling agent.
import { createHash } from 'node:crypto';

const peer = /^-?[1-9]\d{0,19}$/;
const id = /^[1-9]\d{0,19}$/;
const instant = value => {
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('INVALID_READ_REQUEST');
  const [year, month, day, hour] = [Number(value.slice(0, 4)), Number(value.slice(5, 7)), Number(value.slice(8, 10)), Number(value.slice(11, 13))];
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23) throw new Error('INVALID_READ_REQUEST');
  return new Date(value).toISOString();
};
export function normalizeCollectionRequest(value, now = Date.now()) {
  if (!value || !Array.isArray(value.chatIds) || !value.chatIds.length || value.chatIds.length > 1000 || value.chatIds.some(x => typeof x !== 'string' || !peer.test(x))) throw new Error('INVALID_READ_REQUEST');
  const queries = value.queries ?? [];
  if (!Array.isArray(queries) || queries.length > 8 || queries.some(q => typeof q !== 'string' || !q.trim() || q.length > 200 || /[\x00-\x1f\x7f]/.test(q) || /^(#|from:)/i.test(q.trim()))) throw new Error('INVALID_READ_REQUEST');
  const since = value.since === undefined ? null : instant(value.since);
  const until = value.until === undefined ? (since ? new Date(now).toISOString() : null) : instant(value.until);
  if ((!since && !queries.length) || (until && !since) || (since && Date.parse(since) >= Date.parse(until))) throw new Error('INVALID_READ_REQUEST');
  const timeZone = value.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { if (typeof timeZone !== 'string' || timeZone.length > 100) throw new Error(); new Intl.DateTimeFormat('en', { timeZone }); } catch { throw new Error('INVALID_READ_REQUEST'); }
  return { chatIds: [...new Set(value.chatIds)], ...(since ? { since, until } : {}), timeZone, queries: [...new Set(queries.map(q => q.trim()))] };
}
const matches = (text, queries) => !queries.length || queries.some(q => text.toLocaleLowerCase().includes(q.toLocaleLowerCase()));
const key = value => value.previewRef ?? `${value.chatId}:${value.id}:${value.postId ?? ''}`;
const cancelled = signal => { if (signal?.aborted) throw new Error('READ_CANCELLED'); };
function scopedPage(value, chatId) {
  if (!value || value.peerId !== chatId || value.source !== 'official-web-dom' || value.contentIsUntrusted !== true || !Array.isArray(value.messages) || value.messages.length > 100) throw new Error('READ_FAILED');
  if (value.messages.some((m, i, all) => !m || typeof m.id !== 'string' || !id.test(m.id) || typeof m.text !== 'string' || (i && BigInt(m.id) <= BigInt(all[i - 1].id)))) throw new Error('READ_FAILED');
  return value.messages;
}

// reader is the external, already-leased browser adapter. One call owns it across
// all chats. authorize and onPage run before proceeding to the next observation.
export async function collectFromBrowser({ reader, request, checkpoint, signal, authorize = async () => {}, onPage = async () => {}, progress = async () => {}, deadlineMs = 80_000, maxPages = 100, now = Date.now }) {
  request = normalizeCollectionRequest(request, now());
  const start = now(), deadline = start + deadlineMs;
  const work = checkpoint?.work ? structuredClone(checkpoint.work) : request.chatIds.map(chatId => ({ chatId, initialized: false, before: null, done: false, status: 'pending', stopReason: 'NOT_VISITED', unknownTimestamps: 0, observedCount: 0 }));
  if (!Array.isArray(work) || work.length > 5000 || work.some(w => !request.chatIds.includes(w.chatId) || (w.before !== null && w.before !== undefined && !id.test(w.before)) || (w.topicId !== undefined && !id.test(w.topicId)))) throw new Error('INVALID_READ_REQUEST');
  const selected = new Map();
  // Per-operation working-set bounds are NOT persisted-history eviction.
  const selectedByteBudget = 32 * 1024 * 1024;
  let pages = 0, selectedBytes = 0;
  // A native loading stall pauses this call, not the requested history itself.
  // Retry only after an explicit resume, so a broken client cannot spin here.
  const paused = new Set();
  const state = () => work.some(w => !w.done) ? { version: 1, work: structuredClone(work) } : null;
  const coverage = () => work.map(w => ({ chatId: w.chatId, ...(w.topicId ? { topicId: w.topicId } : {}), status: w.status, stopReason: w.stopReason, observedCount: w.observedCount ?? 0, unknownTimestamps: w.unknownTimestamps ?? 0, ...(request.since ? { since: request.since, until: request.until } : {}) }));
  while (work.some(w => !w.done && !paused.has(w)) && pages < maxPages && now() < deadline && selectedBytes < selectedByteBudget) {
    for (const scope of [...work]) {
      if (scope.done || paused.has(scope) || pages >= maxPages || now() >= deadline || selectedBytes >= selectedByteBudget) continue;
      cancelled(signal);
      await authorize(scope.chatId);
      let fetched = [];
      try {
        // Enumerate only this granted parent's own topic UI. Failure remains a
        // coverage limitation; it never becomes proof of a non-forum peer.
        if (request.since && !scope.initialized && !scope.topicId && scope.chatId.startsWith('-') && reader.listTopics) {
          let topics;
          try { topics = await reader.listTopics({ chatId: scope.chatId }); }
          catch (error) {
            if (['ACCESS_DENIED', 'READ_CANCELLED'].includes(error?.message)) throw error;
            scope.topicsPartial = true;
            topics = { peerId: scope.chatId, isForum: null, topics: [], completeByUi: false };
          }
          if (!topics || topics.peerId !== scope.chatId || !Array.isArray(topics.topics)) throw new Error('READ_FAILED');
          if (topics.isForum === true) {
            scope.topicsPartial = topics.completeByUi !== true;
            for (const topic of topics.topics) {
              if (!topic || !id.test(topic.id)) throw new Error('READ_FAILED');
              if (!work.some(w => w.chatId === scope.chatId && w.topicId === topic.id)) {
                if (work.length >= 5000) { scope.topicsPartial = true; break; }
                work.push({ chatId: scope.chatId, topicId: topic.id, initialized: false, before: null, done: false, status: 'pending', stopReason: 'NOT_VISITED', unknownTimestamps: 0, observedCount: 0 });
              }
            }
          } else if (topics.isForum !== false) scope.topicsPartial = true;
        }
        if (!request.since) {
          // Native lexical search: previews are stored as previews, never given
          // fabricated message IDs or passed off as full conversation records.
          scope.queryIndex ??= 0;
          for (; scope.queryIndex < request.queries.length; scope.queryIndex++) {
            const query = request.queries[scope.queryIndex];
            cancelled(signal); await authorize(scope.chatId);
            if (now() >= deadline) break;
            const result = await reader.searchMessages({ chatId: scope.chatId, query, limit: 50 });
            if (!result || result.peerId !== scope.chatId || result.source !== 'official-web-search-dom' || result.query !== query || result.scopeVerifiedByUi !== true || result.contentIsUntrusted !== true || !Array.isArray(result.matches) || result.matches.length > 50) throw new Error('READ_FAILED');
            for (const match of result.matches) {
              if (typeof match?.preview !== 'string' || typeof match.displayTime !== 'string') throw new Error('READ_FAILED');
              const previewRef = 'tgp1:' + createHash('sha256').update(JSON.stringify([scope.chatId, query, match.preview, match.displayTime])).digest('hex');
              fetched.push({ chatId: scope.chatId, previewRef, previewOnly: true, text: match.preview, query, displayTime: match.displayTime, timestamp: null });
            }
          }
          scope.done = scope.queryIndex === request.queries.length;
          scope.status = 'partial'; scope.stopReason = scope.done ? 'SEARCH_PREVIEWS_ONLY' : 'OPERATION_BUDGET';
        } else {
          const args = { chatId: scope.chatId, limit: 50, ...(scope.before ? { before: scope.before } : {}) };
          const result = scope.topicId ? await reader.readTopicHistory({ ...args, topicId: scope.topicId }) : scope.before ? await reader.readHistory(args) : await reader.readLatest(args);
          const messages = scopedPage(result, scope.chatId);
          if (scope.before && messages.some(m => BigInt(m.id) >= BigInt(scope.before))) throw new Error('READ_FAILED');
          fetched = messages.map(m => ({ ...m, chatId: scope.chatId, ...(scope.topicId ? { topic: { id: scope.topicId, name: m.topic?.name ?? null } } : {}) }));
          scope.unknownTimestamps += fetched.filter(m => !m.timestamp || !Number.isFinite(Date.parse(m.timestamp))).length;
          const dated = messages.filter(m => typeof m.timestamp === 'string' && Number.isFinite(Date.parse(m.timestamp)));
          if (dated.some((m, i) => i && Date.parse(m.timestamp) < Date.parse(dated[i - 1].timestamp))) scope.chronologyUncertain = true;
          const boundary = !scope.chronologyUncertain && messages[0]?.timestamp && Number.isFinite(Date.parse(messages[0].timestamp)) && Date.parse(messages[0].timestamp) < Date.parse(request.since);
          if (boundary) {
            scope.done = true; scope.status = scope.unknownTimestamps || scope.topicsPartial ? 'partial' : 'complete'; scope.stopReason = scope.unknownTimestamps ? 'UNKNOWN_TIMESTAMPS' : scope.topicsPartial ? 'TOPICS_NOT_COMPLETE' : 'TIME_BOUNDARY';
          } else if (!messages.length) { scope.done = true; scope.status = 'partial'; scope.stopReason = 'HISTORY_NOT_CONFIRMED'; }
          else scope.before = messages[0].id;
          if (!scope.done) { scope.status = 'partial'; scope.stopReason = 'MORE_HISTORY'; }
        }
        scope.initialized = true;
        scope.observedCount += fetched.length;
        for (const m of fetched) {
          const time = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : NaN;
          const inWindow = !request.since || !Number.isFinite(time) || (time >= Date.parse(request.since) && time < Date.parse(request.until));
          if (inWindow && matches(m.text, request.queries)) {
            const previous = selected.get(key(m));
            const record = { ...m, ...(request.since && !Number.isFinite(time) ? { windowMatch: 'unknown' } : {}) };
            selectedBytes += Buffer.byteLength(JSON.stringify(record), 'utf8') - (previous ? Buffer.byteLength(JSON.stringify(previous), 'utf8') : 0);
            selected.set(key(m), record);
          }
        }
      } catch (error) {
        if (signal?.aborted || ['ACCESS_DENIED', 'READ_NOT_AUTHORIZED', 'READ_CANCELLED'].includes(error?.message)) throw error;
        scope.done = error?.message !== 'HISTORY_NOT_LOADED'; scope.status = 'partial';
        if (!scope.done) paused.add(scope);
        scope.stopReason = ['HISTORY_NOT_LOADED', 'READ_TARGET_CHANGED', 'TARGET_NOT_VERIFIED', 'CLIENT_CHANGED', 'SEARCH_NOT_READY'].includes(error?.message) ? error.message : 'READ_FAILED';
      }
      cancelled(signal);
      await authorize(scope.chatId);
      // Persist even records outside the presentation filter, including the
      // observed time-boundary message. No byte-based presentation loss here.
      await onPage({ messages: fetched, coverage: coverage(), checkpoint: state(), request });
      await progress({ completed: work.filter(w => w.done).length, total: work.length, pages: ++pages });
    }
  }
  return { source: 'official-web-dom', contentIsUntrusted: true, request, messages: [...selected.values()], coverage: coverage(), checkpoint: state() };
}
