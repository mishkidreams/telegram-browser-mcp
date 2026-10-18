// Read-only conversation windows on official Web A. Never a browser/URL tool.
// DOM/routing pinned to Ajaxy/telegram-tt f67a40879a7d78c2683ec5a296cf55bc22417d56.
import { enrichMessageMetadata, normalizeMessageEvidence } from './message-metadata.mjs';
import { enrichMedia } from './media-transfer.mjs';

const peerPattern = /^-?[1-9]\d{0,19}$/;
const idPattern = /^[1-9]\d{0,19}$/;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const compare = (a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
const envelope = peerId => ({ peerId, source: 'official-web-dom', contentIsUntrusted: true });

function normalizeWindow(value) {
  if (value === undefined) return { before: 25, after: 25 };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_READ_REQUEST');
  const keys = Object.keys(value), counts = keys.some(key => key === 'before' || key === 'after');
  const allowed = counts ? ['before', 'after'] : ['beforeMinutes', 'afterMinutes'];
  if (!keys.length || keys.some(key => !allowed.includes(key))) throw new Error('INVALID_READ_REQUEST');
  const result = Object.fromEntries(allowed.map(key => [key, value[key] ?? 0]));
  if (Object.values(result).some(number => !Number.isInteger(number) || number < 0 || number > (counts ? 100 : 1440))) throw new Error('INVALID_READ_REQUEST');
  return result;
}

// Only scoped metadata/IDs are inspected before the final selected-row capture.
// Thread permission is supplied only by baseReader.message's verified-post proof.
function inspectConversation({ scope, phase = 'state', ids, direction }) {
  const fail = () => phase === 'bind' ? null : ({ error: 'READ_TARGET_CHANGED' });
  const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const actualPeer = scope.thread?.peerId ?? scope.chatId, root = scope.thread?.rootMessageId ?? scope.topicId ?? '-1';
  const expectedHash = root === '-1' ? `#${actualPeer}` : `#${actualPeer}_${root}`;
  if (location.origin !== 'https://web.telegram.org' || location.pathname !== '/a/' || location.hash !== expectedHash) return fail();
  const headers = [...document.querySelectorAll('#MiddleColumn .MiddleHeader')].filter(visible);
  if (headers.length !== 1) return fail();
  if (scope.topicId) {
    if (!visible(headers[0].querySelector('.topic-header-icon'))) return fail();
    const title = headers[0].querySelector('.ChatInfo .fullName');
    if (!title || title.textContent.trim() !== scope.topicName) return fail();
    if ([...headers[0].querySelectorAll('.Avatar[data-peer-id]')].some(element => element.getAttribute('data-peer-id') !== actualPeer)) return fail();
  } else if (!scope.thread) {
    const wrappers = [...headers[0].querySelectorAll('.chat-info-wrapper')].filter(visible);
    if (wrappers.length !== 1 || headers[0].querySelector('.topic-header-icon')) return fail();
    if (visible(document.querySelector('#TopicListHeader'))) return { error: 'TOPIC_REQUIRED' };
    const peers = [...new Set([...wrappers[0].querySelectorAll('[data-peer-id]')].map(element => element.getAttribute('data-peer-id')))];
    if (peers.length !== 1 || peers[0] !== actualPeer) return fail();
  } else {
    const peers = [...new Set([...headers[0].querySelectorAll('[data-peer-id]')].map(element => element.getAttribute('data-peer-id')))];
    if (peers.some(peer => peer !== actualPeer) || headers[0].querySelector('.topic-header-icon')) return fail();
  }
  const lists = [...document.querySelectorAll('#MiddleColumn .MessageList')].filter(visible);
  if (lists.length !== 1 || lists[0].getAttribute('data-list-key') !== `${actualPeer}_${root}_thread`) return fail();
  const list = lists[0];
  const rows = [...list.querySelectorAll('.Message[data-message-id]')].filter(element => visible(element) && element.closest('.MessageList') === list
    && !(scope.thread && (element.classList.contains('is-thread-top') || element.getAttribute('data-message-id') === root)));
  const rowIds = rows.map(element => element.getAttribute('data-message-id'));
  if (rowIds.some(id => !/^[1-9]\d{0,19}$/.test(id)) || new Set(rowIds).size !== rows.length) return { error: 'CLIENT_CHANGED' };
  if (phase === 'scroll') {
    list.scrollTop = direction === 'before' ? 0 : list.scrollHeight;
    list.dispatchEvent(new Event('scroll', { bubbles: true }));
  }
  if (phase !== 'read') return { ids: rowIds.sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1), newestByUi: !!list.querySelector('.list-bottom-marker') };
  const messages = [];
  for (const id of ids) {
    const row = rows.find(element => element.getAttribute('data-message-id') === id);
    if (!row) return fail();
    const grouped = [...row.querySelectorAll('[data-last-message-id]')].map(element => element.getAttribute('data-last-message-id'));
    if (grouped.some(value => !/^[1-9]\d{0,19}$/.test(value))) return { error: 'CLIENT_CHANGED' };
    const last = grouped.sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1).at(-1);
    if (last && last !== id) {
      messages.push({ id, text: '', nonTextOnly: true, omittedReason: 'ALBUM', lastGroupedMessageId: last, attachments: [] });
      continue;
    }
    const content = [...row.querySelectorAll('.text-content')].find(element => element.closest('.Message') === row && !element.closest('.EmbeddedMessage, .WebPage'));
    let text = '';
    if (content) {
      const copy = content.cloneNode(true);
      for (const extra of copy.querySelectorAll('.MessageMeta, .message-time, .Reactions, .EmbeddedMessage')) extra.remove();
      for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
      text = (copy.textContent ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
    }
    const time = row.querySelector('.message-time');
    messages.push({ id, text: text.slice(0, 65_536), textTruncated: text.length > 65_536, nonTextOnly: !text,
      displayTime: (time?.getAttribute('title') || time?.textContent || '').slice(0, 256), outgoing: row.classList.contains('own'), attachments: [] });
  }
  return { messages };
}

