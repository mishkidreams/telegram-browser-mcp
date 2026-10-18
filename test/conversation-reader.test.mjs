import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createChatReader } from '../src/chat-reader.mjs';
import { createConversationReader } from '../src/conversation-reader.mjs';

async function fixture(t, options = {}) {
  const browser = await chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  const html = `<!doctype html><html lang="en-US"><style>.MessageList,.chat-list{height:240px;overflow:auto}.Message{height:40px}.chat-info-wrapper,.ChatInfo{height:40px}#TopicListHeader{height:50px}</style>
<div id="LeftColumn" class="forbidden">UNALLOWED-SIDEBAR</div><div id="MiddleColumn"></div><script>
const options=${JSON.stringify(options)};
const peer=options.forum?'-1000000000321':options.comments?'-100321':'321';
function row(id, prefix='message', forbidden=false) {
 const title=new Intl.DateTimeFormat('en-US',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(Date.UTC(2026,4,10,12,id)));
 return '<div class="Message '+(forbidden || options.forbidRows?'forbidden':'')+'" data-message-id="'+id+'"><div class="content-inner"><div class="text-content">'+prefix+'-'+id+'<span class="MessageMeta"><span class="message-time" title="'+((options.unknownTimestamp && id===30)||options.unknownTimestampId===id?'unknown':title)+'">12:00</span></span></div></div></div>';
}
function header(id) {return '<div class="MiddleHeader"><div class="chat-info-wrapper"><span class="Avatar" data-peer-id="'+id+'"></span><span class="title">Approved Chat</span></div></div>';}
function render() {
 const middle=document.querySelector('#MiddleColumn');
 const initial=location.hash;
 location.hash=peer;
 middle.innerHTML=header(options.wrongHeader?'999':peer)+'<div class="MessageList" data-list-key="'+(options.wrongList?peer+'_7_thread':peer+'_-1_thread')+'">'+Array.from({length:61},(_,i)=>row(i+1)).join('')+'<div class="list-bottom-marker"></div></div>';
 if(options.forum) {
  document.querySelector('#LeftColumn').className='';
  document.querySelector('#LeftColumn').innerHTML='<div><div id="TopicListHeader"><div class="ChatInfo"><div class="info"><h3 class="fullName">Approved Chat</h3></div></div></div><div class="chat-list custom-scroll"><div class="ListItem Chat chat-item-clickable"><a class="ListItem-button" href="#'+peer+'_7"><div class="info"><div class="title"><h3 class="fullName">Work</h3></div><span class="forbidden">UNRELATED-PREVIEW</span></div></a></div><div class="ListItem Chat chat-item-clickable"><a class="ListItem-button" href="#'+peer+'_8"><div class="info"><div class="title"><h3 class="fullName">Other</h3></div></div></a></div><div class="ListItem Chat chat-item-clickable forbidden"><a class="ListItem-button" href="#-100999_9">UNALLOWED-TOPIC</a></div></div></div>';
  if(options.topicVirtual) {
   const list=document.querySelector('#TopicListHeader').parentElement.querySelector('.chat-list');
   const entries=[...list.children];list.innerHTML='<div style="height:1200px"></div>';list.append(entries[0]);
   list.addEventListener('scroll',()=>{if(list.scrollTop>0 && !list.querySelector('[href$="_8"]'))list.append(entries[1]);});
  }
  const target=initial.startsWith('#?tgaddr=')?new URL(decodeURIComponent(initial.slice(9))):null;
  const topic=target?.searchParams.get('thread')||initial.match(/_(\\d+)$/)?.[1];
  if(topic) {
   location.hash=peer+'_'+topic;
   middle.innerHTML='<div class="MiddleHeader"><div class="chat-info-wrapper"><div class="ChatInfo"><i class="topic-header-icon"></i><div class="info"><h3 class="fullName">'+(options.wrongTopicHeader?'Other':topic==='7'?'Work':'Other')+'</h3></div></div></div></div><div class="MessageList" data-list-key="'+peer+'_'+(options.wrongTopicList?'8':topic)+'_thread">'+Array.from({length:40},(_,i)=>row(i+1,'topic'+topic)).join('')+'<div class="list-bottom-marker"></div></div>';
  }
 }
 if(options.comments) {
  middle.innerHTML=header(peer)+'<div class="MessageList" data-list-key="'+peer+'_-1_thread">'+row(62,'approved-post')+'<div class="CommentButton" role="button" data-cnt="40">Comments</div><div class="list-bottom-marker"></div></div>';
  const button=middle.querySelector('.CommentButton'); middle.querySelector('.Message').append(button);
  const profile=document.createElement('div'); profile.id='RightColumn';profile.hidden=true;profile.innerHTML='<div class="ProfileInfo"><span data-peer-id="'+peer+'"></span></div>';document.body.append(profile);
  middle.querySelector('.chat-info-wrapper').onmouseup=()=>profile.hidden=false;
  button.onclick=()=>{location.hash='-100999_900';middle.innerHTML='<div class="MiddleHeader"><h3>Comments</h3></div><div class="MessageList" data-list-key="-100999_900_thread"><div class="Message is-thread-top forbidden" data-message-id="900"><div class="text-content">EXCLUDE-THREAD-ROOT</div></div>'+Array.from({length:40},(_,i)=>row(901+i,'comment')).join('')+'<div class="list-bottom-marker"></div></div><div class="MessageList" style="display:none"><div class="Message forbidden" data-message-id="1"><div class="text-content">UNRELATED-GROUP-HISTORY</div></div></div>';};
 }
 if(options.virtual) {
  const list=middle.querySelector('.MessageList'); let start=27,end=33;
  function update(){list.innerHTML=Array.from({length:end-start+1},(_,i)=>row(start+i)).join('')+(end===61?'<div class="list-bottom-marker"></div>':'');list.scrollTop=20;}
  update(); list.addEventListener('scroll',()=>{if(list.scrollTop===0){start=Math.max(1,start-5);end=Math.min(61,start+6);update();}else if(list.scrollTop>=list.scrollHeight-list.clientHeight){end=Math.min(61,end+5);start=Math.max(1,end-6);update();}});
 }
 if(options.flip) setTimeout(()=>{location.hash='321_7';middle.querySelector('.MessageList').dataset.listKey='321_7_thread';},75);
}
render();
const original=Object.getOwnPropertyDescriptor(Node.prototype,'textContent');
Object.defineProperty(Node.prototype,'textContent',{get(){if(this.nodeType===1 && (this.matches('.forbidden') || this.querySelector('.forbidden')))throw Error('UNAPPROVED-TEXT-READ');return original.get.call(this)},set:original.set,configurable:true});
document.addEventListener('input',()=>{throw Error('COMPOSER-USED')});
</script></html>`;
  await context.route('**/*', route => route.request().url().startsWith('https://web.telegram.org/a/') ? route.fulfill({ status: 200, contentType: 'text/html', body: html }) : route.abort());
  const allowedChatIds = [options.forum ? '-1000000000321' : options.comments ? '-100321' : '321'];
  const baseReader = createChatReader(page, { allowedChatIds, timeoutMs: 2500 });
  return { page, baseReader, reader: createConversationReader(page, { baseReader, allowedChatIds, timeoutMs: 2500 }) };
}

