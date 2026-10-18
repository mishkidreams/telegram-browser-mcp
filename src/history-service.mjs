// Account-bound retrieval orchestration. No Telegram navigation or semantic LLM
// decisions here: the external adapter owns one browser lease per online call.
import { createHistorySession } from './history-session.mjs';
import { normalizeCollectionRequest } from './collection-reader.mjs';
import { decodeHistoryCursor, pageHistory } from './history-pages.mjs';
import { projectMessage, messageReference, verifyScope } from './reader-results.mjs';
import { createHash } from 'node:crypto';
const peer = /^-?[1-9]\d{0,19}$/, id = /^[1-9]\d{0,19}$/;
const invalid = () => { throw new Error('INVALID_READ_REQUEST'); };
const stop = signal => { if (signal?.aborted) throw new Error('READ_CANCELLED'); };
const key = m => m.messageRef ?? m.previewRef;
const clean = (value, maximum = 256) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, maximum) : undefined;
function coverage(values) {
  if (!Array.isArray(values) || values.length > 5000) throw new Error('READ_FAILED');
  return values.map(value => {
    if (!value || !peer.test(value.chatId)) throw new Error('READ_FAILED');
    const out = { chatId: value.chatId };
    for (const field of ['status', 'state', 'stopReason', 'since', 'until', 'timeZone', 'replyTo', 'observedAt']) if (value[field] !== undefined) out[field] = clean(value[field]);
    for (const field of ['observedCount', 'unknownTimestamps', 'unknownTimestampCount', 'beforeCount', 'afterCount']) if (Number.isSafeInteger(value[field]) && value[field] >= 0) out[field] = value[field];
    if (value.topicId !== undefined) { if (!id.test(value.topicId)) throw new Error('READ_FAILED'); out.topicId = value.topicId; }
    if (value.requestedWindow) out.requestedWindow = windowRequest(value.requestedWindow);
    return out;
  });
}
function records(values, chatIds, scope = {}) {
  if (!Array.isArray(values) || values.length > 100_000) throw new Error('READ_FAILED');
  return values.map(value => {
    const chatId = value.chatId ?? scope.chatId;
    if (typeof chatId !== 'string' || !chatIds.includes(chatId)) throw new Error('ACCESS_DENIED');
    if (value.previewOnly === true) {
      if (typeof value.text !== 'string' || typeof value.query !== 'string' || !/^tgp1:[a-f0-9]{64}$/.test(value.previewRef) || value.id !== undefined || value.messageRef !== undefined) throw new Error('READ_FAILED');
      return { chatId, previewRef: value.previewRef, previewOnly: true, query: clean(value.query, 200), text: value.text.slice(0, 4096), displayTime: clean(value.displayTime), timestamp: null, ...(value.observedAt ? { observedAt: clean(value.observedAt) } : {}) };
    }
    const postId = scope.postId ?? value.postId;
    if (postId !== undefined && (!id.test(postId) || !chatId.startsWith('-100'))) throw new Error('READ_FAILED');
    return { chatId, ...(postId ? { postId } : {}), ...projectMessage(value, { chatId, ...(postId ? { postId } : {}) }, true),
      ...(value.windowMatch === 'unknown' ? { windowMatch: 'unknown' } : {}), ...(value.observedAt ? { observedAt: clean(value.observedAt) } : {}) };
  });
}
function checkpoint(value, chatIds) {
  if (value === null || value === undefined) return null;
  if (value.version !== 1 || !Array.isArray(value.work) || value.work.length > 5000) throw new Error('READ_FAILED');
  return { version: 1, work: value.work.map(w => {
    if (!chatIds.includes(w.chatId) || typeof w.done !== 'boolean' || (w.before != null && !id.test(w.before)) || (w.topicId !== undefined && !id.test(w.topicId))) throw new Error('READ_FAILED');
    return { chatId: w.chatId, initialized: w.initialized === true, before: w.before ?? null, done: w.done,
      ...(w.topicId ? { topicId: w.topicId } : {}), ...(w.topicsPartial === true ? { topicsPartial: true } : {}), ...(w.chronologyUncertain === true ? { chronologyUncertain: true } : {}),
      status: ['pending', 'partial', 'complete'].includes(w.status) ? w.status : 'partial', stopReason: clean(w.stopReason, 64) ?? 'UNKNOWN',
      observedCount: Number.isSafeInteger(w.observedCount) ? w.observedCount : 0, unknownTimestamps: Number.isSafeInteger(w.unknownTimestamps) ? w.unknownTimestamps : 0,
      ...(Number.isSafeInteger(w.queryIndex) ? { queryIndex: w.queryIndex } : {}) };
  }) };
}
export function windowRequest(value) {
  if (value === undefined) return { before: 25, after: 25 };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const count = Object.keys(value).some(k => k === 'before' || k === 'after');
  const fields = count ? ['before', 'after'] : ['beforeMinutes', 'afterMinutes'];
  if (!Object.keys(value).length || Object.keys(value).some(k => !fields.includes(k))) invalid();
  const result = Object.fromEntries(fields.map(k => [k, value[k] ?? 0]));
  if (Object.values(result).some(n => !Number.isSafeInteger(n) || n < 0 || n > (count ? 100 : 1440))) invalid();
  return result;
}
export function createHistoryService({ root, profileDir = root, config, execute, getPolicy }) {
  const session = createHistorySession({ root, profileDir });
  const authorize = async chatIds => { const policy = await getPolicy(); if (chatIds.some(chatId => !policy.allowedChatIds.includes(chatId))) throw new Error('ACCESS_DENIED'); return policy; };
  const verifySnapshot = async snapshot => {
    const ids = [...new Set([...(snapshot.request.chatIds ?? []), ...snapshot.messages.map(m => m.chatId), ...snapshot.coverage.map(m => m.chatId)])];
    await authorize(ids);
    snapshot.messages = records(snapshot.messages, ids);
    snapshot.coverage = coverage(snapshot.coverage);
    return snapshot;
  };
  async function localBinding() { const bound = await session.local(); if (!bound) throw new Error('HISTORY_NOT_FOUND'); return bound; }
  async function present(bound, snapshotId, args, signal) {
    stop(signal);
    const snapshot = await verifySnapshot(await bound.store.load({ snapshotId, signal }));
    return pageHistory(snapshot, { cursor: args.cursor, limit: args.limit });
  }
  return {
    async collect(args, { signal, progress = async () => {} } = {}) {
      stop(signal);
      const source = args.source ?? 'telegram', limit = args.limit ?? 50;
      let previous, expectedAccount;
      if (args.cursor) {
        if (Object.keys(args).some(k => !['source', 'cursor', 'limit'].includes(k))) invalid();
        const cursor = decodeHistoryCursor(args.cursor), bound = await localBinding();
        if (cursor.kind === 'page') { if (source !== 'local') invalid(); return present(bound, cursor.snapshotId, args, signal); }
        if (source !== 'telegram') invalid();
        previous = await verifySnapshot(await bound.store.load({ snapshotId: cursor.snapshotId, signal }));
        if (!previous.checkpoint) invalid();
        expectedAccount = bound.accountId;
      }
      const policy = await getPolicy();
      const request = previous?.request ?? { ...normalizeCollectionRequest({ ...args, chatIds: args.chatIds ?? policy.allowedChatIds }), source };
      await authorize(request.chatIds);
      if (source === 'local') {
        const bound = await localBinding();
        const value = await bound.store.query({ ...request, signal });
        // Older coverage describes its original interval, not an arbitrary new
        // local query or present Telegram state. Keep it, but never promote it.
        value.coverage.push(...request.chatIds.map(chatId => ({ chatId, status: 'partial', stopReason: 'LOCAL_SNAPSHOT_ONLY', ...(request.since ? { since: request.since, until: request.until } : {}), observedAt: value.observedAt })));
        const saved = await bound.store.snapshot({ ...value, request, checkpoint: null, signal });
        return present(bound, saved.snapshotId, { limit }, signal);
      }
      let bound, observed = new Map();
      const account = async accountId => {
        if (expectedAccount && expectedAccount !== accountId) throw new Error('HISTORY_ACCOUNT_CHANGED');
        if (bound && bound.accountId !== accountId) throw new Error('HISTORY_ACCOUNT_CHANGED');
        bound ??= await session.online(accountId);
        return bound;
      };
      const onPage = async value => {
        stop(signal); await authorize(request.chatIds);
        const current = await account(value.accountId), messages = records(value.messages, request.chatIds);
        const covered = coverage(value.coverage);
        if (covered.some(c => !request.chatIds.includes(c.chatId))) throw new Error('ACCESS_DENIED');
        const saved = await current.store.save({ messages, coverage: covered, request, checkpoint: checkpoint(value.checkpoint, request.chatIds), snapshot: false, signal });
        for (const message of messages) observed.set(key(message), { ...message, observedAt: saved.observedAt });
      };
      const data = await execute({ root, config, policy, operation: 'collect_messages', request, checkpoint: previous?.checkpoint, signal, onPage, authorize: chatId => authorize([chatId]), progress });
      stop(signal); await authorize(request.chatIds);
      await account(data?.accountId);
      if (data?.source !== 'official-web-dom' || data.contentIsUntrusted !== true) throw new Error('READ_FAILED');
      const selected = records(data.messages, request.chatIds);
      if (selected.some(m => !observed.has(key(m)))) await onPage({ ...data, messages: selected });
      const merged = new Map((previous?.messages ?? []).map(m => [key(m), m]));
      for (const message of selected) merged.set(key(message), { ...message, observedAt: observed.get(key(message))?.observedAt ?? message.observedAt });
      const covered = coverage(data.coverage);
      if (covered.some(c => !request.chatIds.includes(c.chatId))) throw new Error('ACCESS_DENIED');
      const saved = await bound.store.snapshot({ messages: [...merged.values()], coverage: covered, request, checkpoint: checkpoint(data.checkpoint, request.chatIds), signal });
      return present(bound, saved.snapshotId, { limit }, signal);
    },
    async context(target, args, { signal } = {}) {
      const policy = await authorize([target.chatId]), window = windowRequest(args.window), source = args.source ?? 'telegram';
      let bound, messages, covered;
      if (source === 'local') {
        bound = await localBinding();
        const value = await bound.store.query({ chatIds: [target.chatId], signal });
        const scoped = value.messages.filter(m => m.id !== undefined && m.postId === target.postId);
        const storedAnchor = scoped.find(m => m.id === target.messageId);
        if (!storedAnchor || (target.topicId && storedAnchor.topic?.id !== target.topicId)) throw new Error('MESSAGE_UNAVAILABLE');
        const topicId = target.topicId ?? storedAnchor.topic?.id ?? null;
        const same = scoped.filter(m => (m.topic?.id ?? null) === topicId).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
        const index = same.findIndex(m => m.id === target.messageId);
        if (index < 0) throw new Error('MESSAGE_UNAVAILABLE');
        if ('before' in window) messages = same.slice(Math.max(0, index - window.before), index + window.after + 1);
        else {
          const anchor = same[index], time = anchor.timestamp ? Date.parse(anchor.timestamp) : NaN;
          messages = !Number.isFinite(time) ? [anchor] : same.filter(m => !m.timestamp || (Date.parse(m.timestamp) >= time - window.beforeMinutes * 60_000 && Date.parse(m.timestamp) <= time + window.afterMinutes * 60_000));
        }
        covered = [{ chatId: target.chatId, status: 'partial', stopReason: 'LOCAL_SNAPSHOT_ONLY', requestedWindow: window }];
      } else {
        const data = await execute({ root, config, policy, operation: 'get_message_context', ...target, window, includeReplyTo: args.includeReplyTo ?? true, signal });
        stop(signal); await authorize([target.chatId]);
        verifyScope(data, target);
        if (target.topicId !== undefined && data.topicId !== target.topicId) throw new Error('READ_FAILED');
        if (data?.peerId !== target.chatId || data.source !== 'official-web-dom' || data.contentIsUntrusted !== true || data.anchor?.id !== target.messageId || (target.postId && (data.postId !== target.postId || data.thread?.openedFromVerifiedPost !== true))) throw new Error('READ_FAILED');
        bound = await session.online(data.accountId);
        messages = records(data.messages, [target.chatId], target);
        if (!messages.some(m => m.id === target.messageId)) throw new Error('READ_FAILED');
        covered = coverage([{ ...data.coverage, chatId: target.chatId }]);
        const saved = await bound.store.save({ messages, coverage: covered, request: { kind: 'context', target, window }, snapshot: false, signal });
        messages = messages.map(m => ({ ...m, observedAt: saved.observedAt }));
      }
      const saved = await bound.store.snapshot({ messages, coverage: covered, request: { kind: 'context', source, target, window }, checkpoint: null, signal });
      return present(bound, saved.snapshotId, { limit: args.limit ?? 50 }, signal);
    },
    async observe(data, result, { operation, chatId, postId, query } = {}, signal) {
      if (!data?.accountId) return null; // Legacy injected adapters, never production.
      await authorize([chatId]);
      const bound = await session.online(data.accountId);
      let messages = [];
      if (operation === 'search_messages') messages = result.matches.map(m => m.previewOnly ? { chatId, previewOnly: true, previewRef: 'tgp1:' + createHash('sha256').update(JSON.stringify([chatId, query, m.preview, m.displayTime])).digest('hex'), query, text: m.preview, displayTime: m.displayTime, timestamp: null } : { ...m, chatId, text: m.preview });
      else if (result.message) messages = records([data.message], [chatId], { chatId, postId });
      else if (Array.isArray(result.comments)) messages = [...records([data.post], [chatId], { chatId }), ...records(data.comments, [chatId], { chatId, postId: data.post.id })];
      else if (Array.isArray(result.messages)) messages = records(data.messages, [chatId], { chatId });
      if (!messages.length) return null;
      return bound.store.save({ messages, coverage: [{ chatId, status: 'partial', stopReason: 'RENDERED_SLICE_ONLY' }], request: { source: 'telegram', operation, chatIds: [chatId], ...(['get_recent_messages', 'get_history'].includes(operation) && result.nextBefore ? { nextBefore: result.nextBefore } : {}) }, signal });
    },
    async exactLocal(target, signal) {
      await authorize([target.chatId]);
      const bound = await localBinding();
      const value = await bound.store.query({ chatIds: [target.chatId], signal });
      const reference = messageReference(target), message = value.messages.find(m => m.messageRef === reference);
      if (!message) throw new Error('MESSAGE_UNAVAILABLE');
      return { ...message, contentIsUntrusted: true, source: 'local' };
    },
    async page(snapshotId, { limit = 50, cursor, signal } = {}) { return present(await localBinding(), snapshotId, { limit, cursor }, signal); },
  };
}