// ForumPanel.tsx renders TopicListHeader beside its virtualized chat-list;
// Topic.tsx exposes only a numeric native routing href and .fullName. Never
// inspect preview/subtitle nodes, account-global lists, or foreign-parent links.
function inspectTopics({ chatId, phase = 'read', expectedName }) {
  const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  if (location.origin !== 'https://web.telegram.org' || location.pathname !== '/a/' || location.hash !== '#' + chatId) return { error: 'READ_TARGET_CHANGED' };
  const headers = [...document.querySelectorAll('#MiddleColumn .MiddleHeader .chat-info-wrapper')].filter(visible);
  if (headers.length !== 1) return null;
  const peers = [...new Set([...headers[0].querySelectorAll('[data-peer-id]')].map(element => element.getAttribute('data-peer-id')))];
  if (peers.length !== 1 || peers[0] !== chatId || headers[0].querySelector('.topic-header-icon')) return { error: 'READ_TARGET_CHANGED' };
  const name = headers[0].querySelector('.title, .fullName')?.textContent?.trim().slice(0, 256);
  if (!name || (expectedName && name !== expectedName)) return { error: 'READ_TARGET_CHANGED' };
  if (phase === 'bind') return { name };
  const topicHeaders = [...document.querySelectorAll('#TopicListHeader')].filter(visible);
  if (topicHeaders.length !== 1) return { available: false, name };
  const topicHeader = topicHeaders[0];
  const parentTitle = topicHeader.querySelector('.ChatInfo .fullName');
  if (!parentTitle || parentTitle.textContent.trim().slice(0, 256) !== name) return { error: 'READ_TARGET_CHANGED' };
  const lists = [...topicHeader.parentElement.querySelectorAll(':scope > .chat-list.custom-scroll')].filter(visible);
  if (lists.length !== 1) return { available: false, name };
  const list = lists[0], topics = [];
  for (const link of list.querySelectorAll('.ListItem.chat-item-clickable > a.ListItem-button[href]')) {
    if (!visible(link)) continue;
    const match = /^#(-?[1-9]\d{0,19})_([1-9]\d{0,19})$/.exec(link.getAttribute('href'));
    if (!match || match[1] !== chatId) continue;
    const labels = [...link.querySelectorAll('.title .fullName')].filter(visible);
    if (labels.length !== 1) continue;
    const name = labels[0].textContent.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 256);
    if (name) topics.push({ id: match[2], name });
  }
  if (phase === 'scroll') {
    list.scrollTop = Math.min(list.scrollHeight, list.scrollTop + Math.max(1, list.clientHeight * 0.8));
    list.dispatchEvent(new Event('scroll', { bubbles: true }));
  }
  return { available: true, name, topics, atBottom: list.scrollHeight - list.scrollTop - list.clientHeight <= 12 };
}

