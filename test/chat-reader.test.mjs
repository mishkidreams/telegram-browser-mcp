import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createChatReader } from '../src/chat-reader.mjs';

async function fixture(t, { wrongUsername = false, wrongPeer = false, wrongProfilePeer = false, noLatest = false, flip = false, album = false, noProfile = false, bootOnlyDeepLink = false, forbidMessageText = false, peerId = '321' } = {}) {
  const browser = await chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const messages = Array.from({ length: 12 }, (_, i) => '<div class="Message" data-message-id="' + (i + 1) + '"><div class="text-content">synthetic-' + (i + 1) + '<span class="MessageMeta">META-EXCLUDE</span></div><span class="message-time" title="synthetic-time"></span>' + (album && i === 11 ? '<i data-last-message-id="99"></i>' : '') + '</div>').join('');
  let html = '<style>.MessageList{height:200px;overflow:auto}.Message{height:80px}#RightColumn[hidden]{display:none}</style><div id="LeftColumn">UNRELATED-SECRET</div><div id="MiddleColumn"><div class="MiddleHeader"><div class="chat-info-wrapper"><div class="Avatar" data-peer-id="' + (wrongPeer ? '999' : '321') + '"></div><div class="info">Chat</div></div></div><div class="MessageList" data-list-key="321_-1_thread">' + messages + (noLatest ? '' : '<div class="list-bottom-marker"></div>') + '</div>' + (flip ? '<button id="down"><i class="icon-arrow-down"></i></button>' : '') + '</div><div id="RightColumn" hidden><div class="ProfileInfo"><div class="Avatar" data-peer-id="' + (wrongProfilePeer ? '999' : '321') + '"></div></div><div class="ChatExtra"><div class="ListItem"><i class="icon-mention-filled"></i><span class="title">@' + (wrongUsername ? 'wrong_user' : 'allowed_user') + '</span></div></div></div><script>location.hash="321";document.querySelector(".chat-info-wrapper").onmouseup=()=>{' + (noProfile ? '' : 'document.querySelector("#RightColumn").hidden=false;') + '};' + (flip ? 'document.querySelector("#down").onclick=()=>{location.hash="999";document.querySelector("[data-peer-id]").dataset.peerId="999";};' : '') + 'Object.defineProperty(document.querySelector("#LeftColumn"),"textContent",{get(){throw Error("UNRELATED-CHAT-WAS-READ")}});</script>';
  html = html.replaceAll('321', peerId).replace('<div class="info">Chat</div>', '<div class="info"><span class="title">Native Telegram Name</span></div>');
  if (forbidMessageText) html = html.replace('</script>', 'const d=Object.getOwnPropertyDescriptor(Node.prototype,"textContent");Object.defineProperty(Node.prototype,"textContent",{get(){if(this.nodeType===1 && this.matches(".text-content"))throw Error("MESSAGE-TEXT-MUST-NOT-BE-READ");return d.get.call(this)},set:d.set});</script>');
  // The real harness has already loaded /a/. Initial-only deep-link parsing is
  // not rerun by a same-document hash navigation; a blank-page fixture hid this.
  const body = bootOnlyDeepLink ? html.replace('<script>', '<script>if(location.hash.startsWith("#?tgaddr=")){').replace('</script>', '}else{document.querySelector("#MiddleColumn").replaceChildren();}</script>') : html;
  await context.route('**/*', route => route.request().url().startsWith('https://web.telegram.org/a/') ? route.fulfill({ status: 200, contentType: 'text/html', body }) : route.abort());
  if (bootOnlyDeepLink) await page.goto('https://web.telegram.org/a/');
  return { page, reader: createChatReader(page, { allowedUsernames: ['allowed_user'], maxMessages: 5, timeoutMs: 1500 }) };
}

