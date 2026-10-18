import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import * as metadata from '../src/message-metadata.mjs';
const { enrichMessageMetadata, normalizeMessageEvidence } = metadata;

// Public seams agreed in the task: enrichment on a routed official-origin DOM,
// and the metadata egress whitelist. No auth, persistent profile or Telegram I/O.
async function fixture(t, { title = 'Mar 25, 2026, 11:42:09', lang = 'en', timeZone = 'Europe/Moscow', browserLocale, hash = '#321', headerPeer = '321', listKey = '321_-1_thread', body, origin = 'https://web.telegram.org/a/' } = {}) {
  const browser = await chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ timezoneId: timeZone, locale: browserLocale });
  const page = await context.newPage();
  const row = body ?? `<div class="Message" data-message-id="7"><div class="bottom-marker" data-message-id="7"></div><div class="message-content-wrapper"><div class="message-content"><div class="content-inner"><div class="message-title"><span class="message-title-name-container"><span class="message-title-name"><span class="sender-title">Native Sender</span></span></span></div><div class="text-content">message body<span class="MessageMeta"><span class="message-time" title="${title}">11:42</span></span></div></div></div></div></div>`;
  const html = `<!doctype html><html lang="${lang}"><body><div id="LeftColumn">UNRELATED SIDEBAR</div><div id="MiddleColumn"><div class="MiddleHeader"><div class="chat-info-wrapper"><div class="Avatar" data-peer-id="${headerPeer}"></div></div></div><div class="MessageList" data-list-key="${listKey}">${row}</div><div class="Composer">PRIVATE COMPOSER</div></div></body></html>`;
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.fulfill({ status: 200, contentType: 'text/html', body: html }) : route.abort());
  await page.goto(origin + hash);
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    Object.defineProperty(Node.prototype, 'textContent', { get() {
      if (this.nodeType === Node.ELEMENT_NODE && (this.closest('#LeftColumn, .Composer') || this.matches('body, html, #MiddleColumn, .MessageList, .Message, .text-content'))) throw Error('OUT_OF_SCOPE_TEXT_READ');
      return descriptor.get.call(this);
    }, set: descriptor.set });
  });
  return page;
}
const result = (extra = {}) => ({ peerId: '321', source: 'official-web-dom', contentIsUntrusted: true, messages: [{ id: '7', text: 'previously captured', displayTime: 'raw display retained' }], ...extra });
const unknown = { timestamp: null, timeZone: null, timestampSource: null, sender: null, replyTo: null, topic: null, mentioned: null };

test('enriches a verified message using the native full creation title and browser time zone', async t => {
  const page = await fixture(t);
  const input = result();
  const output = await enrichMessageMetadata(page, input);
  assert.deepEqual(output.messages[0], { ...input.messages[0], timestamp: '2026-03-25T08:42:09.000Z', timeZone: 'Europe/Moscow', timestampSource: 'official-web-dom:message-time-title', sender: { id: null, name: 'Native Sender' }, replyTo: null, topic: null, mentioned: null });
  assert.equal(input.messages[0].timestamp, undefined);
});

test('materializes only the exact native time tooltip with mouseenter, in one evaluate', async t => {
  const page = await fixture(t, { title: '' });
  await page.evaluate(() => {
    const time = document.querySelector('.MessageMeta > .message-time');
    time.removeAttribute('title');
    time.addEventListener('mouseenter', () => requestAnimationFrame(() => { time.title = 'Mar 25, 2026, 11:42:09'; }));
    document.addEventListener('click', () => { throw Error('NO_CLICKS'); });
  });
  let calls = 0;
  const output = await enrichMessageMetadata({ evaluate: (...args) => { calls++; return page.evaluate(...args); } }, result());
  assert.equal(calls, 1);
  assert.equal(output.messages[0].timestamp, '2026-03-25T08:42:09.000Z');
});