test('a verified post grants context only inside its exact foreign discussion thread', async t => {
  const { reader } = await fixture(t, { comments: true });
  const result = await reader.context({ chatId: '-100321', postId: '62', messageId: '930', window: { before: 2, after: 2 } });
  assert.equal(result.peerId, '-100321');
  assert.equal(result.thread.peerId, '-100999');
  assert.equal(result.thread.rootMessageId, '900');
  assert.equal(result.thread.openedFromVerifiedPost, true);
  assert.deepEqual(result.messages.map(m => m.id), ['928', '929', '930', '931', '932']);
  assert.doesNotMatch(JSON.stringify(result), /EXCLUDE|UNRELATED/);
  await assert.rejects(reader.context({ chatId: '-100999', messageId: '930' }), /ACCESS_DENIED/);
});

test('topic context uses official privatepost anchoring and never merges the parent or another topic', async t => {
  const { reader, page } = await fixture(t, { forum: true });
  const result = await reader.context({ chatId: '-1000000000321', topicId: '7', messageId: '30', window: { before: 2, after: 2 } });
  assert.equal(result.topicId, '7');
  assert.equal(new URL(page.url()).hash, '#-1000000000321_7');
  assert.deepEqual(result.messages.map(m => m.id), ['28', '29', '30', '31', '32']);
  assert.ok(result.messages.every(m => m.text.startsWith('topic7-')));
  assert.equal(result.coverage.status, 'complete');
});

