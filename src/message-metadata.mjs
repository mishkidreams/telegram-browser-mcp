// DOM evidence only, pinned to Ajaxy/telegram-tt f67a40879a7d78c2683ec5a296cf55bc22417d56.
// Source: https://github.com/Ajaxy/telegram-tt/tree/f67a40879a7d78c2683ec5a296cf55bc22417d56/src
// src/components/middle/message/MessageMeta.tsx:93-116,213: title's FIRST line
// is creation time, followed by edited/forwarded dates. No epoch/datetime attr.
// src/util/localization/dateFormat.ts:250-269,315-335,376-386,422-427:
// short month, numeric day/year, seconds, h12/h23, browser-local time zone.
// src/components/middle/message/Message.tsx:1240-1293,1765-1830,1923-1945:
// native author-name/unread-mention markers. Never Date.parse localized text.
const idPattern = /^[1-9]\d{0,19}$/;
const peerPattern = /^-?[1-9]\d{0,19}$/;
const timestampSource = 'official-web-dom:message-time-title';
const cleanName = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 256) || null : null;
const canonical = (value, pattern) => typeof value === 'string' && pattern.test(value) ? value : null;

// Public egress whitelist: spread this object, never the raw DOM evidence.
export function normalizeMessageEvidence(value) {
  const v = value && typeof value === 'object' ? value : {};
  let timestamp = null, timeZone = null;
  if (typeof v.timestamp === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.timestamp)) {
    const date = new Date(v.timestamp);
    if (Number.isFinite(date.getTime()) && date.toISOString() === v.timestamp) timestamp = v.timestamp;
  }
  if (typeof v.timeZone === 'string' && v.timeZone.length <= 100 && /^[A-Za-z_]+(?:\/[A-Za-z_+\d-]+)*$/.test(v.timeZone)) {
    try { new Intl.DateTimeFormat('en', { timeZone: v.timeZone }); timeZone = v.timeZone; } catch { /* unknown zone */ }
  }
  if (v.timestampSource !== timestampSource || !timeZone) timestamp = null;
  const senderId = canonical(v.sender?.id, peerPattern), senderName = cleanName(v.sender?.name);
  const replyId = canonical(v.replyTo?.messageId, idPattern), replyChat = canonical(v.replyTo?.chatId, peerPattern);
  const topicId = canonical(v.topic?.id, idPattern);
  return { timestamp, timeZone, timestampSource: timestamp ? timestampSource : null,
    sender: senderId || senderName ? { id: senderId, name: senderName } : null,
    replyTo: replyId && replyChat ? { messageId: replyId, chatId: replyChat } : null,
    topic: topicId ? { id: topicId, name: cleanName(v.topic.name) } : null,
    mentioned: typeof v.mentioned === 'boolean' ? v.mentioned : null };
}