async function ownAccountUi(page, { menuClass = 'main-menu', savedId = '777', headerId = savedId, duplicate = false, link = false, noAction = false } = {}) {
  await page.evaluate(({ menuClass, savedId, headerId, duplicate, link, noAction }) => {
    const avatar = document.querySelector('#MiddleColumn .MiddleHeader .Avatar');
    const chatInfo = document.createElement('div');
    chatInfo.className = 'ChatInfo';
    avatar.replaceWith(chatInfo);
    chatInfo.append(avatar);
    const left = document.querySelector('#LeftColumn');
    left.innerHTML = `<div id="LeftMainHeader"><div class="DropdownMenu ${menuClass}"><button type="button"><div class="animated-menu-icon"></div></button></div></div>`;
    const button = left.querySelector('button');
    button.addEventListener('click', () => {
      const menu = document.createElement('div');
      menu.className = `Menu ${menuClass}`;
      menu.innerHTML = `<div class="bubble menu-container"><div class="MenuItem account-menu-item" role="menuitem">Not an ID</div><div class="MenuItem" role="menuitem"><i class="icon icon-settings"></i>Never settings</div>${Array.from({ length: duplicate ? 2 : 1 }, () => link ? '<a class="MenuItem" href="https://example.com/"><i class="icon icon-saved-messages"></i></a>' : '<div class="MenuItem" role="menuitem"><i class="icon icon-saved-messages"></i>Localized saved label</div>').join('')}</div>`;
      document.body.append(menu);
      menu.querySelectorAll('.MenuItem').forEach(item => item.addEventListener('click', () => {
        if (!item.querySelector('.icon-saved-messages')) throw Error('UNAUTHORIZED_CLICK');
        document.body.setAttribute('data-native-saved-click', 'true');
        if (noAction) return;
        location.hash = `#${savedId}`;
        const avatar = document.querySelector('#MiddleColumn .MiddleHeader .Avatar');
        avatar.setAttribute('data-peer-id', headerId);
        avatar.classList.add('saved-messages');
        menu.remove();
      }));
    });
    // Identity may inspect only native own UI/header metadata, not any messages.
    for (const prototype of [Document.prototype, Element.prototype]) {
      for (const method of ['querySelector', 'querySelectorAll']) {
        const original = prototype[method];
        prototype[method] = function (selector) {
          if (/MessageList|\.Message(?:\W|$)|Composer|data-list-key/.test(selector)) throw Error('IDENTITY_MUST_NOT_READ_MESSAGES');
          return original.call(this, selector);
        };
      }
    }
    for (const key of ['localStorage', 'sessionStorage', 'indexedDB']) Object.defineProperty(window, key, { get() { throw Error('NO_STORAGE'); } });
  }, { menuClass, savedId, headerId, duplicate, link, noAction });
}

test('identifies current self only through native Saved Messages navigation and matching header', async t => {
  const page = await fixture(t);
  await ownAccountUi(page);
  const identity = await metadata.readAccountIdentity(page);
  assert.deepEqual(identity, { accountId: '777', identityVerifiedByUi: true });
  assert.equal(await page.getAttribute('body', 'data-native-saved-click'), 'true');
  assert.equal(new URL(page.url()).hash, '#777');
});

test('self identity waits for delayed native hamburger hydration without inspecting other UI', async t => {
  const page = await fixture(t);
  await ownAccountUi(page);
  await page.evaluate(() => {
    const header = document.querySelector('#LeftMainHeader');
    const parent = header.parentElement;
    header.remove();
    setTimeout(() => parent.append(header), 400);
  });
  assert.deepEqual(await metadata.readAccountIdentity(page), { accountId: '777', identityVerifiedByUi: true });
});