test('topic history binds the exact parent/topic hash and list, with an exclusive before cursor', async t => {
  const { reader, page } = await fixture(t, { forum: true });
  const result = await reader.topicHistory({ chatId: '-1000000000321', topicId: '7', before: '35', limit: 3 });
  assert.equal(result.peerId, '-1000000000321');
  assert.equal(result.topicId, '7');
  assert.equal(new URL(page.url()).hash, '#-1000000000321_7');
  assert.deepEqual(result.messages.map(m => m.id), ['32', '33', '34']);
  assert.deepEqual(result.messages.map(m => m.text), ['topic7-32', 'topic7-33', 'topic7-34']);
  assert.ok(result.messages.every(m => m.timestamp === null));
  assert.equal(result.historyComplete, false);
  assert.equal(result.coverage.status, 'partial');
});

test('native forum discovery returns only verified same-parent topic labels, never exhaustive coverage by assumption', async t => {
  const { reader } = await fixture(t, { forum: true });
  const result = await reader.topics({ chatId: '-1000000000321' });
  assert.equal(result.isForum, true);
  assert.deepEqual(result.topics, [{ id: '7', name: 'Work' }, { id: '8', name: 'Other' }]);
  assert.equal(result.completeByUi, false);
  assert.equal(result.coverage.status, 'partial');
  assert.doesNotMatch(JSON.stringify(result), /UNALLOWED|UNRELATED/);
});

test('forum enumeration scrolls the native topic list to discover virtualized labels', async t => {
  const { reader } = await fixture(t, { forum: true, topicVirtual: true });
  const result = await reader.topics({ chatId: '-1000000000321' });
  assert.deepEqual(result.topics, [{ id: '7', name: 'Work' }, { id: '8', name: 'Other' }]);
  assert.equal(result.completeByUi, false);
});

test('an unproven forum UI reports unavailable rather than inventing a non-forum classification', async t => {
  const { reader } = await fixture(t);
  const result = await reader.topics({ chatId: '321' });
  assert.equal(result.isForum, null);
  assert.deepEqual(result.topics, []);
  assert.equal(result.completeByUi, false);
  assert.equal(result.coverage.status, 'unavailable');
});

test('wrong topic labels or list identity fail closed before any message text is touched', async t => {
  for (const option of ['wrongTopicHeader', 'wrongTopicList']) {
    const { reader } = await fixture(t, { forum: true, forbidRows: true, [option]: true });
    await assert.rejects(reader.topicHistory({ chatId: '-1000000000321', topicId: '7', limit: 3 }), /TOPIC_UNAVAILABLE/);
  }
});

test('an unverified topic ID never grants traversal, including foreign-parent topic links', async t => {
  const { reader } = await fixture(t, { forum: true, forbidRows: true });
  await assert.rejects(reader.context({ chatId: '-1000000000321', topicId: '9', messageId: '30' }), /TOPIC_UNAVAILABLE/);
});

test('native scrolling accumulates both sides of a virtualized anchor without changing scope', async t => {
  const { reader } = await fixture(t, { virtual: true });
  const result = await reader.context({ chatId: '321', messageId: '30', window: { before: 8, after: 8 } });
  assert.deepEqual(result.messages.map(m => m.id), ['22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35', '36', '37', '38']);
  assert.equal(result.coverage.status, 'complete');
});

test('unknown timestamps remain explicitly partial and never become guessed minute windows', async t => {
  const { reader } = await fixture(t, { unknownTimestamp: true });
  const result = await reader.context({ chatId: '321', messageId: '30', window: { beforeMinutes: 2, afterMinutes: 2 } });
  assert.equal(result.anchor.timestamp, null);
  assert.equal(result.coverage.status, 'partial');
  assert.deepEqual(result.messages.map(m => m.id), ['30']);
  assert.match(result.coverage.stopReason, /UNKNOWN/);
});