export function createConversationReader(page, { baseReader, allowedChatIds = [], timeoutMs = 15_000 } = {}) {
  const allowed = new Set(allowedChatIds);
  let busy = false;
  function authorize(chatId) {
    if (typeof chatId !== 'string' || !peerPattern.test(chatId)) throw new Error('INVALID_READ_REQUEST');
    if (!allowed.has(chatId)) throw new Error('ACCESS_DENIED');
  }
  function messageId(value) {
    if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('INVALID_READ_REQUEST');
  }
  async function inspect(args) {
    const result = await page.evaluate(inspectConversation, args);
    if (!result || result.error) throw new Error(result?.error ?? 'READ_TARGET_CHANGED');
    return result;
  }
  async function capture(scope, ids) {
    const read = await inspect({ scope, phase: 'read', ids });
    let result = { ...envelope(scope.chatId), ...(scope.thread ? { thread: scope.thread, postId: scope.postId } : {}),
      ...(scope.topicId ? { topic: { id: scope.topicId, name: scope.topicName } } : {}), messages: read.messages };
    if (!scope.topicId) result = await enrichMedia(page, result);
    try { result = await enrichMessageMetadata(page, result); }
    catch (error) {
      // Older shared normalizers cannot inspect avatar-less topic/discussion
      // headers. Independently reverify this exact scope and retain UNKNOWN;
      // never turn absence of metadata support into invented timestamps/IDs.
      if ((!scope.topicId && !scope.thread) || error.message !== 'READ_TARGET_CHANGED') throw error;
      await inspect({ scope });
      result.messages = result.messages.map(message => ({ ...message, ...normalizeMessageEvidence(scope.topicId ? { topic: { id: scope.topicId, name: scope.topicName } } : {}) }));
    }
    await inspect({ scope });
    return result.messages;
  }
  async function navigate(hash, deadline) {
    const remaining = () => Math.max(1, deadline - Date.now());
    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: remaining() });
    await page.goto('https://web.telegram.org/a/#' + hash, { waitUntil: 'domcontentloaded', timeout: remaining() });
  }
  async function discover(chatId, deadline) {
    await navigate(chatId, deadline);
    let bound;
    while (Date.now() < deadline) {
      bound = await page.evaluate(inspectTopics, { chatId, phase: 'bind' });
      if (bound?.error) throw new Error(bound.error);
      if (bound?.name) break;
      await delay(100);
    }
    if (!bound?.name) throw new Error('TARGET_NOT_VERIFIED');
    const topics = new Map();
    let last = '', unchangedAt = Date.now(), available = false;
    while (Date.now() < deadline) {
      authorize(chatId);
      const state = await page.evaluate(inspectTopics, { chatId, expectedName: bound.name });
      if (state?.error || !state) throw new Error(state?.error ?? 'READ_TARGET_CHANGED');
      if (!state.available) break;
      available = true;
      for (const topic of state.topics) {
        if (topics.has(topic.id) && topics.get(topic.id).name !== topic.name) throw new Error('READ_TARGET_CHANGED');
        topics.set(topic.id, topic);
      }
      const signature = JSON.stringify(state.topics);
      if (signature !== last) { last = signature; unchangedAt = Date.now(); }
      if (state.atBottom || topics.size >= 200 || Date.now() - unchangedAt >= 500) break;
      const scrolled = await page.evaluate(inspectTopics, { chatId, expectedName: bound.name, phase: 'scroll' });
      if (!scrolled || scrolled.error) throw new Error(scrolled?.error ?? 'READ_TARGET_CHANGED');
      await delay(100);
    }
    authorize(chatId);
    const checked = await page.evaluate(inspectTopics, { chatId, expectedName: bound.name });
    if (!checked || checked.error) throw new Error(checked?.error ?? 'READ_TARGET_CHANGED');
    return { ...envelope(chatId), isForum: available ? true : null, topics: [...topics.values()], completeByUi: false,
      coverage: { status: available ? 'partial' : 'unavailable', stopReason: available ? 'TOPIC_LIST_NOT_PROVEN_EXHAUSTIVE' : 'TOPIC_UI_UNAVAILABLE' } };
  }
  async function openTopic(chatId, topicId, deadline, anchorId) {
    const discovered = await discover(chatId, deadline);
    const topic = discovered.topics.find(topic => topic.id === topicId);
    if (!topic) throw new Error('TOPIC_UNAVAILABLE');
    const scope = { chatId, topicId, topicName: topic.name };
    const hash = anchorId && BigInt(chatId) < -1000000000000n && /^[1-9]\d{0,9}$/.test(anchorId)
      ? '?tgaddr=' + encodeURIComponent(`tg://privatepost?channel=${-BigInt(chatId) - 1000000000000n}&post=${anchorId}&thread=${topicId}`)
      : `${chatId}_${topicId}`;
    await navigate(hash, deadline);
    try {
      const handle = await page.waitForFunction(inspectConversation, { scope, phase: 'bind' }, { timeout: Math.max(1, deadline - Date.now()) });
      try { const state = await handle.jsonValue(); if (state.error) throw new Error(state.error); } finally { await handle.dispose(); }
    } catch { throw new Error('TOPIC_UNAVAILABLE'); }
    await inspect({ scope });
    return scope;
  }
  return {
    async topicHistory({ chatId, topicId, before, limit = 50 } = {}) {
      authorize(chatId); messageId(topicId);
      if (before !== undefined) messageId(before);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_READ_REQUEST');
      if (busy) throw new Error('READER_BUSY');
      busy = true;
      try {
        const deadline = Date.now() + timeoutMs, scope = await openTopic(chatId, topicId, deadline);
        const observed = new Map();
        let state = await inspect({ scope }), last = '', unchangedAt = Date.now(), settled = 0;
        // The numeric topic route normally opens its newest slice; prove that
        // with the native bottom marker before selecting a history page.
        while (!state.newestByUi && Date.now() < deadline) {
          await inspect({ scope, phase: 'scroll', direction: 'after' });
          await delay(100); state = await inspect({ scope });
          const signature = JSON.stringify(state.ids);
          if (signature !== last) { last = signature; unchangedAt = Date.now(); }
          if (Date.now() - unchangedAt >= 750) break;
        }
        const newestConfirmed = state.newestByUi;
        last = ''; unchangedAt = Date.now();
        while (Date.now() < deadline) {
          const eligible = state.ids.filter(id => !before || BigInt(id) < BigInt(before)).slice(-limit);
          if (eligible.length) for (const message of await capture(scope, eligible)) observed.set(message.id, message);
          const ordered = [...observed.values()].sort(compare).slice(-limit);
          observed.clear(); for (const message of ordered) observed.set(message.id, message);
          const signature = JSON.stringify(state.ids);
          if (signature !== last) { last = signature; unchangedAt = Date.now(); settled = 0; } else settled++;
          if ((observed.size >= limit && settled >= 1) || Date.now() - unchangedAt >= 750) break;
          if (observed.size < limit) await inspect({ scope, phase: 'scroll', direction: 'before' });
          await delay(100); state = await inspect({ scope });
        }
        authorize(chatId); await inspect({ scope });
        const messages = [...observed.values()].sort(compare);
        return { ...envelope(chatId), topicId, messages, requestedLimit: limit, nextBefore: messages[0]?.id ?? null, historyComplete: false,
          coverage: { status: 'partial', stopReason: !newestConfirmed ? 'LATEST_NOT_CONFIRMED' : messages.length >= limit ? 'PAGE_LIMIT' : Date.now() >= deadline ? 'TIMEOUT' : 'NO_PROGRESS',
            unknownTimestamps: messages.filter(message => !message.timestamp).length, topicScopeVerifiedByUi: true, attachmentReferences: 'unavailable' } };
      } finally { busy = false; }
    },
    async topics({ chatId } = {}) {
      authorize(chatId);
      if (busy) throw new Error('READER_BUSY');
      busy = true;
      try { return await discover(chatId, Date.now() + timeoutMs); }
      finally { busy = false; }
    },
    async context({ chatId, messageId: anchorId, postId, topicId, window, includeReplyTo = true } = {}) {
      authorize(chatId); messageId(anchorId);
      if (postId !== undefined) messageId(postId);
      if (topicId !== undefined) messageId(topicId);
      if ((postId !== undefined && topicId !== undefined) || typeof includeReplyTo !== 'boolean') throw new Error('INVALID_READ_REQUEST');
      const requested = normalizeWindow(window);
      if (busy) throw new Error('READER_BUSY');
      busy = true;
      try {
        const deadline = Date.now() + timeoutMs, observed = new Map();
        let exact, scope;
        if (topicId) scope = await openTopic(chatId, topicId, deadline, anchorId);
        else {
          exact = await baseReader.message({ chatId, messageId: anchorId, ...(postId ? { postId } : {}) });
          if (exact?.peerId !== chatId || exact.message?.id !== anchorId || exact.source !== 'official-web-dom' || exact.contentIsUntrusted !== true
            || (postId ? exact.postId !== postId || exact.thread?.openedFromVerifiedPost !== true : !!exact.thread)) throw new Error('READ_TARGET_CHANGED');
          scope = { chatId, ...(postId ? { postId, thread: exact.thread } : {}) };
        }
        const timeMode = requested.beforeMinutes !== undefined;
        const budgets = timeMode ? { before: 100, after: 100 } : requested;
        let state = await inspect({ scope });
        if (!state.ids.includes(anchorId)) throw new Error('MESSAGE_UNAVAILABLE');
        async function observe(current) {
          const ids = (budgets.before ? current.ids.filter(id => BigInt(id) < BigInt(anchorId)).slice(-budgets.before) : [])
            .concat(current.ids.includes(anchorId) ? [anchorId] : [], current.ids.filter(id => BigInt(id) > BigInt(anchorId)).slice(0, budgets.after));
          if (ids.length) for (const message of await capture(scope, ids)) observed.set(message.id, message);
          const ordered = [...observed.values()].sort(compare);
          const keep = (budgets.before ? ordered.filter(message => BigInt(message.id) < BigInt(anchorId)).slice(-budgets.before) : [])
            .concat(observed.get(anchorId) ? [observed.get(anchorId)] : [], ordered.filter(message => BigInt(message.id) > BigInt(anchorId)).slice(0, budgets.after));
          observed.clear(); for (const message of keep) observed.set(message.id, message);
        }
        await observe(state);
        const anchor = observed.get(anchorId), anchorTime = anchor.timestamp ? Date.parse(anchor.timestamp) : NaN;
        const bounds = timeMode && Number.isFinite(anchorTime) ? { since: anchorTime - requested.beforeMinutes * 60_000, until: anchorTime + requested.afterMinutes * 60_000 } : null;
        const side = direction => [...observed.values()].filter(message => direction === 'before' ? BigInt(message.id) < BigInt(anchorId) : BigInt(message.id) > BigInt(anchorId)).sort(compare);
        function sufficient(direction) {
          if (!timeMode) return side(direction).length >= requested[direction];
          if (!bounds) return true;
          // Boundary timestamps are inclusive; a same-second sibling can still
          // lie beyond this rendered slice. Cross strictly outside the window
          // (or prove the native newest boundary), never assume equality ends it.
          return side(direction).some(message => message.timestamp && (direction === 'before' ? Date.parse(message.timestamp) < bounds.since : Date.parse(message.timestamp) > bounds.until));
        }
        let stopped = timeMode && !bounds ? 'UNKNOWN_ANCHOR_TIMESTAMP' : null;
        for (const direction of ['before', 'after']) {
          let previous = JSON.stringify(state.ids), unchangedAt = Date.now();
          while (!sufficient(direction) && !(direction === 'after' && state.newestByUi) && Date.now() < deadline) {
            if (side(direction).length >= budgets[direction]) { stopped = 'MESSAGE_BUDGET'; break; }
            await inspect({ scope, phase: 'scroll', direction });
            await delay(Math.min(100, Math.max(1, deadline - Date.now())));
            state = await inspect({ scope });
            const signature = JSON.stringify(state.ids);
            if (signature !== previous) { previous = signature; unchangedAt = Date.now(); }
            await observe(state);
            if (Date.now() - unchangedAt >= 750) { stopped = 'NO_PROGRESS'; break; }
          }
        }
        await delay(100); authorize(chatId); await inspect({ scope });
        const observedMessages = [...observed.values()].sort(compare);
        const unknownTimestamps = timeMode ? observedMessages.filter(message => !message.timestamp).length : 0;
        const monotonic = !timeMode || observedMessages.filter(message => message.timestamp).every((message, i, all) => !i || Date.parse(all[i - 1].timestamp) <= Date.parse(message.timestamp));
        const messages = !timeMode ? observedMessages : !bounds ? [anchor] : observedMessages.filter(message => !message.timestamp || (Date.parse(message.timestamp) >= bounds.since && Date.parse(message.timestamp) <= bounds.until))
          .map(message => !message.timestamp ? { ...message, windowMatch: 'unknown' } : message);
        const complete = sufficient('before') && (sufficient('after') || state.newestByUi) && (!timeMode || (!!bounds && !unknownTimestamps && monotonic));
        const beforeCount = messages.filter(message => BigInt(message.id) < BigInt(anchorId)).length;
        const afterCount = messages.filter(message => BigInt(message.id) > BigInt(anchorId)).length;
        return { ...envelope(chatId), anchor, messages, ...(postId ? { postId, thread: exact.thread } : {}), ...(topicId ? { topicId } : {}),
          coverage: { status: complete ? 'complete' : 'partial', requestedWindow: requested, beforeCount, afterCount,
            ...(timeMode ? { unknownTimestamps, ...(bounds ? { since: new Date(bounds.since).toISOString(), until: new Date(bounds.until).toISOString() } : {}) } : {}),
            stopReason: complete ? timeMode ? 'TIME_WINDOW' : 'COUNT_WINDOW' : !monotonic ? 'NON_MONOTONIC_TIMESTAMPS' : unknownTimestamps ? 'UNKNOWN_TIMESTAMPS' : Date.now() >= deadline ? 'TIMEOUT' : stopped ?? 'RENDERED_SLICE_ONLY',
            attachmentReferences: topicId ? 'unavailable' : 'rendered-dom',
            replyTo: includeReplyTo ? 'unavailable' : 'not-requested', ...(includeReplyTo ? { replyToReason: 'NO_VERIFIED_SAME_SCOPE_REPLY_TARGET' } : {}) } };
      } finally { busy = false; }
    },
  };
}