test('topic identity requires explicit topic scope, exact list root and native topic header', async t => {
  const page = await fixture(t, { hash: '#321_42', listKey: '321_42_thread' });
  await page.evaluate(() => {
    const info = document.querySelector('.chat-info-wrapper');
    const header = document.createElement('div');
    header.className = 'ChatInfo';
    header.innerHTML = '<div class="topic-header-icon"></div><div class="info"><h3 class="fullName">Verified Topic</h3></div>';
    info.append(header);
  });
  const output = await enrichMessageMetadata(page, result({ topic: { id: '42', name: 'Untrusted input name' } }));
  assert.deepEqual(output.messages[0].topic, { id: '42', name: 'Verified Topic' });
  // Pinned GroupChatInfo renders only a TopicIcon, replacing its peer avatar.
  // A matching hash/list plus that icon must not weaken the header-peer guard.
  await page.evaluate(() => document.querySelector('.chat-info-wrapper > .Avatar').remove());
  await assert.rejects(enrichMessageMetadata(page, result({ topic: { id: '42' } })), /^Error: READ_TARGET_CHANGED$/);
});

test('normalizer exposes exactly the egress schema and clears unsupported values', () => {
  assert.deepEqual(normalizeMessageEvidence(undefined), unknown);
  assert.deepEqual(normalizeMessageEvidence({ timestamp: '25/03/2026', timeZone: 'Invalid/Zone', timestampSource: 'data-timestamp', sender: { id: 23, name: '' }, replyTo: { messageId: '07', chatId: '321' }, topic: { id: 9 }, mentioned: 'true', secret: 'NEVER' }), unknown);
  const normalized = normalizeMessageEvidence({ timestamp: '2026-03-25T08:42:09.000Z', timeZone: 'Europe/Moscow', timestampSource: 'official-web-dom:message-time-title', sender: { id: '123', name: '  Name\u0000  ', secret: 'discard' }, replyTo: { messageId: '9', chatId: '-100123' }, topic: { id: '42', name: 'Topic' }, mentioned: true, accountToken: 'discard' });
  assert.deepEqual(Object.keys(normalized).sort(), Object.keys(unknown).sort());
  assert.deepEqual(normalized.sender, { id: '123', name: 'Name' });
  assert.deepEqual(normalized.replyTo, { messageId: '9', chatId: '-100123' });
  assert.deepEqual(normalized.topic, { id: '42', name: 'Topic' });
  assert.equal(normalized.timestamp, '2026-03-25T08:42:09.000Z');
  assert.equal(normalizeMessageEvidence({ ...normalized, timestamp: '2026-02-30T08:42:09.000Z' }).timestamp, null);
  assert.equal(normalizeMessageEvidence({ ...normalized, timestampSource: 'guessed' }).timestampSource, null);
});

test('localized native titles roundtrip exactly; creation time is never edited/forwarded time', async t => {
  const page = await fixture(t);
  const cases = [
    ['en', 'Mar 25, 2026, 11:42:09', '2026-03-25T08:42:09.000Z'],
    ['en', 'Mar 25, 2026, 11:42:09 AM', '2026-03-25T08:42:09.000Z'],
    ['en', 'Mar 25, 2026, 11:42:09 PM', '2026-03-25T20:42:09.000Z'],
    ['ru', '25 мар. 2026 г., 11:42:09', '2026-03-25T08:42:09.000Z'],
    ['en', 'Mar 25, 2026, 11:42:09\nEdited: Mar 26, 2026, 09:00:00\nForwarded: Jan 1, 2020, 01:00:00', '2026-03-25T08:42:09.000Z'],
    ['en', '03/04/2026 11:42', null],
    ['en', '11:42', null],
    ['en', 'Feb 30, 2026, 11:42:09', null],
    ['en', 'Mar 25, 26, 11:42:09', null],
    ['en', 'Mar 25, 2026, 24:42:09', null],
    ['en', 'Edited: Mar 25, 2026, 11:42:09', null],
    ['', 'Mar 25, 2026, 11:42:09', null],
    ['zz-invalid', 'Mar 25, 2026, 11:42:09', null],
    ['not_a_locale', 'Mar 25, 2026, 11:42:09', null],
  ];
  for (const [lang, title, expected] of cases) {
    await page.evaluate(({ lang, title }) => { document.documentElement.lang = lang; document.querySelector('.message-time').title = title; }, { lang, title });
    assert.equal((await enrichMessageMetadata(page, result())).messages[0].timestamp, expected, `${lang}: ${title}`);
  }
});