test('reader denies missing approval, bad usernames and oversized limits before navigation', async t => {
  const { page, reader } = await fixture(t);
  const denied = createChatReader(page);
  await assert.rejects(denied.latest({ username: 'allowed_user' }), /ACCESS_DENIED/);
  await assert.rejects(reader.latest({ username: 'another_user' }), /ACCESS_DENIED/);
  for (const username of ['allowed_user?start=evil', '../allowed_user', '', 'a']) await assert.rejects(reader.latest({ username }), /INVALID_READ_REQUEST/);
  for (const limit of [0, 6, 2.5, '5']) await assert.rejects(reader.latest({ username: 'allowed_user', limit }), /INVALID_READ_REQUEST/);
  assert.equal(page.url(), 'about:blank');
});

test('exact verified target returns only five newest texts, without sidebar or message metadata', async t => {
  const { reader } = await fixture(t);
  const result = await reader.latest({ username: '@ALLOWED_USER', limit: 5 });
  assert.equal(result.username, 'allowed_user');
  assert.equal(result.peerId, '321');
  assert.equal(result.newestSliceConfirmedByUi, true);
  assert.deepEqual(result.messages.map(m => m.id), ['8', '9', '10', '11', '12']);
  assert.deepEqual(result.messages.map(m => m.text), ['synthetic-8', 'synthetic-9', 'synthetic-10', 'synthetic-11', 'synthetic-12']);
  assert.equal(JSON.stringify(result).includes('META-EXCLUDE'), false);
  assert.equal(JSON.stringify(result).includes('UNRELATED-SECRET'), false);
});

test('an already-loaded client fully boots its initial-only username deep link', async t => {
  const { reader } = await fixture(t, { bootOnlyDeepLink: true });
  const result = await reader.latest({ username: 'allowed_user' });
  assert.deepEqual(result.messages.map(m => m.id), ['8', '9', '10', '11', '12']);
});

test('wrong profile username fails closed without message text', async t => {
  const { reader } = await fixture(t, { wrongUsername: true });
  await assert.rejects(reader.latest({ username: 'allowed_user' }), error => {
    assert.match(error.message, /READ_FAILED|TARGET_NOT_VERIFIED/);
    assert.equal(error.safeDiagnostics.stage, 'profile');
    assert.equal(error.safeDiagnostics.ui.exactProfileUsernamePresent, false);
    assert.equal(error.safeDiagnostics.ui.numericPeerHash, true);
    assert.doesNotMatch(JSON.stringify(error.safeDiagnostics), /synthetic-|UNRELATED|META-EXCLUDE|allowed_user|wrong_user/);
    return true;
  });
});
test('profile peer must match the header even when its username matches', async t => {
  const { reader } = await fixture(t, { wrongProfilePeer: true });
  await assert.rejects(reader.latest({ username: 'allowed_user' }), /READ_FAILED|TARGET_NOT_VERIFIED/);
});
test('header peer must equal the canonical selected-chat hash', async t => {
  const { reader } = await fixture(t, { wrongPeer: true });
  await assert.rejects(reader.latest({ username: 'allowed_user' }), /READ_FAILED|TARGET_NOT_VERIFIED/);
});
test('a rendered old slice is not passed off as the latest messages', async t => {
  const { reader } = await fixture(t, { noLatest: true });
  await assert.rejects(reader.latest({ username: 'allowed_user' }), /LATEST_NOT_CONFIRMED/);
});
test('target changing during navigation/scroll fails closed', async t => {
  const { reader } = await fixture(t, { noLatest: true, flip: true });
  await assert.rejects(reader.latest({ username: 'allowed_user' }), /READ_TARGET_CHANGED/);
});
test('album grouping stays one explicit group with media descriptors, rather than refusing the chat', async t => {
  const { reader } = await fixture(t, { album: true });
  const result = await reader.latest({ username: 'allowed_user' });
  assert.equal(result.messages.at(-1).omittedReason, 'ALBUM');
  assert.equal(result.messages.at(-1).lastGroupedMessageId, '99');
  assert.deepEqual(result.messages.at(-1).attachments, []);
});
test('an explicit immutable chat ID works without a username or profile prompt', async t => {
  const { page } = await fixture(t, { noProfile: true, wrongUsername: true });
  const reader = createChatReader(page, { allowedChatIds: ['321'], timeoutMs: 1500 });
  await assert.rejects(reader.latest({ chatId: '999' }), /ACCESS_DENIED/);
  assert.equal(page.url(), 'about:blank');
  const result = await reader.latest({ chatId: '321', limit: 1 });
  assert.equal(result.peerId, '321');
  assert.deepEqual(result.messages.map(m => m.text), ['synthetic-12']);
  await assert.rejects(reader.latest({ chatId: '999', username: 'allowed_user' }), /INVALID_READ_REQUEST/);
});