// Pinned source: components/left/main/LeftSideMenuItems.tsx renders the native
// MenuItem icon="saved-messages"; handleSelectSaved opens currentUserId, not a
// displayed name/account-menu ordering. AccountMenuItems uses ID-less CustomPeer
// avatars (Avatar.tsx:136-137,331), so its account selector is NOT identity proof.
// This explicitly authorized metadata-only navigation leaves self-chat open.
export async function readAccountIdentity(page) {
  let identity;
  try {
    identity = await page.evaluate(async () => {
      const official = () => location.origin === 'https://web.telegram.org' && location.pathname === '/a/';
      const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).opacity !== '0';
      if (!official()) return null;
      const triggerSelector = '#LeftMainHeader > .DropdownMenu.main-menu:not(.forum-search-button) > button';
      // DOMContentLoaded precedes Teact hydration. One bounded budget covers
      // native menu readiness and the self-chat hash/header settling afterward.
      const deadline = performance.now() + 10_000;
      const until = async read => {
        do {
          if (!official()) return null;
          const value = read();
          if (value) return value;
          await new Promise(resolve => setTimeout(resolve, 25));
        } while (performance.now() < deadline);
        return null;
      };
      const trigger = await until(() => {
        const found = [...document.querySelectorAll(triggerSelector)].filter(visible);
        if (found.length !== 1 || found[0].disabled || found[0].classList.contains('disabled')
          || !found[0].querySelector('.animated-menu-icon:not(.state-back)') || found[0].querySelector('.animated-menu-icon.state-back')) return null;
        return found[0];
      });
      if (!trigger) return null;
      const menus = () => [...document.querySelectorAll('.Menu.main-menu > .bubble.menu-container')].filter(visible);
      if (menus().length === 0) {
        // Button.tsx desktop triggers on mousedown, touch on click; dispatch the
        // normal sequence on this exact verified trigger, never an arbitrary UI.
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
        trigger.click();
      }
      const menu = await until(() => { const found = menus(); return found.length === 1 ? found[0] : null; });
      if (!menu || !official()) return null;
      const candidates = [...menu.querySelectorAll(':scope > .MenuItem')].filter(item => item.querySelector(':scope > i.icon.icon-saved-messages'));
      if (candidates.length !== 1) return null;
      const saved = candidates[0];
      if (!visible(saved) || saved.tagName !== 'DIV' || saved.getAttribute('role') !== 'menuitem' || saved.hasAttribute('href')
        || saved.classList.contains('disabled') || saved.classList.contains('destructive') || saved.classList.contains('submenu')
        || menus().length !== 1 || !menu.isConnected || !trigger.isConnected) return null;
      saved.click();
      // Do not query MessageList, message text, phone fields or account settings.
      return until(() => {
        const accountId = /^#([1-9]\d{0,19})$/.exec(location.hash)?.[1];
        if (!accountId) return null;
        const headers = [...document.querySelectorAll('#MiddleColumn .MiddleHeader .chat-info-wrapper')].filter(visible);
        if (headers.length !== 1) return null;
        const avatars = [...headers[0].querySelectorAll('.ChatInfo > .Avatar[data-peer-id]')].filter(visible);
        // PrivateChatInfo.tsx:342-345 derives this marker from user.isSelf;
        // Avatar.tsx:278-284,331 preserves both the marker and real user ID.
        if (avatars.length !== 1 || !avatars[0].classList.contains('saved-messages')
          || avatars[0].classList.contains('saved-dialog-avatar') || avatars[0].classList.contains('overlay-avatar')) return null;
        return avatars[0].getAttribute('data-peer-id') === accountId ? { accountId, identityVerifiedByUi: true } : null;
      });
    });
  } catch { throw new Error('READ_FAILED'); }
  if (!identity || !canonical(identity.accountId, idPattern) || identity.identityVerifiedByUi !== true) throw new Error('READ_FAILED');
  return { accountId: identity.accountId, identityVerifiedByUi: true };
}