test('unsupported locale cannot parse a title from the browser default locale', async t => {
  const page = await fixture(t, { lang: 'zz-invalid', browserLocale: 'en-US' });
  // A structurally valid but unsupported tag silently falls back, not throws.
  // Pin the browser default so this repro does not depend on the host OS locale.
  assert.deepEqual(await page.evaluate(() => ({
    canonical: Intl.getCanonicalLocales('zz-invalid'),
    supported: Intl.DateTimeFormat.supportedLocalesOf('zz-invalid'),
    fallback: new Intl.DateTimeFormat('zz-invalid').resolvedOptions().locale,
    defaultLocale: Intl.DateTimeFormat().resolvedOptions().locale,
  })), { canonical: ['zz-invalid'], supported: [], fallback: 'en-US', defaultLocale: 'en-US' });
  const message = (await enrichMessageMetadata(page, result())).messages[0];
  assert.equal(message.timestamp, null);
  assert.equal(message.timestampSource, null);
  assert.equal(message.timeZone, 'Europe/Moscow');
  // The same exact title remains valid when the native UI locale is supported.
  await page.evaluate(() => { document.documentElement.lang = 'en-US'; });
  assert.equal((await enrichMessageMetadata(page, result())).messages[0].timestamp, '2026-03-25T08:42:09.000Z');
});

test('repeated DST wall times and nonexistent DST wall times remain unknown', async t => {
  const page = await fixture(t, { timeZone: 'America/New_York' });
  for (const [title, expected] of [['Nov 1, 2026, 01:30:00', null], ['Mar 8, 2026, 02:30:00', null], ['Nov 1, 2026, 03:30:00', '2026-11-01T08:30:00.000Z']]) {
    await page.evaluate(title => { document.querySelector('.message-time').title = title; }, title);
    const message = (await enrichMessageMetadata(page, result())).messages[0];
    assert.equal(message.timestamp, expected);
    assert.equal(message.timeZone, 'America/New_York');
  }
});

test('does not use unproven epoch/datetime/title attributes or reply-preview IDs', async t => {
  const page = await fixture(t, { title: '03/04/2026 11:42' });
  await page.evaluate(() => {
    const row = document.querySelector('.Message');
    row.setAttribute('data-timestamp', '1774431729');
    row.setAttribute('data-sender-id', '123');
    row.setAttribute('data-reply-to-message-id', '99');
    row.setAttribute('data-topic-id', '42');
    const time = document.querySelector('.message-time');
    time.setAttribute('datetime', '2026-03-25T08:42:09.000Z');
    time.insertAdjacentHTML('afterend', '<time datetime="2026-03-25T08:42:09.000Z">time</time>');
    row.insertAdjacentHTML('beforeend', '<div class="EmbeddedMessage" data-message-id="99" data-peer-id="321"><span class="MessageMeta"><span class="message-time" title="Mar 25, 2026, 11:42:09">11:42</span></span></div>');
  });
  const message = (await enrichMessageMetadata(page, result())).messages[0];
  assert.equal(message.timestamp, null);
  assert.deepEqual(message.sender, { id: null, name: 'Native Sender' });
  assert.equal(message.replyTo, null);
  assert.equal(message.topic, null);
});

test('forwarded origin, bot/via and embedded preview names are not current authors', async t => {
  const page = await fixture(t);
  await page.evaluate(() => {
    const inner = document.querySelector('.content-inner');
    inner.classList.add('forwarded-message');
    inner.insertAdjacentHTML('beforeend', '<div class="EmbeddedMessage"><div class="message-title"><span class="sender-title">Other preview</span></div></div><span class="via-sender"><span class="sender-title">Bot</span></span>');
  });
  assert.equal((await enrichMessageMetadata(page, result())).messages[0].sender, null);
});