test('only an already-approved username resolves to a numeric ID without reading messages', async t => {
  const { page, reader } = await fixture(t, { forbidMessageText: true });
  await assert.rejects(reader.resolveUsername({ username: 'another_user' }), /ACCESS_DENIED/);
  assert.equal(page.url(), 'about:blank');
  // Setup must work with no message list at all, not just without text access.
  await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => document.querySelector('.MessageList')?.remove()));
  assert.deepEqual(await reader.resolveUsername({ username: 'https://t.me/allowed_user' }), { username: 'allowed_user', chatId: '321', source: 'official-web-dom', identityVerifiedByUi: true });
});

test('numeric approval cannot follow a different header or hash, nor accept numeric coercion', async t => {
  const { page } = await fixture(t, { forbidMessageText: true });
  const reader = createChatReader(page, { allowedChatIds: ['999'], timeoutMs: 500 });
  for (const chatId of [321, '0', '0321', '321_900', true]) await assert.rejects(reader.latest({ chatId }), /INVALID_READ_REQUEST/);
  assert.equal(page.url(), 'about:blank');
  await assert.rejects(reader.latest({ chatId: '999' }), /READ_FAILED|TARGET_NOT_VERIFIED/);
});

test('native title metadata is verified for user, group and channel IDs without reading any messages', async t => {
  for (const chatId of ['321', '-321', '-100321']) {
    const { page } = await fixture(t, { peerId: chatId, forbidMessageText: true, noProfile: true });
    const reader = createChatReader(page, { allowedChatIds: [chatId], timeoutMs: 1500 });
    assert.deepEqual(await reader.metadata({ chatId }), { chatId, displayName: 'Native Telegram Name' });
    await assert.rejects(reader.metadata({ chatId: '999' }), /ACCESS_DENIED/);
  }
});

test('normal chat reading supports a useful page while respecting a specifically configured smaller cap', async t => {
  const { page } = await fixture(t);
  const reader = createChatReader(page, { allowedChatIds: ['321'], timeoutMs: 1500 });
  const result = await reader.latest({ chatId: '321', limit: 12 });
  assert.equal(result.messages.length, 12);
  assert.equal(result.messages[0].id, '1');
  await assert.rejects(reader.latest({ chatId: '321', limit: 101 }), /INVALID_READ_REQUEST/);
});

test('an exact message can be read without depending on the latest slice or touching other UI', async t => {
  const { page } = await fixture(t);
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => document.querySelector('.MessageList')?.setAttribute('data-list-key', '321_-1_thread'));
  });
  const reader = createChatReader(page, { allowedChatIds: ['321'], timeoutMs: 1500 });
  const result = await reader.message({ chatId: '321', messageId: '3' });
  assert.equal(result.peerId, '321');
  assert.equal(result.message.id, '3');
  assert.equal(result.message.text, 'synthetic-3');
  assert.deepEqual(result.message.attachments, []);
  assert.equal(result.contentIsUntrusted, true);
  await assert.rejects(reader.message({ chatId: '999', messageId: '3' }), /ACCESS_DENIED/);
});

test('same reader serializes operations and never leaks a native error', async t => {
  const { reader } = await fixture(t);
  const first = reader.latest({ username: 'allowed_user' });
  await assert.rejects(reader.latest({ username: 'allowed_user' }), /^Error: READER_BUSY$/);
  await first;
});