export async function enrichMessageMetadata(page, result) {
  const key = Array.isArray(result?.messages) ? 'messages' : result?.message ? 'message' : Array.isArray(result?.comments) ? 'comments' : null;
  if (!key) throw new Error('INVALID_READ_REQUEST');
  const messages = key === 'message' ? [result.message] : result[key];
  const peerId = result.peerId ?? result.channelPeerId;
  if (!canonical(peerId, peerPattern) || result.source !== 'official-web-dom' || result.contentIsUntrusted !== true
    || messages.some(message => !canonical(message?.id, idPattern)) || new Set(messages.map(message => message.id)).size !== messages.length) throw new Error('INVALID_READ_REQUEST');
  const thread = result.thread ?? null;
  const topicId = result.topic?.id ?? null;
  if (result.topic && (!canonical(topicId, idPattern) || thread)) throw new Error('INVALID_READ_REQUEST');
  if (thread && (!canonical(thread.peerId, peerPattern) || !canonical(thread.rootMessageId, idPattern) || thread.openedFromVerifiedPost !== true)) throw new Error('INVALID_READ_REQUEST');
  // The caller already verified an explicit empty result. There are no message
  // metadata fields to enrich, nor a comment-thread list when its counter is zero.
  if (messages.length === 0) return result;
  let evidence;
  try {
    evidence = await page.evaluate(async ({ peerId, thread, topicId, requests }) => {
      const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
      const actualPeer = thread?.peerId ?? peerId, rootId = thread?.rootMessageId ?? topicId ?? '-1';
      const verifyScope = () => {
        if (location.origin !== 'https://web.telegram.org' || location.pathname !== '/a/'
          || location.hash !== (thread || topicId ? `#${actualPeer}_${rootId}` : `#${actualPeer}`)) return null;
        const headers = [...document.querySelectorAll('#MiddleColumn .MiddleHeader .chat-info-wrapper')].filter(visible);
        if (headers.length !== 1) return null;
        const peers = [...new Set([...headers[0].querySelectorAll('.Avatar[data-peer-id]')].map(element => element.getAttribute('data-peer-id')))];
        // The pinned forum TopicIcon replaces its peer avatar; nonforum comment
        // headers can be counter-only. Without native header peer evidence those
        // layouts are intentionally unsupported, even with a matching list key.
        if (peers.length !== 1 || peers[0] !== actualPeer) return null;
        const lists = [...document.querySelectorAll('#MiddleColumn .MessageList')].filter(visible);
        if (lists.length !== 1 || lists[0].getAttribute('data-list-key') !== `${actualPeer}_${rootId}_thread`) return null;
        let topic = null;
        if (topicId) {
          // GroupChatInfo.tsx:122,263-272: only an actual forum-topic header
          // renders this marker/title. Never infer topics from message groups.
          const icons = [...headers[0].querySelectorAll('.ChatInfo .topic-header-icon')].filter(visible);
          if (icons.length !== 1) return null;
          const names = [...headers[0].querySelectorAll('.ChatInfo .info > h3.fullName')].filter(visible);
          topic = { id: topicId, name: names.length === 1 ? names[0].textContent.trim().slice(0, 256) : null };
        }
        return { list: lists[0], rows: [...lists[0].querySelectorAll('.Message[data-message-id]')].filter(visible), topic };
      };
      let scope = verifyScope();
      if (!scope) return null;
      const resolveRow = request => {
        const direct = scope.rows.filter(row => row.getAttribute('data-message-id') === request.id);
        // src/components/middle/message/Album.tsx renders album-media- plus
        // getMessageHtmlId(message.id). Only that exact native tile can prove a
        // member ID absent from its shared parent bubble's data-message-id.
        const tiles = [...scope.list.querySelectorAll(`[id="album-media-message-${request.id}"]`)].filter(tile => visible(tile)
          && scope.rows.includes(tile.closest('.Message')) && !tile.closest('.EmbeddedMessage, .WebPage, .Reactions'));
        if (direct.length > 1 || tiles.length > 1) return null;
        const albumRow = tiles[0]?.closest('.Message');
        if (direct.length && albumRow && direct[0] !== albumRow) return null;
        const row = direct[0] ?? albumRow;
        if (!row || !/^[1-9]\d{0,19}$/.test(row.getAttribute('data-message-id'))
          || (thread && (request.id === rootId || row.getAttribute('data-message-id') === rootId || row.classList.contains('is-thread-top')))) return null;
        const grouped = !!albumRow || request.album || row.classList.contains('is-album')
          || [...row.querySelectorAll('.bottom-marker[data-last-message-id]')].some(marker => marker.getAttribute('data-last-message-id') !== request.id);
        return { row, grouped };
      };
      let didHover = false;
      for (const request of requests) {
        const target = resolveRow(request);
        if (!target) return null;
        const { row, grouped } = target;
        if (grouped) continue;
        const times = [...row.querySelectorAll('.MessageMeta > .message-time')].filter(element => element.closest('.Message') === row && !element.closest('.EmbeddedMessage, .WebPage, .Reactions'));
        if (times.length === 1 && !times[0].hasAttribute('title')) {
          // MessageMeta.tsx onMouseEnter only enables its native creation title;
          // no clicks, mutations, network, globals or account actions are invoked.
          times[0].dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
          didHover = true;
        }
      }
      if (didHover) {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const next = verifyScope();
        if (!next || next.list !== scope.list) return null;
        scope = next;
      }
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      // html.lang is source-proven native UI evidence; Telegram's pluralCode can
      // differ. Accept only a full named-month grammar + exact Intl roundtrip.
      // Numeric month grammars are deliberately unsupported rather than guessed.
      const locale = document.documentElement.lang;
      const normalize = text => text.replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/gu, ' ');
      const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const parsers = [];
      if (locale && locale.length <= 50) {
        for (const hourCycle of ['h23', 'h12']) {
          try {
            const formatter = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle });
            if (formatter.resolvedOptions().calendar !== 'gregory') continue;
            const digits = Array.from({ length: 10 }, (_, i) => new Intl.NumberFormat(locale, { useGrouping: false }).format(i));
            const numeric = text => Number([...text].map(char => digits.indexOf(char)).join(''));
            const months = Array.from({ length: 12 }, (_, i) => normalize(formatter.formatToParts(new Date(2006, i, 22, 13, 54, 56)).find(part => part.type === 'month')?.value ?? ''));
            if (months.some(month => !month || /^[\p{N}.\s]+$/u.test(month)) || new Set(months).size !== 12) continue;
            const fields = [];
            const pattern = formatter.formatToParts(new Date(2006, 10, 22, 13, 54, 56)).map(part => {
              if (part.type === 'literal') return escape(normalize(part.value));
              fields.push(part.type);
              if (part.type === 'month') return `(${months.map(escape).join('|')})`;
              if (part.type === 'dayPeriod') return '(.+?)';
              return `([${digits.map(escape).join('')}]{1,4})`;
            }).join('');
            parsers.push({ formatter, regex: new RegExp(`^${pattern}$`, 'u'), fields, numeric, months, hourCycle });
          } catch { /* unsupported locale/ICU: keep unknown */ }
        }
      }
      function parseCreationTitle(title) {
        if (!title || title.length > 2048) return null;
        const text = normalize(title.split('\n')[0]).trim();
        const matches = new Set();
        for (const parser of parsers) {
          const match = parser.regex.exec(text);
          if (!match) continue;
          const parts = Object.fromEntries(parser.fields.map((field, i) => [field, match[i + 1]]));
          const year = parser.numeric(parts.year), month = parser.months.indexOf(parts.month);
          const day = parser.numeric(parts.day), minute = parser.numeric(parts.minute), second = parser.numeric(parts.second);
          let hour = parser.numeric(parts.hour);
          if (year < 1970 || year > 9999 || day < 1 || day > 31 || minute > 59 || second > 59) continue;
          if (parser.hourCycle === 'h12') {
            const periods = [1, 13].map(h => normalize(parser.formatter.formatToParts(new Date(2006, 10, 22, h, 54, 56)).find(part => part.type === 'dayPeriod')?.value ?? ''));
            if (hour < 1 || hour > 12 || !periods.includes(parts.dayPeriod)) continue;
            hour = hour % 12 + (parts.dayPeriod === periods[1] ? 12 : 0);
          } else if (hour > 23) continue;
          const wall = Date.UTC(year, month, day, hour, minute, second);
          const offsets = new Set();
          // Enumerate nearby native offsets, not a guessed UTC offset. A repeated
          // DST wall time has two matches and therefore stays unknown.
          for (let delta = -48; delta <= 48; delta += 6) offsets.add(new Date(wall + delta * 3600000).getTimezoneOffset());
          for (const offset of offsets) {
            const date = new Date(wall + offset * 60000);
            if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) continue;
            if (normalize(parser.formatter.format(date)).trim() === text) matches.add(date.toISOString());
          }
        }
        return matches.size === 1 ? [...matches][0] : null;
      }
      const captured = [];
      for (const request of requests) {
        const target = resolveRow(request);
        if (!target) return null;
        const { row, grouped } = target;
        // A group's shared meta is not an individual album member's evidence.
        if (grouped) { captured.push({ topic: scope.topic }); continue; }
        const owned = selector => [...row.querySelectorAll(selector)].filter(element => element.closest('.Message') === row && !element.closest('.EmbeddedMessage, .WebPage, .Reactions'));
        const times = owned('.MessageMeta > .message-time');
        const timestamp = times.length === 1 ? parseCreationTitle(times[0].getAttribute('title')) : null;
        const names = owned('.content-inner:not(.forwarded-message) > .message-title > .message-title-name-container > .message-title-name > .sender-title');
        const name = names.length === 1 ? names[0].textContent.trim().slice(0, 256) : null;
        const mentioned = row.classList.contains('has-unread-mention') || owned(':scope > .bottom-marker[data-has-unread-mention="true"]').length > 0 ? true : null;
        captured.push({ timestamp, timeZone: zone, timestampSource: timestamp ? 'official-web-dom:message-time-title' : null, sender: name ? { id: null, name } : null, topic: scope.topic, mentioned });
      }
      return captured;
    }, { peerId, thread, topicId, requests: messages.map(message => ({ id: message.id, album: message.omittedReason === 'ALBUM' })) });
  } catch { throw new Error('READ_TARGET_CHANGED'); }
  if (!Array.isArray(evidence) || evidence.length !== messages.length) throw new Error('READ_TARGET_CHANGED');
  const enriched = messages.map((message, index) => ({ ...message, ...normalizeMessageEvidence(evidence[index]) }));
  return { ...result, [key]: key === 'message' ? enriched[0] : enriched };
}