test('unread-mention marker proves true, its absence never proves false', async t => {
  const page = await fixture(t);
  assert.equal((await enrichMessageMetadata(page, result())).messages[0].mentioned, null);
  await page.evaluate(() => document.querySelector('.bottom-marker').setAttribute('data-has-unread-mention', 'true'));
  assert.equal((await enrichMessageMetadata(page, result())).messages[0].mentioned, true);
  await page.evaluate(() => { document.querySelector('.bottom-marker').removeAttribute('data-has-unread-mention'); document.querySelector('.Message').classList.add('has-unread-mention'); });
  assert.equal((await enrichMessageMetadata(page, result())).messages[0].mentioned, true);
});

test('shared album metadata is never assigned to individual members', async t => {
  const page = await fixture(t);
  await page.evaluate(() => document.querySelector('.bottom-marker').setAttribute('data-last-message-id', '9'));
  const message = (await enrichMessageMetadata(page, result())).messages[0];
  for (const [key, value] of Object.entries(unknown)) assert.deepEqual(message[key], value);
});

test('comments and single-message results use only their verified exact thread', async t => {
  const page = await fixture(t, { hash: '#444_50', headerPeer: '444', listKey: '444_50_thread' });
  const thread = { peerId: '444', rootMessageId: '50', openedFromVerifiedPost: true };
  const single = { channelPeerId: '321', source: 'official-web-dom', contentIsUntrusted: true, thread, message: { id: '7', displayTime: 'raw' } };
  assert.equal((await enrichMessageMetadata(page, single)).message.timestamp, '2026-03-25T08:42:09.000Z');
  const comments = { ...single, message: undefined, comments: [single.message] };
  assert.equal((await enrichMessageMetadata(page, comments)).comments[0].topic, null);
  await assert.rejects(enrichMessageMetadata(page, { ...single, message: { id: '50' } }), /^Error: READ_TARGET_CHANGED$/);
});

for (const [label, options] of [
  ['nonofficial origin', { origin: 'https://example.com/a/' }],
  ['wrong web app path', { origin: 'https://web.telegram.org/k/' }],
  ['wrong hash', { hash: '#999' }],
  ['wrong header peer', { headerPeer: '999' }],
  ['wrong list peer', { listKey: '999_-1_thread' }],
  ['wrong list thread', { listKey: '321_42_thread' }],
  ['legacy guessed main root zero', { listKey: '321_0_thread' }],
]) test(`fails closed on ${label}`, async t => {
  const page = await fixture(t, options);
  await assert.rejects(enrichMessageMetadata(page, result()), /^Error: READ_TARGET_CHANGED$/);
});

test('duplicate/missing target rows, duplicate headers/lists and navigation during native hover fail closed', async t => {
  const page = await fixture(t);
  for (const selector of ['.Message', '.MessageList', '.MiddleHeader']) {
    await page.evaluate(selector => { const node = document.querySelector(selector); const clone = node.cloneNode(true); clone.id = 'temporary-clone'; node.after(clone); }, selector);
    await assert.rejects(enrichMessageMetadata(page, result()), /^Error: READ_TARGET_CHANGED$/);
    await page.evaluate(() => document.querySelector('#temporary-clone').remove());
  }
  await assert.rejects(enrichMessageMetadata(page, result({ messages: [{ id: '9' }] })), /^Error: READ_TARGET_CHANGED$/);
  await page.evaluate(() => { const time = document.querySelector('.message-time'); time.removeAttribute('title'); time.addEventListener('mouseenter', () => { location.hash = '#999'; }); });
  await assert.rejects(enrichMessageMetadata(page, result()), /^Error: READ_TARGET_CHANGED$/);
});

