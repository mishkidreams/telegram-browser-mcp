import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createChatReader } from '../src/chat-reader.mjs';

async function fixture(t, { wrongThreadKey = false, mainInsteadOfThread = false, flipThread = false, noComments = false, wrongUsername = false, withBreaks = false, olderPost = false } = {}) {
  const browser = await chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const comments = Array.from({ length: 7 }, (_, i) => `<div class="Message" data-message-id="${901 + i}"><div class="text-content">comment-${i + 1}${withBreaks && i === 6 ? '<br>continued' : ''}<span class="MessageMeta">EXCLUDE-META</span></div></div>`).join('');
  const key = wrongThreadKey ? '-100888_900_thread' : '-100999_900_thread';
  const hash = mainInsteadOfThread ? '-100999' : '-100999_900';
  const thread = `<div class="MiddleHeader"><h3>Comments</h3></div><div class="MessageList" data-list-key="${key}"><div class="Message is-thread-top" data-message-id="900"><div class="text-content">approved-post</div></div>${comments}<div class="list-bottom-marker"></div></div><div class="MessageList" style="display:none"><div class="Message" data-message-id="123"><div class="text-content forbidden">UNRELATED-GROUP-HISTORY</div></div></div><div contenteditable="true" id="composer"></div>`;
  const html = `<style>.MessageList{height:200px;overflow:auto}.Message{height:80px}#RightColumn[hidden]{display:none}</style><div id="LeftColumn" class="forbidden">UNRELATED-SIDEBAR</div><div id="MiddleColumn"><div class="MiddleHeader"><div class="chat-info-wrapper"><div data-peer-id="-100321"></div><div class="info">Channel</div></div></div><div class="MessageList" data-list-key="-100321_-1_thread"><div class="Message" data-message-id="61"><div class="text-content ${olderPost ? '' : 'forbidden'}">${olderPost ? 'older-approved-post' : 'UNAPPROVED-POST'}</div>${olderPost ? '<div class="CommentButton" role="button" data-cnt="7">Comments</div>' : ''}</div><div class="Message" data-message-id="62"><div class="text-content">approved-post<span class="MessageMeta">EXCLUDE-META</span></div><div class="CommentButton" role="button" data-cnt="${noComments ? 0 : 7}">Comments</div></div><div class="list-bottom-marker"></div></div></div><div id="RightColumn" hidden><div class="ProfileInfo"><div data-peer-id="-100321"></div></div><div class="ChatExtra"><div class="ListItem"><i class="icon-mention-filled"></i><span class="title">@${wrongUsername ? 'wrong_channel' : 'allowed_channel'}</span></div></div></div><script>
location.hash='-100321';
document.querySelector('.chat-info-wrapper').onmouseup=()=>document.querySelector('#RightColumn').hidden=false;
document.querySelector('.CommentButton').onclick=()=>{location.hash=${JSON.stringify(hash)};document.querySelector('#MiddleColumn').innerHTML=${JSON.stringify(thread)};${flipThread ? "setTimeout(()=>{location.hash='-100999_901'},100);" : ''}};
const descriptor=Object.getOwnPropertyDescriptor(Node.prototype,'textContent');
Object.defineProperty(Node.prototype,'textContent',{get(){if(this.nodeType===1 && (this.matches('.forbidden') || this.querySelector('.forbidden')))throw Error('UNAPPROVED-TEXT-READ');return descriptor.get.call(this);},set:descriptor.set,configurable:true});
document.addEventListener('input',()=>{throw Error('COMPOSER-WAS-USED')});
</script>`;
  await context.route('**/*', route => route.request().url().startsWith('https://web.telegram.org/a/') ? route.fulfill({ status: 200, contentType: 'text/html', body: html }) : route.abort());
  return { page, reader: createChatReader(page, { allowedUsernames: ['allowed_channel'], timeoutMs: 4000 }) };
}

test('one verified channel post opens only its comment thread and returns at most five newest comments', async t => {
  const { reader } = await fixture(t);
  const result = await reader.comments({ username: 'allowed_channel', limit: 5 });
  assert.equal(result.username, 'allowed_channel');
  assert.equal(result.post.id, '62');
  assert.equal(result.post.text, 'approved-post');
  assert.equal(result.channelPeerId, '-100321');
  assert.equal(result.thread.peerId, '-100999');
  assert.equal(result.thread.rootMessageId, '900');
  assert.equal(result.thread.openedFromVerifiedPost, true);
  assert.equal(result.newestSliceConfirmedByUi, true);
  assert.deepEqual(result.comments.map(m => m.id), ['903', '904', '905', '906', '907']);
  assert.deepEqual(result.comments.map(m => m.text), ['comment-3', 'comment-4', 'comment-5', 'comment-6', 'comment-7']);
  assert.doesNotMatch(JSON.stringify(result), /UNAPPROVED|UNRELATED|EXCLUDE-META/);
});

