// Narrow official-Web-A DOM reader. No sends, composer input, uploads or raw JS tool.
// Selectors derived from Ajaxy/telegram-tt f67a40879a7d78c2683ec5a296cf55bc22417d56.
// A matching live UI is required; source inspection is not a production API guarantee.
import { enrichMedia, inspectMediaDom } from './media-transfer.mjs';
import { enrichMessageMetadata, normalizeMessageEvidence } from './message-metadata.mjs';

const errors = new Set(['INVALID_READ_REQUEST', 'ACCESS_DENIED', 'READER_BUSY', 'TARGET_NOT_VERIFIED', 'READ_TARGET_CHANGED', 'LATEST_NOT_CONFIRMED', 'UNSUPPORTED_ALBUM', 'CLIENT_CHANGED', 'COMMENTS_UNAVAILABLE', 'HISTORY_NOT_LOADED', 'SEARCH_NOT_READY', 'SEARCH_SCOPE_CHANGED', 'MESSAGE_UNAVAILABLE', 'ATTACHMENT_UNAVAILABLE', 'MEDIA_UNSUPPORTED', 'DOWNLOAD_TOO_LARGE', 'ATTACHMENT_SIZE_UNKNOWN']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function normalizePublicUsername(value) {
  if (typeof value !== 'string' || value.length > 256) throw new Error('INVALID_READ_REQUEST');
  if (value.startsWith('https://')) {
    const match = /^https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/.exec(value);
    if (!match) throw new Error('INVALID_READ_REQUEST');
    value = match[1];
  }
  if (!/^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value)) throw new Error('INVALID_READ_REQUEST');
  return value.replace(/^@/, '').toLowerCase();
}
const normalizeUsername = normalizePublicUsername;

function normalizeChatId(value) {
  if (typeof value !== 'string' || !/^-?[1-9]\d{0,19}$/.test(value)) throw new Error('INVALID_READ_REQUEST');
  return value;
}