test('exact native album-child retrieval keeps verified identity but never inherits parent metadata', async t => {
  const page = await fixture(t);
  await page.evaluate(() => {
    const row = document.querySelector('.Message');
    row.setAttribute('data-message-id', '41');
    row.insertAdjacentHTML('beforeend', '<div class="Album"><div class="album-item"><div class="media-inner" id="album-media-message-41">first</div></div><div class="album-item"><div class="media-inner" id="album-media-message-42">second</div></div></div>');
    Object.defineProperty(row.querySelector('.sender-title'), 'textContent', { get() { throw Error('ALBUM_PARENT_IS_NOT_CHILD_METADATA'); } });
  });
  const input = result({ messages: undefined, message: { id: '42', displayTime: 'raw album display retained', text: 'captured caption' } });
  const output = await enrichMessageMetadata(page, input);
  assert.deepEqual(output.message, { ...input.message, ...unknown });
});

test('album-child identity rejects duplicate parents, competing direct rows, preview targets and thread roots', async t => {
  const page = await fixture(t);
  await page.evaluate(() => {
    const row = document.querySelector('.Message');
    row.setAttribute('data-message-id', '41');
    row.insertAdjacentHTML('beforeend', '<div class="Album"><div class="album-item"><div class="media-inner" id="album-media-message-42">second</div></div></div>');
  });
  const input = result({ messages: undefined, message: { id: '42' } });
  for (const html of [
    '<div class="Message" data-message-id="43"><div id="album-media-message-42">duplicate tile</div></div>',
    '<div class="Message" data-message-id="42">competing direct message</div>',
  ]) {
    await page.evaluate(html => document.querySelector('.MessageList').insertAdjacentHTML('beforeend', `<div id="album-conflict">${html}</div>`), html);
    await assert.rejects(enrichMessageMetadata(page, input), /^Error: READ_TARGET_CHANGED$/);
    await page.evaluate(() => document.querySelector('#album-conflict').remove());
  }
  await page.evaluate(() => document.querySelector('.Album').classList.add('EmbeddedMessage'));
  await assert.rejects(enrichMessageMetadata(page, input), /^Error: READ_TARGET_CHANGED$/);
  await page.evaluate(() => {
    document.querySelector('.Album').classList.remove('EmbeddedMessage');
    location.hash = '#321_41';
    document.querySelector('.MessageList').setAttribute('data-list-key', '321_41_thread');
  });
  await assert.rejects(enrichMessageMetadata(page, { ...input, thread: { peerId: '321', rootMessageId: '41', openedFromVerifiedPost: true } }), /^Error: READ_TARGET_CHANGED$/);
});

test('validates public scope and IDs before entering the page', async () => {
  const page = { evaluate() { throw Error('MUST_NOT_EVALUATE'); } };
  for (const input of [result({ source: 'guess' }), result({ peerId: '0321' }), result({ contentIsUntrusted: false }), result({ messages: [{ id: '0' }] }), result({ messages: [{ id: '7' }, { id: '7' }] }), result({ thread: { peerId: '444', rootMessageId: '50', openedFromVerifiedPost: false } })]) {
    await assert.rejects(enrichMessageMetadata(page, input), /^Error: INVALID_READ_REQUEST$/);
  }
});

for (const [label, options] of [
  ['mismatched self header', { headerId: '888' }],
  ['negative self ID', { savedId: '-100777' }],
  ['silent failed native navigation', { noAction: true }],
  ['ambiguous Saved Messages targets', { duplicate: true }],
  ['navigation link instead of native callback', { link: true }],
  ['forum-search trigger instead of hamburger', { menuClass: 'main-menu forum-search-button' }],
]) test(`identity fails closed on ${label}`, async t => {
  const page = await fixture(t);
  await ownAccountUi(page, options);
  await assert.rejects(metadata.readAccountIdentity(page), /^Error: READ_FAILED$/);
});