test('an explicit older post is selected exactly rather than substituted with a recent post', async t => {
  const { page } = await fixture(t, { olderPost: true });
  const reader = createChatReader(page, { allowedChatIds: ['-100321'], timeoutMs: 4000 });
  const result = await reader.comments({ chatId: '-100321', postId: '61', limit: 1 });
  assert.equal(result.post.id, '61');
  assert.equal(result.post.text, 'older-approved-post');
  assert.equal(result.thread.openedFromVerifiedPost, true);
});

test('a pinned numeric channel grants only its own post thread, never general group reads', async t => {
  const { page } = await fixture(t, { wrongUsername: true });
  const reader = createChatReader(page, { allowedChatIds: ['-100321'], timeoutMs: 4000 });
  const result = await reader.comments({ chatId: '-100321', limit: 1 });
  assert.equal(result.channelPeerId, '-100321');
  assert.equal(result.thread.peerId, '-100999');
  assert.deepEqual(result.comments.map(m => m.text), ['comment-7']);
  await assert.rejects(reader.latest({ chatId: '-100999' }), /ACCESS_DENIED/);
});

test('an exact comment stays bound to its authorized channel post, excluding the root and group history', async t => {
  const { page } = await fixture(t);
  const reader = createChatReader(page, { allowedChatIds: ['-100321'], timeoutMs: 4000 });
  const result = await reader.message({ chatId: '-100321', postId: '62', messageId: '901' });
  assert.equal(result.peerId, '-100321');
  assert.equal(result.postId, '62');
  assert.equal(result.message.id, '901');
  assert.equal(result.message.text, 'comment-1');
  assert.equal(result.thread.peerId, '-100999');
  assert.equal(result.thread.rootMessageId, '900');
  await assert.rejects(reader.message({ chatId: '-100321', postId: '62', messageId: '900' }), /MESSAGE_UNAVAILABLE/);
  await assert.rejects(reader.message({ chatId: '-100999', messageId: '901' }), /ACCESS_DENIED/);
});

test('comment text preserves displayed line breaks instead of concatenating words', async t => {
  const { reader } = await fixture(t, { withBreaks: true });
  const result = await reader.comments({ username: 'allowed_channel' });
  assert.equal(result.comments.at(-1).text, 'comment-7\ncontinued');
});

test('comment reads deny unapproved targets and oversized limits before navigation', async t => {
  const { page, reader } = await fixture(t);
  const denied = createChatReader(page);
  await assert.rejects(denied.comments({ username: 'allowed_channel' }), /ACCESS_DENIED/);
  await assert.rejects(reader.comments({ username: 'another_channel' }), /ACCESS_DENIED/);
  for (const limit of [0, 101, 1.5, '5']) await assert.rejects(reader.comments({ username: 'allowed_channel', limit }), /INVALID_READ_REQUEST/);
  assert.equal(page.url(), 'about:blank');
});

test('a thread URL cannot authorize a different list or whole linked-group history', async t => {
  const { reader } = await fixture(t, { wrongThreadKey: true });
  await assert.rejects(reader.comments({ username: 'allowed_channel' }), error => {
    assert.equal(error.safeDiagnostics.stage, 'thread-binding');
    assert.match(error.message, /READ_FAILED/);
    assert.doesNotMatch(JSON.stringify(error.safeDiagnostics), /comment-|approved-post|UNRELATED|allowed_channel/);
    return true;
  });
});

test('opening the linked group instead of a post thread fails closed', async t => {
  const { reader } = await fixture(t, { mainInsteadOfThread: true });
  await assert.rejects(reader.comments({ username: 'allowed_channel' }), /READ_FAILED/);
});

test('changing to another thread while settling fails closed', async t => {
  const { reader } = await fixture(t, { flipThread: true });
  await assert.rejects(reader.comments({ username: 'allowed_channel' }), /READ_TARGET_CHANGED/);
});

test('a zero comment counter returns only the one post without navigating to a group', async t => {
  const { page, reader } = await fixture(t, { noComments: true });
  const result = await reader.comments({ username: 'allowed_channel' });
  assert.equal(result.post.id, '62');
  assert.deepEqual(result.comments, []);
  assert.equal(result.commentsEmptyByUi, true);
  assert.equal(result.thread, null);
  assert.equal(new URL(page.url()).hash, '#-100321');
});