// This function is serialized into the browser. Only the final read phase accesses
// message text. Numeric requests bind the exact header + hash; username bootstrap
// additionally verifies the matching profile before resolving an immutable ID.
function inspectDom({ phase, username, peerId, limit, postId, before, requestedPostId, requestedMessageId }) {
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  if (location.origin !== 'https://web.telegram.org' || location.pathname !== '/a/') return null;
  const match = /^#(-?[1-9]\d{0,19})$/.exec(location.hash);
  if (!match || (peerId && match[1] !== peerId)) return null;
  const headers = [...document.querySelectorAll('#MiddleColumn .MiddleHeader .chat-info-wrapper')].filter(visible);
  if (headers.length !== 1) return null;
  const peers = [...new Set([...headers[0].querySelectorAll('[data-peer-id]')].map(el => el.getAttribute('data-peer-id')))];
  if (peers.length !== 1 || peers[0] !== match[1]) return null;
  if (phase === 'header') return { peerId: match[1] };
  if (username) {
    const titles = [...document.querySelectorAll('#RightColumn .ChatExtra .ListItem:has(.icon-mention-filled) .title, #RightColumn .ChatExtra .ListItem:has(.icon-link) .title')].filter(visible);
    const verified = titles.some(el => {
      const value = el.textContent.trim().toLowerCase();
      return value === '@' + username || value === 't.me/' + username || value === 'https://t.me/' + username;
    });
    // A profile may show a group sender rather than the selected conversation.
    const profilePeers = [...new Set([...document.querySelectorAll('#RightColumn .ProfileInfo [data-peer-id]')].filter(visible).map(el => el.getAttribute('data-peer-id')))];
    if (!verified || profilePeers.length !== 1 || profilePeers[0] !== match[1]) return null;
  } else if (!peerId) return null;
  // Read the native title only after exact peer verification. Never sidebar,
  // user-defined aliases, profile bios, phone numbers or message previews.
  const title = headers[0].querySelector('.title');
  const displayName = title ? title.textContent.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 256) : null;
  if (phase === 'metadata') return displayName ? { chatId: match[1], displayName } : null;
  if (phase === 'search-open') {
    const buttons = [...document.querySelectorAll('#MiddleColumn .MiddleHeader .header-tools button:has(.icon-search)')].filter(visible);
    if (buttons.length !== 1) return { error: 'CLIENT_CHANGED' };
    // Web A's desktop Button invokes fast-click on mousedown, not click.
    buttons[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    return { peerId: match[1], displayName };
  }
  const lists = [...document.querySelectorAll('#MiddleColumn .MessageList')].filter(visible);
  if (lists.length !== 1) return { error: 'CLIENT_CHANGED' };
  const list = lists[0];
  if (phase === 'scroll' || (phase === 'comment-candidate' && !requestedPostId)) list.scrollTop = list.scrollHeight;
  const nodes = [...list.querySelectorAll('.Message[data-message-id]')].filter(visible);
  const valid = nodes.every(el => /^[1-9]\d*$/.test(el.getAttribute('data-message-id')));
  if (!valid || new Set(nodes.map(el => el.getAttribute('data-message-id'))).size !== nodes.length) return { error: 'CLIENT_CHANGED' };
  nodes.sort((a, b) => BigInt(a.getAttribute('data-message-id')) < BigInt(b.getAttribute('data-message-id')) ? -1 : 1);
  const selected = nodes.slice(-limit);
  const newest = !!list.querySelector('.list-bottom-marker');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 12;
  const capture = el => {
    const content = el.querySelector('.text-content');
    let text = '';
    if (content) {
      const copy = content.cloneNode(true);
      for (const extra of copy.querySelectorAll('.MessageMeta, .message-time, .Reactions, .EmbeddedMessage')) extra.remove();
      for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
      text = (copy.textContent ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
    }
    const time = el.querySelector('.message-time');
    const textLimit = 65_536;
    return { id: el.getAttribute('data-message-id'), text: text.slice(0, textLimit), textTruncated: text.length > textLimit, nonTextOnly: !text, displayTime: (time?.getAttribute('title') || time?.textContent || '').slice(0, 256), outgoing: el.classList.contains('own'), attachments: [] };
  };
  if (phase.startsWith('message-')) {
    if (list.getAttribute('data-list-key') !== `${match[1]}_-1_thread`) return { error: 'CLIENT_CHANGED' };
    const target = nodes.find(el => el.getAttribute('data-message-id') === requestedMessageId || [...el.querySelectorAll('[id^="album-media-message-"]')].some(member => member.id === 'album-media-message-' + requestedMessageId));
    if (phase === 'message-up') list.scrollTop = 0;
    if (phase === 'message-rearm') list.scrollTop = Math.min(list.scrollHeight - list.clientHeight, Math.max(600, list.clientHeight * 2));
    if (phase !== 'message-read') return { found: !!target, ids: nodes.map(el => el.getAttribute('data-message-id')) };
    if (!target) return { error: 'MESSAGE_UNAVAILABLE' };
    return { peerId: match[1], displayName, source: 'official-web-dom', contentIsUntrusted: true, message: { ...capture(target), id: requestedMessageId } };
  }
  const isAlbum = el => [...el.querySelectorAll('[data-last-message-id]')].some(marker => marker.getAttribute('data-last-message-id') !== el.getAttribute('data-message-id'));
  if (phase.startsWith('history-')) {
    if (list.getAttribute('data-list-key') !== `${match[1]}_-1_thread`) return { error: 'CLIENT_CHANGED' };
    const older = before ? nodes.filter(el => BigInt(el.getAttribute('data-message-id')) < BigInt(before)) : nodes;
    const batch = older.slice(-limit);
    const ids = batch.map(el => el.getAttribute('data-message-id'));
    if (phase === 'history-up') list.scrollTop = 0;
    if (phase === 'history-rearm') list.scrollTop = Math.min(list.scrollHeight - list.clientHeight, Math.max(600, list.clientHeight * 2));
    if (phase !== 'history-read') return { ids, newest, atBottom, allIds: nodes.map(el => el.getAttribute('data-message-id')) };
    const messages = batch.map(el => {
      if (!isAlbum(el)) return capture(el);
      const lastIds = [...el.querySelectorAll('[data-last-message-id]')].map(x => x.getAttribute('data-last-message-id'));
      if (lastIds.some(id => !/^[1-9]\d{0,19}$/.test(id))) return null;
      const last = lastIds.sort((a,b) => BigInt(a) < BigInt(b) ? -1 : 1).at(-1);
      return { id: el.getAttribute('data-message-id'), text: '', nonTextOnly: true, omittedReason: 'ALBUM', lastGroupedMessageId: last };
    });
    if (messages.some(m => !m)) return { error: 'CLIENT_CHANGED' };
    return { peerId: match[1], displayName, source: 'official-web-dom', contentIsUntrusted: true, requestedLimit: limit,
      messages, nextBefore: ids[0] ?? null, historyComplete: false };
  }
  if (phase === 'comment-candidate' || phase === 'open-comments') {
    const eligible = nodes.filter(el => el.querySelector('.CommentButton:not(.disabled)') && !isAlbum(el));
    const withComments = eligible.filter(el => el.querySelector('.CommentButton').getAttribute('data-cnt') !== '0');
    if (requestedPostId && list.getAttribute('data-list-key') !== `${match[1]}_-1_thread`) return { error: 'CLIENT_CHANGED' };
    const candidate = requestedPostId ? eligible.find(el => el.getAttribute('data-message-id') === requestedPostId) : (withComments.length ? withComments : eligible).at(-1);
    if (phase === 'comment-candidate') return { peerId: match[1], newest, atBottom, candidateId: candidate?.getAttribute('data-message-id') ?? null };
    if (!candidate || candidate.getAttribute('data-message-id') !== postId) return { error: 'READ_TARGET_CHANGED' };
    if (!requestedPostId && (!newest || !atBottom)) return { error: 'LATEST_NOT_CONFIRMED' };
    const button = candidate.querySelector('.CommentButton:not(.disabled)');
    const post = capture(candidate);
    const emptyByUi = button.getAttribute('data-cnt') === '0';
    // Synchronous, scoped activation after the same DOM identity checks. Never
    // click a first search result, a group history link or any composer control.
    if (!emptyByUi) button.click();
    return { post, emptyByUi, displayName };
  }
  if (phase !== 'read') return { peerId: match[1], newest, atBottom, count: nodes.length, selectedIds: selected.map(el => el.getAttribute('data-message-id')) };
  if (!newest || !atBottom || !selected.length) return { error: 'LATEST_NOT_CONFIRMED' };
  const messages = selected.map(el => {
    if (!isAlbum(el)) return capture(el);
    const ids = [...el.querySelectorAll('[data-last-message-id]')].map(marker => marker.getAttribute('data-last-message-id'));
    if (ids.some(id => !/^[1-9]\d{0,19}$/.test(id))) return null;
    return { id: el.getAttribute('data-message-id'), text: '', nonTextOnly: true, omittedReason: 'ALBUM', lastGroupedMessageId: ids.sort((a,b) => BigInt(a) < BigInt(b) ? -1 : 1).at(-1) };
  });
  if (messages.some(message => !message)) return { error: 'CLIENT_CHANGED' };
  return { username, peerId: match[1], displayName, source: 'official-web-dom', newestSliceConfirmedByUi: true, contentIsUntrusted: true, requestedLimit: limit, messages };
}

// The thread is authorized only by activating the verified post's own comments
// control. Its peer is NOT added to the ordinary-chat allowlist. Both the hash
// and Web A's list identity must remain bound to this one thread on every phase.
function inspectCommentsDom({ phase, threadPeerId, threadRootId, limit, requestedMessageId }) {
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  if (location.origin !== 'https://web.telegram.org' || location.pathname !== '/a/') return null;
  const match = /^#(-?[1-9]\d{0,19})_([1-9]\d{0,19})$/.exec(location.hash);
  if (!match || (threadPeerId && match[1] !== threadPeerId) || (threadRootId && match[2] !== threadRootId)) return null;
  const lists = [...document.querySelectorAll('#MiddleColumn .MessageList')].filter(visible);
  if (lists.length !== 1 || lists[0].getAttribute('data-list-key') !== `${match[1]}_${match[2]}_thread`) return null;
  const list = lists[0];
  if (phase === 'bind') return { threadPeerId: match[1], threadRootId: match[2] };
  if (phase === 'metadata-proof') {
    const headers = [...document.querySelectorAll('#MiddleColumn .MiddleHeader')].filter(visible);
    return { avatarlessHeader: headers.length === 1 && headers[0].querySelectorAll('.Avatar[data-peer-id]').length === 0 };
  }
  if (phase === 'scroll') list.scrollTop = list.scrollHeight;
  const nodes = [...list.querySelectorAll('.Message[data-message-id]')].filter(el => visible(el) && !el.classList.contains('is-thread-top') && el.getAttribute('data-message-id') !== match[2]);
  if (nodes.some(el => !/^[1-9]\d*$/.test(el.getAttribute('data-message-id'))) || new Set(nodes.map(el => el.getAttribute('data-message-id'))).size !== nodes.length) return { error: 'CLIENT_CHANGED' };
  nodes.sort((a, b) => BigInt(a.getAttribute('data-message-id')) < BigInt(b.getAttribute('data-message-id')) ? -1 : 1);
  const exact = phase.startsWith('message-');
  const selected = exact ? nodes.filter(el => el.getAttribute('data-message-id') === requestedMessageId || !!el.querySelector(`[id="album-media-message-${requestedMessageId}"]`)) : nodes.slice(-limit);
  const newest = !!list.querySelector('.list-bottom-marker');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 12;
  if (phase === 'message-up') list.scrollTop = 0;
  if (phase === 'message-rearm') list.scrollTop = Math.min(list.scrollHeight - list.clientHeight, Math.max(600, list.clientHeight * 2));
  if (exact && phase !== 'message-read') return { found: selected.length === 1, ids: nodes.map(el => el.getAttribute('data-message-id')) };
  if (!exact && phase !== 'read') return { newest, atBottom, selectedIds: selected.map(el => el.getAttribute('data-message-id')) };
  if (exact && selected.length !== 1) return { error: 'MESSAGE_UNAVAILABLE' };
  if (!exact && (!newest || !atBottom)) return { error: 'LATEST_NOT_CONFIRMED' };
  return { comments: selected.map(el => {
    if (!exact) {
      const last = [...el.querySelectorAll('[data-last-message-id]')].map(marker => marker.getAttribute('data-last-message-id')).filter(id => /^[1-9]\d{0,19}$/.test(id)).sort((a,b) => BigInt(a) < BigInt(b) ? -1 : 1).at(-1);
      if (last && last !== el.getAttribute('data-message-id')) return { id: el.getAttribute('data-message-id'), text: '', nonTextOnly: true, omittedReason: 'ALBUM', lastGroupedMessageId: last };
    }
    const content = el.querySelector('.text-content');
    let text = '';
    if (content) {
      const copy = content.cloneNode(true);
      for (const extra of copy.querySelectorAll('.MessageMeta, .message-time, .Reactions, .EmbeddedMessage')) extra.remove();
      for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
      text = (copy.textContent ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
    }
    const time = el.querySelector('.message-time');
    const textLimit = 65_536;
    return { id: exact ? requestedMessageId : el.getAttribute('data-message-id'), text: text.slice(0, textLimit), textTruncated: text.length > textLimit, nonTextOnly: !text, displayTime: (time?.getAttribute('title') || time?.textContent || '').slice(0, 256), outgoing: el.classList.contains('own') };
  }) };
}

// Native middle-column search only: never the global/sidebar search. The header
// avatar binds the search to the selected peer; member suggestions lack metadata
// and are excluded. Telegram returns truncated previews, not full message bodies.
function inspectSearch({ peerId, query, limit, checkOnly = false }) {
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  if (location.origin !== 'https://web.telegram.org' || location.pathname !== '/a/' || location.hash !== '#' + peerId) return { error: 'SEARCH_SCOPE_CHANGED' };
  const wrappers = [...document.querySelectorAll('#MiddleColumn .MiddleHeader .chat-info-wrapper')].filter(visible);
  if (wrappers.length !== 1) return null;
  const peers = [...new Set([...wrappers[0].querySelectorAll('[data-peer-id]')].map(el => el.getAttribute('data-peer-id')))];
  if (peers.length !== 1 || peers[0] !== peerId) return { error: 'SEARCH_SCOPE_CHANGED' };
  const search = document.querySelector('#MiddleSearch');
  if (!visible(search)) return null;
  const scope = [...search.querySelectorAll('[data-peer-id]')].filter(el => !el.closest('.SearchInput, .MiddleSearchResult'));
  if (scope.length !== 1 || scope[0].getAttribute('data-peer-id') !== peerId) return { error: 'SEARCH_SCOPE_CHANGED' };
  const inputs = [...search.querySelectorAll('.SearchInput input[type="text"]')].filter(visible);
  if (inputs.length !== 1) return { error: 'CLIENT_CHANGED' };
  if (checkOnly) return { ready: true };
  if (inputs[0].value !== query || [...search.querySelectorAll('.Loading')].some(visible)) return null;
  const rows = [...search.querySelectorAll('.MiddleSearchResult')].filter(el => visible(el) && el.querySelector('.LastMessageMeta'));
  // CSS-module names are hashed in production. The native no-results marker is
  // a direct span in the one search-results scroll container, not arbitrary text.
  const containers = [...search.querySelectorAll('.custom-scroll')].filter(visible);
  const empty = !rows.length && containers.length === 1 && containers[0].children.length === 1
    && containers[0].firstElementChild.tagName === 'SPAN' && visible(containers[0].firstElementChild);
  if (!rows.length && !empty) return null;
  const matches = rows.slice(0, limit).map(row => {
    const metas = row.querySelectorAll('.LastMessageMeta');
    const top = metas.length === 1 ? metas[0].parentElement : null;
    const subtitle = top?.nextElementSibling;
    if (!top || !row.contains(top) || !subtitle || subtitle.tagName !== 'DIV' || subtitle.getAttribute('dir') !== 'auto'
      || subtitle.nextElementSibling || top.previousElementSibling || top.parentElement.children.length !== 2) return null;
    return { preview: subtitle.textContent.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, 4096), displayTime: (row.querySelector('.LastMessageMeta .time')?.textContent || '').trim().slice(0, 256) };
  });
  if (matches.some(m => !m)) return { error: 'CLIENT_CHANGED' };
  return { peerId, source: 'official-web-search-dom', query, matches, scopeVerifiedByUi: true, resultsComplete: false, emptyByUi: empty, contentIsUntrusted: true };
}

// Only fixed structural booleans/counts: never titles, IDs, messages, URLs or
// native exception strings. Useful when a hosted client changes its DOM.
function safeUiDiagnostic({ username }) {
  const middle = document.querySelector('#MiddleColumn');
  const header = middle?.querySelector('.MiddleHeader');
  const wrapper = header?.querySelector('.chat-info-wrapper');
  const peer = /^#(-?[1-9]\d{0,19})$/.exec(location.hash)?.[1];
  const profilePeers = [...document.querySelectorAll('#RightColumn .ProfileInfo [data-peer-id]')].map(el => el.getAttribute('data-peer-id'));
  const titles = [...document.querySelectorAll('#RightColumn .ChatExtra .ListItem .title')];
  return {
    officialOrigin: location.origin === 'https://web.telegram.org', expectedPath: location.pathname === '/a/',
    leftColumnPresent: !!document.querySelector('#LeftColumn'), middleColumnPresent: !!middle,
    numericPeerHash: !!peer, deepLinkHashStillPresent: location.hash.startsWith('#?tgaddr='),
    middleHeaderPresent: !!header, chatInfoWrapperPresent: !!wrapper,
    headerPeerElementCount: wrapper?.querySelectorAll('[data-peer-id]').length ?? 0,
    profilePanePresent: !!document.querySelector('#RightColumn'), profileInfoPresent: !!document.querySelector('#RightColumn .ProfileInfo'),
    profilePeerElementCount: profilePeers.length, profilePeerMatchesHash: !!peer && profilePeers.length === 1 && profilePeers[0] === peer,
    exactProfileUsernamePresent: titles.some(el => ['@' + username, 't.me/' + username, 'https://t.me/' + username].includes(el.textContent.trim().toLowerCase())),
    messageListCount: middle?.querySelectorAll('.MessageList').length ?? 0,
    bottomMarkerPresent: !!middle?.querySelector('.list-bottom-marker'),
    threadHashPresent: /^#-?[1-9]\d{0,19}_[1-9]\d{0,19}$/.test(location.hash),
    threadListIdentityMatchesHash: [...(middle?.querySelectorAll('.MessageList') ?? [])].some(el => el.getAttribute('data-list-key') === location.hash.slice(1) + '_thread'),
  };
}

export function createChatReader(page, { allowedUsernames = [], allowedChatIds = [], maxMessages = 100, timeoutMs = 45_000 } = {}) {
  if (!Array.isArray(allowedUsernames) || !Array.isArray(allowedChatIds) || !Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 100 || !Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60_000) throw new Error('INVALID_READ_REQUEST');
  const allowed = new Set(allowedUsernames.map(normalizeUsername));
  const allowedIds = new Set(allowedChatIds.map(normalizeChatId));
  const authorize = (username, chatId, limit) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > maxMessages || (username !== undefined && chatId !== undefined)) throw new Error('INVALID_READ_REQUEST');
    if (chatId !== undefined) {
      chatId = normalizeChatId(chatId);
      if (!allowedIds.has(chatId)) throw new Error('ACCESS_DENIED');
    } else {
      username = normalizeUsername(username);
      if (!allowed.has(username)) throw new Error('ACCESS_DENIED');
    }
    return { username, chatId };
  };
  let busy = false;
  const reader = {
    async message({ chatId, messageId, postId } = {}) {
      ({ chatId } = authorize(undefined, chatId, 1));
      if (typeof messageId !== 'string' || !/^[1-9]\d{0,19}$/.test(messageId)) throw new Error('INVALID_READ_REQUEST');
      if (postId !== undefined && (typeof postId !== 'string' || !/^[1-9]\d{0,9}$/.test(postId) || !chatId.startsWith('-100'))) throw new Error('INVALID_READ_REQUEST');
      if (busy) throw new Error('READER_BUSY');
      const scoped = postId === undefined ? null : await reader.comments({ chatId, postId, limit: 1 });
      if (scoped && !scoped.thread?.openedFromVerifiedPost) throw new Error('MESSAGE_UNAVAILABLE');
      if (busy) throw new Error('READER_BUSY');
      busy = true;
      const deadline = Date.now() + timeoutMs;
      const remaining = () => Math.max(1, deadline - Date.now());
      try {
        const hash = BigInt(chatId) < -1000000000000n && /^[1-9]\d{0,9}$/.test(messageId)
          ? '?tgaddr=' + encodeURIComponent(`tg://privatepost?channel=${-BigInt(chatId) - 1000000000000n}&post=${messageId}`) : chatId;
        if (!scoped) {
          await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: remaining() });
          await page.goto('https://web.telegram.org/a/#' + hash, { waitUntil: 'domcontentloaded', timeout: remaining() });
        }
        const args = { peerId: chatId, limit: 1, requestedMessageId: messageId, ...(scoped ? { threadPeerId: scoped.thread.peerId, threadRootId: scoped.thread.rootMessageId } : {}) };
        const inspect = scoped ? inspectCommentsDom : inspectDom;
        if (!scoped) { const handle = await page.waitForFunction(inspectDom, { ...args, phase: 'header' }, { timeout: remaining() }); await handle.dispose(); }
        let previous = '', unchangedSince = Date.now(), rearmed = null;
        while (Date.now() < deadline) {
          const state = await page.evaluate(inspect, { ...args, phase: 'message-find' });
          if (!state) throw new Error('READ_TARGET_CHANGED');
          if (state.error) throw new Error(state.error);
          if (state.found) {
            let result = await page.evaluate(inspect, { ...args, phase: 'message-read' });
            if (!result) throw new Error('READ_TARGET_CHANGED');
            if (result.error) throw new Error(result.error);
            if (scoped) result = { peerId: chatId, source: 'official-web-dom', contentIsUntrusted: true, postId, thread: scoped.thread, message: result.comments[0] };
            const media = await page.evaluate(inspectMediaDom, { phase: 'metadata', chatId, messageIds: [messageId], ...(scoped ? { threadPeerId: scoped.thread.peerId, threadRootId: scoped.thread.rootMessageId } : {}) });
            if (media?.error || !media?.messages?.length) throw new Error(media?.error ?? 'READ_TARGET_CHANGED');
            result.message.attachments = media.messages[0].attachments;
            return result;
          }
          const signature = JSON.stringify(state.ids);
          if (signature !== previous) { previous = signature; unchangedSince = Date.now(); }
          if (Date.now() - unchangedSince > 2000 && rearmed !== signature) {
            // A stable slice is not proof that an exact message is absent.
            // Rearm its native loader once, then respect the operation deadline
            // rather than failing after two seconds of UI replacement/loading.
            const away = await page.evaluate(inspect, { ...args, phase: 'message-rearm' });
            if (!away) throw new Error('READ_TARGET_CHANGED');
            if (away.error) throw new Error(away.error);
            rearmed = signature;
            await delay(Math.min(500, remaining()));
          }
          const moved = await page.evaluate(inspect, { ...args, phase: 'message-up' });
          if (!moved) throw new Error('READ_TARGET_CHANGED');
          if (moved.error) throw new Error(moved.error);
          await delay(Math.min(150, remaining()));
        }
        throw new Error('MESSAGE_UNAVAILABLE');
      } catch (error) { throw new Error(errors.has(error?.message) ? error.message : 'READ_FAILED'); }
      finally { busy = false; }
    },
    async attachment({ chatId, messageId, postId, attachmentIndex, maxBytes = 25 * 1024 * 1024 } = {}) {
      ({ chatId } = authorize(undefined, chatId, 1));
      if (!Number.isInteger(attachmentIndex) || attachmentIndex < 0 || attachmentIndex > 99 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 * 1024) throw new Error('INVALID_READ_REQUEST');
      const exact = await reader.message({ chatId, messageId, postId });
      const descriptor = exact.message.attachments.find(item => item.messageId === messageId && item.index === attachmentIndex);
      if (!descriptor) throw new Error('ATTACHMENT_UNAVAILABLE');
      if (busy) throw new Error('READER_BUSY');
      busy = true;
      const args = { chatId, messageId, attachmentIndex, maxBytes, ...(exact.thread ? { threadPeerId: exact.thread.peerId, threadRootId: exact.thread.rootMessageId } : {}) };
      try {
        let downloadUrl;
        if (descriptor.kind === 'file') {
          // Native disk downloads stay disabled. Capture only this exact native
          // attachment's blob URL, then read it with a strict streaming budget.
          const downloadEvent = page.waitForEvent('download', { timeout: timeoutMs });
          downloadEvent.catch(() => {});
          const clicked = await page.evaluate(inspectMediaDom, { ...args, phase: 'click-file' });
          if (clicked?.error) throw new Error(clicked.error);
          const download = await downloadEvent;
          downloadUrl = download.url();
          await download.cancel().catch(() => {});
        }
        if (descriptor.kind === 'photo') {
          const loaded = await page.evaluate(inspectMediaDom, { ...args, phase: 'load-photo' });
          if (loaded?.error) throw new Error(loaded.error);
        }
        const deadline = Date.now() + timeoutMs;
        let bytes;
        do {
          bytes = await page.evaluate(inspectMediaDom, { ...args, phase: 'blob', downloadUrl });
          if (bytes?.data || bytes?.error !== 'ATTACHMENT_UNAVAILABLE' || descriptor.kind !== 'photo') break;
          await delay(100);
        } while (Date.now() < deadline);
        if (bytes?.error || !bytes?.data) throw new Error(bytes?.error ?? 'ATTACHMENT_UNAVAILABLE');
        return { peerId: chatId, source: 'official-web-dom', contentIsUntrusted: true, messageId, attachmentIndex,
          kind: bytes.kind, mimeType: bytes.mimeType, data: bytes.data, variant: bytes.variant, ...(bytes.filename ? { filename: bytes.filename } : {}), ...(postId ? { postId, thread: exact.thread } : {}) };
      } catch (error) { throw new Error(errors.has(error?.message) ? error.message : 'READ_FAILED'); }
      finally { busy = false; }
    },
    async metadata({ chatId } = {}) {
      ({ chatId } = authorize(undefined, chatId, 1));
      if (busy) throw new Error('READER_BUSY');
      busy = true;
      const deadline = Date.now() + timeoutMs;
      const remaining = () => Math.max(1, deadline - Date.now());
      try {
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: remaining() });
        await page.goto('https://web.telegram.org/a/#' + chatId, { waitUntil: 'domcontentloaded', timeout: remaining() });
        const handle = await page.waitForFunction(inspectDom, { phase: 'metadata', peerId: chatId, limit: 1 }, { timeout: remaining() });
        try { return await handle.jsonValue(); } finally { await handle.dispose(); }
      } catch (error) { throw new Error(errors.has(error?.message) ? error.message : 'TARGET_NOT_VERIFIED'); }
      finally { busy = false; }
    },
    // Setup-only mapping of explicitly supplied usernames. No message capture;
    // normal MCP reads subsequently require the pinned numeric ID, not a handle.
    async resolveUsername({ username } = {}) {
      ({ username } = authorize(username, undefined, 1));
      if (busy) throw new Error('READER_BUSY');
      busy = true;
      const deadline = Date.now() + timeoutMs;
      const remaining = () => Math.max(1, deadline - Date.now());
      try {
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: remaining() });
        await page.goto('https://web.telegram.org/a/#?tgaddr=' + encodeURIComponent('tg://resolve?domain=' + username), { waitUntil: 'domcontentloaded', timeout: remaining() });
        const header = await page.waitForFunction(inspectDom, { phase: 'header', username, limit: 1 }, { timeout: remaining() });
        const { peerId } = await header.jsonValue(); await header.dispose();
        const args = { username, peerId, phase: 'metadata' };
        if (!await page.evaluate(inspectDom, args)) {
          const info = page.locator('#MiddleColumn .MiddleHeader .chat-info-wrapper .info');
          if (await info.count() !== 1) throw new Error('TARGET_NOT_VERIFIED');
          await info.click({ timeout: remaining() });
        }
        const verified = await page.waitForFunction(inspectDom, args, { timeout: remaining() }); await verified.dispose();
        return { username, chatId: peerId, source: 'official-web-dom', identityVerifiedByUi: true };
      } catch (error) { throw new Error(errors.has(error?.message) ? error.message : 'READ_FAILED'); }
      finally { busy = false; }
    },
    async comments({ username, chatId, postId, limit = 5 } = {}) {
      ({ username, chatId } = authorize(username, chatId, limit));
      if (postId !== undefined && (typeof postId !== 'string' || !/^[1-9]\d{0,9}$/.test(postId) || !chatId?.startsWith('-100'))) throw new Error('INVALID_READ_REQUEST');
      if (busy) throw new Error('READER_BUSY');
      busy = true;
      const deadline = Date.now() + timeoutMs;
      const remaining = () => Math.max(1, deadline - Date.now());
      let stage = 'navigation';
      try {
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: remaining() });
        const hash = postId ? '?tgaddr=' + encodeURIComponent(`tg://privatepost?channel=${chatId.slice(4)}&post=${postId}`) : chatId ?? '?tgaddr=' + encodeURIComponent('tg://resolve?domain=' + username);
        await page.goto('https://web.telegram.org/a/#' + hash, { waitUntil: 'domcontentloaded', timeout: remaining() });
        stage = 'header';
        const handle = await page.waitForFunction(inspectDom, { phase: 'header', username, peerId: chatId, limit }, { timeout: remaining() });
        const { peerId } = await handle.jsonValue(); await handle.dispose();
        if (!peerId.startsWith('-100')) throw new Error('COMMENTS_UNAVAILABLE');
        const args = { username, peerId, limit, requestedPostId: postId };
        stage = 'profile';
        if (!await page.evaluate(inspectDom, { ...args, phase: 'verified' })) {
          const info = page.locator('#MiddleColumn .MiddleHeader .chat-info-wrapper .info');
          if (await info.count() !== 1) throw new Error('TARGET_NOT_VERIFIED');
          await info.click({ timeout: remaining() });
        }
        const verified = await page.waitForFunction(inspectDom, { ...args, phase: 'verified' }, { timeout: remaining() }); await verified.dispose();
        stage = 'post-selection';
        let previous = '', stable = 0, candidateId;
        while (Date.now() < deadline) {
          const state = await page.evaluate(inspectDom, { ...args, phase: 'comment-candidate' });
          if (!state) throw new Error('READ_TARGET_CHANGED');
          if (state.error) throw new Error(state.error);
          stable = (postId || (state.newest && state.atBottom)) && state.candidateId && previous === state.candidateId ? stable + 1 : 0;
          previous = state.candidateId;
          if (stable >= 2) { candidateId = state.candidateId; break; }
          if (!postId && !state.newest) {
            const down = page.locator('#MiddleColumn button:has(.icon-arrow-down)').filter({ visible: true });
            if (await down.count() === 1) await down.click({ timeout: remaining() });
          }
          await delay(Math.min(250, remaining()));
        }
        if (!candidateId) throw new Error('COMMENTS_UNAVAILABLE');
        stage = 'open-comments';
        const opened = await page.evaluate(inspectDom, { ...args, phase: 'open-comments', postId: candidateId });
        if (!opened) throw new Error('READ_TARGET_CHANGED');
        if (opened.error) throw new Error(opened.error);
        const result = { username, channelPeerId: peerId, displayName: opened.displayName, post: opened.post, requestedLimit: limit, source: 'official-web-dom', contentIsUntrusted: true };
        if (opened.emptyByUi) return { ...result, thread: null, comments: [], commentsEmptyByUi: true, newestSliceConfirmedByUi: true };
        stage = 'thread-binding';
        const binding = await page.waitForFunction(inspectCommentsDom, { phase: 'bind', limit }, { timeout: remaining() });
        const bound = await binding.jsonValue(); await binding.dispose();
        stage = 'comment-slice';
        let lastSignature = '', commentStable = 0, clicks = 0;
        while (Date.now() < deadline) {
          const state = await page.evaluate(inspectCommentsDom, { ...bound, phase: 'scroll', limit });
          if (!state) throw new Error('READ_TARGET_CHANGED');
          if (state.error) throw new Error(state.error);
          const signature = JSON.stringify(state.selectedIds);
          commentStable = state.newest && state.atBottom && lastSignature === signature ? commentStable + 1 : 0;
          lastSignature = signature;
          if (commentStable >= 2) {
            stage = 'read-comments';
            const captured = await page.evaluate(inspectCommentsDom, { ...bound, phase: 'read', limit });
            if (!captured) throw new Error('READ_TARGET_CHANGED');
            if (captured.error) throw new Error(captured.error);
            return await enrichMedia(page, { ...result, thread: { peerId: bound.threadPeerId, rootMessageId: bound.threadRootId, openedFromVerifiedPost: true }, newestSliceConfirmedByUi: true, comments: captured.comments });
          }
          if (!state.newest && clicks++ < 3) {
            const down = page.locator('#MiddleColumn button:has(.icon-arrow-down)').filter({ visible: true });
            if (await down.count() === 1) await down.click({ timeout: remaining() });
          }
          await delay(Math.min(250, remaining()));
        }
        throw new Error('LATEST_NOT_CONFIRMED');
      } catch (error) {
        const sanitized = new Error(errors.has(error?.message) ? error.message : 'READ_FAILED');
        // Thread diagnostics are structural only; never inspect an unrelated profile.
        sanitized.safeDiagnostics = { stage, ui: await page.evaluate(safeUiDiagnostic, { username }).catch(() => null) };
        throw sanitized;
      } finally { busy = false; }
    },
    async search({ chatId, query, limit = 5 } = {}) {
      ({ chatId } = authorize(undefined, chatId, limit));
      if (typeof query !== 'string' || !query.trim() || query.length > 200 || /[\x00-\x1f\x7f]/.test(query) || /^(#|from:)/i.test(query.trim())) throw new Error('INVALID_READ_REQUEST');
      query = query.trim();
      if (busy) throw new Error('READER_BUSY');
      busy = true;
      const deadline = Date.now() + timeoutMs;
      const remaining = () => Math.max(1, deadline - Date.now());
      let searchStage = 'navigation';
      try {
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: remaining() });
        await page.goto('https://web.telegram.org/a/#' + chatId, { waitUntil: 'domcontentloaded', timeout: remaining() });
        searchStage = 'header';
        const handle = await page.waitForFunction(inspectDom, { phase: 'header', peerId: chatId, limit }, { timeout: remaining() }); await handle.dispose();
        const opened = await page.evaluate(inspectDom, { phase: 'search-open', peerId: chatId, limit });
        if (!opened) throw new Error('READ_TARGET_CHANGED');
        if (opened.error) throw new Error(opened.error);
        searchStage = 'scope';
        const scope = await page.waitForFunction(inspectSearch, { peerId: chatId, checkOnly: true }, { timeout: remaining() });
        const checked = await scope.jsonValue(); await scope.dispose();
        if (checked.error) throw new Error(checked.error);
        searchStage = 'input';
        await page.locator('#MiddleSearch .SearchInput input[type="text"]').fill(query, { timeout: remaining() });
        searchStage = 'results';
        let last = '', stable = 0;
        const notBefore = Date.now() + 1000;
        while (Date.now() < deadline) {
          const result = await page.evaluate(inspectSearch, { peerId: chatId, query, limit });
          if (result?.error) throw new Error(result.error);
          const signature = JSON.stringify(result);
          stable = result && signature === last ? stable + 1 : 0;
          last = signature;
          if (result && stable >= 2 && Date.now() >= notBefore) return { ...result, displayName: opened.displayName };
          await delay(Math.min(250, remaining()));
        }
        throw new Error('SEARCH_NOT_READY');
      } catch (error) {
        const sanitized = new Error(errors.has(error?.message) ? error.message : 'READ_FAILED');
        sanitized.safeDiagnostics = { stage: searchStage, ui: await page.evaluate(({peerId}) => {
          const s = document.querySelector('#MiddleSearch');
          return { searchPresent: !!s, searchVisible: !!s?.getClientRects().length, inputCount: s?.querySelectorAll('input').length ?? 0,
            scopeCount: s ? [...s.querySelectorAll('[data-peer-id]')].filter(el => !el.closest('.SearchInput, .MiddleSearchResult')).length : 0,
            correctScopeCount: s ? [...s.querySelectorAll('[data-peer-id]')].filter(el => !el.closest('.SearchInput, .MiddleSearchResult') && el.getAttribute('data-peer-id') === peerId).length : 0,
            searchButtonCount: document.querySelectorAll('#MiddleColumn .header-tools button:has(.icon-search)').length,
            resultCount: s?.querySelectorAll('.MiddleSearchResult').length ?? 0,
            metaCount: s?.querySelectorAll('.MiddleSearchResult .LastMessageMeta').length ?? 0,
            previewCount: s?.querySelectorAll('.MiddleSearchResult [dir="auto"]').length ?? 0,
            emptyMarkerCount: s?.querySelectorAll('.custom-scroll > span:only-child').length ?? 0 };
        }, {peerId:chatId}).catch(()=>null) };
        throw sanitized;
      }
      finally { busy = false; }
    },
    async history({ chatId, before, limit = 5 } = {}) {
      ({ chatId } = authorize(undefined, chatId, limit));
      if (before !== undefined && (typeof before !== 'string' || !/^[1-9]\d{0,19}$/.test(before))) throw new Error('INVALID_READ_REQUEST');
      if (busy) throw new Error('READER_BUSY');
      busy = true;
      const deadline = Date.now() + timeoutMs;
      const remaining = () => Math.max(1, deadline - Date.now());
      try {
        const args = { peerId: chatId, limit, before };
        // An exclusive older cursor can reuse a verified window containing that
        // anchor, without demanding the chat's newest message. Reuse it rather
        // than rebooting Web A into a partially restored slice on every page.
        // inspectDom rechecks origin/hash/header/root-list before returning IDs.
        const usableWindow = state => !!before && !!state?.allIds?.includes(before);
        let initialized = false;
        if (before) {
          const state = await page.evaluate(inspectDom, { ...args, phase: 'history-state' });
          if (state?.error) throw new Error(state.error);
          initialized = usableWindow(state);
        }
        if (!initialized) {
          await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: remaining() });
          await page.goto('https://web.telegram.org/a/#' + chatId, { waitUntil: 'domcontentloaded', timeout: remaining() });
          const handle = await page.waitForFunction(inspectDom, { ...args, phase: 'header' }, { timeout: remaining() }); await handle.dispose();
        }
        const observed = new Map();
        let lastPage, signature = '', stable = 0, lastAll = '', lastProgressAt = Date.now(), rearmedAll = null;
        while (Date.now() < deadline) {
          const state = await page.evaluate(inspectDom, { ...args, phase: initialized || before ? 'history-state' : 'scroll' });
          if (!state) throw new Error('READ_TARGET_CHANGED');
          if (state.error) throw new Error(state.error);
          if (!initialized) {
            if (usableWindow(state) || (state.newest && state.atBottom)) initialized = true;
            else {
              if (before && state.newest) await page.evaluate(inspectDom, { ...args, phase: 'scroll' });
              const down = page.locator('#MiddleColumn button:has(.icon-arrow-down)').filter({ visible: true });
              if (await down.count() === 1) await down.click({ timeout: remaining() });
            }
          } else {
            const all = JSON.stringify(state.allIds);
            if (all !== lastAll) { lastAll = all; lastProgressAt = Date.now(); }
            if (state.ids.some(id => !observed.has(id))) {
              const captured = await page.evaluate(inspectDom, { ...args, phase: 'history-read' });
              if (!captured || captured.error) throw new Error(captured?.error ?? 'READ_TARGET_CHANGED');
              // Capture and enrich before native virtualization retires these
              // rows; only the nearest requested page is retained in memory.
              lastPage = await enrichMessageMetadata(page, await enrichMedia(page, captured));
              for (const message of lastPage.messages) observed.set(message.id, message);
            }
            const ordered = [...observed.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1).slice(-limit);
            observed.clear(); for (const message of ordered) observed.set(message.id, message);
            if (ordered.length < limit && Date.now() - lastProgressAt >= 2000 && rearmedAll !== all) {
              // A loading observer can ignore an entry while Web A replaces its
              // viewport. Staying at scrollTop=0 cannot produce a second entry.
              // Rearm only this verified root once per unchanged ID window.
              const moved = await page.evaluate(inspectDom, { ...args, phase: 'history-rearm' });
              if (!moved) throw new Error('READ_TARGET_CHANGED');
              if (moved.error) throw new Error(moved.error);
              rearmedAll = all;
              await delay(Math.min(500, remaining()));
              const restored = await page.evaluate(inspectDom, { ...args, phase: 'history-up' });
              if (!restored) throw new Error('READ_TARGET_CHANGED');
              if (restored.error) throw new Error(restored.error);
              lastProgressAt = Date.now(); signature = ''; stable = 0;
              continue;
            }
            const next = JSON.stringify(ordered.map(message => message.id));
            const hasPartial = ordered.length > 0 && Date.now() - lastProgressAt >= 2000;
            stable = (ordered.length >= limit || hasPartial) && signature === next ? stable + 1 : 0;
            signature = next;
            if (stable >= 2) {
              const proof = await page.evaluate(inspectDom, { ...args, phase: 'history-state' });
              if (!proof || proof.error) throw new Error(proof?.error ?? 'READ_TARGET_CHANGED');
              return { ...lastPage, messages: ordered, nextBefore: ordered[0].id };
            }
            if (ordered.length < limit) {
              const moved = await page.evaluate(inspectDom, { ...args, phase: 'history-up' });
              if (!moved) throw new Error('READ_TARGET_CHANGED');
              if (moved.error) throw new Error(moved.error);
            }
          }
          await delay(Math.min(250, remaining()));
        }
        throw new Error('HISTORY_NOT_LOADED');
      } catch (error) { throw new Error(errors.has(error?.message) ? error.message : 'READ_FAILED'); }
      finally { busy = false; }
    },
    async latest({ username, chatId, limit = 5 } = {}) {
      ({ username, chatId } = authorize(username, chatId, limit));
      if (busy) throw new Error('READER_BUSY');
      busy = true;
      const deadline = Date.now() + timeoutMs;
      const remaining = () => Math.max(1, deadline - Date.now());
      let stage = 'navigation';
      try {
        const hash = chatId ?? '?tgaddr=' + encodeURIComponent('tg://resolve?domain=' + username);
        // Reboot Web A's initial location parser, retaining persistent storage.
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: remaining() });
        await page.goto('https://web.telegram.org/a/#' + hash, { waitUntil: 'domcontentloaded', timeout: remaining() });
        stage = 'header';
        const handle = await page.waitForFunction(inspectDom, { phase: 'header', username, peerId: chatId, limit }, { timeout: remaining() });
        const { peerId } = await handle.jsonValue();
        await handle.dispose();
        const args = { username, peerId, limit };
        stage = 'profile';
        if (!await page.evaluate(inspectDom, { ...args, phase: 'verified' })) {
          const info = page.locator('#MiddleColumn .MiddleHeader .chat-info-wrapper .info');
          if (await info.count() !== 1) throw new Error('TARGET_NOT_VERIFIED');
          await info.click({ timeout: remaining() });
        }
        const verified = await page.waitForFunction(inspectDom, { ...args, phase: 'verified' }, { timeout: remaining() });
        await verified.dispose();
        stage = 'latest-slice';
        let lastSignature = '', stable = 0, clicks = 0;
        while (Date.now() < deadline) {
          const state = await page.evaluate(inspectDom, { ...args, phase: 'scroll' });
          if (!state) throw new Error('READ_TARGET_CHANGED');
          if (state.error) throw new Error(state.error);
          const signature = JSON.stringify(state.selectedIds);
          stable = state.newest && state.atBottom && state.count > 0 && signature === lastSignature ? stable + 1 : 0;
          lastSignature = signature;
          if (stable >= 2) {
            stage = 'read';
            const result = await page.evaluate(inspectDom, { ...args, phase: 'read' });
            if (!result) throw new Error('READ_TARGET_CHANGED');
            if (result.error) throw new Error(result.error);
            return await enrichMedia(page, result);
          }
          if (!state.newest && clicks < 3) {
            const down = page.locator('#MiddleColumn button:has(.icon-arrow-down)').filter({ visible: true });
            if (await down.count() === 1) { await down.click({ timeout: remaining() }); clicks++; }
          }
          await delay(Math.min(250, remaining()));
        }
        throw new Error('LATEST_NOT_CONFIRMED');
      } catch (error) {
        const sanitized = new Error(errors.has(error?.message) ? error.message : 'READ_FAILED');
        sanitized.safeDiagnostics = { stage, ui: await page.evaluate(safeUiDiagnostic, { username }).catch(() => null) };
        throw sanitized;
      } finally { busy = false; }
    },
  };
  // Persist/display budgeting belongs outside capture. Every read shares the
  // same verified metadata extraction rather than reparsing rendered times.
  // History enriches each observed window before its rows can be virtualized.
  for (const name of ['latest', 'message', 'comments']) {
    const read = reader[name].bind(reader);
    reader[name] = async request => {
      const result = await read(request);
      try { return await enrichMessageMetadata(page, result); }
      catch (error) {
        // Official discussion headers can omit avatars. Preserve a previously
        // verified post-thread read only after rechecking that exact hash/list;
        // missing enrichment is UNKNOWN, never weaker chat authorization.
        if (error?.message !== 'READ_TARGET_CHANGED' || result.thread?.openedFromVerifiedPost !== true) throw error;
        const proof = await page.evaluate(inspectCommentsDom, { phase: 'metadata-proof', threadPeerId: result.thread.peerId, threadRootId: result.thread.rootMessageId });
        if (proof?.avatarlessHeader !== true) throw error;
        if (result.message) return { ...result, message: { ...result.message, ...normalizeMessageEvidence({}) } };
        if (Array.isArray(result.comments)) return { ...result, comments: result.comments.map(message => ({ ...message, ...normalizeMessageEvidence({}) })) };
        throw error;
      }
    };
  }
  return reader;
}