test('one unknown neighboring timestamp keeps minute-window coverage partial and marks the uncertain member', async t => {
  const { reader } = await fixture(t, { unknownTimestampId: 29 });
  const result = await reader.context({ chatId: '321', messageId: '30', window: { beforeMinutes: 2, afterMinutes: 2 } });
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.unknownTimestamps, 1);
  assert.equal(result.messages.find(m => m.id === '29').windowMatch, 'unknown');
  assert.equal(result.messages.find(m => m.id === '29').timestamp, null);
});

test('requests are authorized and bounded before any navigation', async t => {
  const { reader, page } = await fixture(t);
  await assert.rejects(reader.context({ chatId: '999', messageId: '30' }), /ACCESS_DENIED/);
  await assert.rejects(reader.topics({ chatId: '999' }), /ACCESS_DENIED/);
  await assert.rejects(reader.topicHistory({ chatId: '999', topicId: '7' }), /ACCESS_DENIED/);
  await assert.rejects(reader.topicHistory({ chatId: '321', topicId: '7', before: '0' }), /INVALID_READ_REQUEST/);
  await assert.rejects(reader.topicHistory({ chatId: '321', topicId: '7', limit: 101 }), /INVALID_READ_REQUEST/);
  for (const window of [{ before: 101 }, { after: -1 }, { before: 1.5 }, { before: '2' }, {}, { before: 2, afterMinutes: 2 }, { beforeMinutes: Infinity }, { beforeMinutes: -1 }, { beforeMinutes: 1441 }]) {
    await assert.rejects(reader.context({ chatId: '321', messageId: '30', window }), /INVALID_READ_REQUEST/);
  }
  await assert.rejects(reader.context({ chatId: '321', messageId: '0' }), /INVALID_READ_REQUEST/);
  await assert.rejects(reader.context({ chatId: '321', messageId: '30', topicId: '7', postId: '8' }), /INVALID_READ_REQUEST/);
  assert.equal(page.url(), 'about:blank');
});

test('a changed topic route while context settles fails closed', async t => {
  const { reader } = await fixture(t, { flip: true });
  await assert.rejects(reader.context({ chatId: '321', messageId: '30' }), /READ_TARGET_CHANGED|READ_FAILED/);
});

test('zero counts return just the anchor; omitted counts default to 25 on each side', async t => {
  const { reader } = await fixture(t);
  const zero = await reader.context({ chatId: '321', messageId: '30', window: { before: 0, after: 0 }, includeReplyTo: false });
  assert.deepEqual(zero.messages.map(m => m.id), ['30']);
  assert.equal(zero.coverage.replyTo, 'not-requested');
  const standard = await reader.context({ chatId: '321', messageId: '30' });
  assert.equal(standard.messages.length, 51);
  assert.equal(standard.messages[0].id, '5');
  assert.equal(standard.messages.at(-1).id, '55');
});

test('time offsets select messages by normalized creation timestamps, not display-time guesses', async t => {
  const { reader } = await fixture(t);
  const result = await reader.context({ chatId: '321', messageId: '30', window: { beforeMinutes: 2, afterMinutes: 2 } });
  assert.equal(result.anchor.timestamp, '2026-05-10T12:30:00.000Z');
  assert.deepEqual(result.messages.map(m => m.id), ['28', '29', '30', '31', '32']);
  assert.equal(result.coverage.status, 'complete');
  assert.equal(result.coverage.stopReason, 'TIME_WINDOW');
});

test('count context returns the exact anchor and ordered neighbors only in its verified chat', async t => {
  const { reader } = await fixture(t);
  const result = await reader.context({ chatId: '321', messageId: '30', window: { before: 2, after: 2 } });
  assert.equal(result.peerId, '321');
  assert.equal(result.anchor.id, '30');
  assert.equal(result.anchor.text, 'message-30');
  assert.deepEqual(result.messages.map(m => m.id), ['28', '29', '30', '31', '32']);
  assert.equal(result.source, 'official-web-dom');
  assert.equal(result.contentIsUntrusted, true);
  assert.equal(result.coverage.status, 'complete');
  assert.doesNotMatch(JSON.stringify(result), /UNALLOWED|EXCLUDE/);
});
