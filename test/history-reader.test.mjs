import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createChatReader } from '../src/chat-reader.mjs';

async function fixture(t, { flip = false, wrongList = false, stuck = false, album = false, restoreMiddle = false, retryIntersection = false, virtualize = false } = {}) {
  const browser = await chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const html = `<style>.MessageList{height:200px;overflow:auto}.Message{height:80px}</style>
<div id="MiddleColumn"><div class="MiddleHeader"><div class="chat-info-wrapper"><div class="Avatar" data-peer-id="321"></div><span class="title">Native name</span></div></div><div class="MessageList" data-list-key="${wrongList ? '999' : '321'}_-1_thread"></div></div>
<script>
location.hash='321'; let oldest=21;
const list=document.querySelector('.MessageList');
const row=id=>'<div class="Message" data-message-id="'+id+'"><div class="text-content">history-'+id+'</div></div>';
list.innerHTML=Array.from({length:10},(_,i)=>row(21+i)).join('')+'<div class="list-bottom-marker"></div>';
${album ? "document.querySelector('[data-message-id=\"30\"]').insertAdjacentHTML('beforeend','<i data-last-message-id=\"32\"></i>');" : ''}
list.scrollTop=list.scrollHeight;
${retryIntersection ? `
const sentinel=document.createElement('div');sentinel.style.height='1px';list.prepend(sentinel);
let firstIntersection=true;
new IntersectionObserver(entries=>{
 if(!entries.some(entry=>entry.isIntersecting) || oldest<=1)return;
 // The native client can ignore a trigger during a viewport replacement.
 // Remaining at scrollTop=0 emits no second observer entry by itself.
 if(firstIntersection){firstIntersection=false;return;}
 oldest-=10;sentinel.insertAdjacentHTML('afterend',Array.from({length:10},(_,i)=>row(oldest+i)).join(''));list.scrollTop=800;
},{root:list,rootMargin:'500px 0px'}).observe(sentinel);
` : `list.onscroll=()=>{if(list.scrollTop<2 && oldest>1){${flip ? "location.hash='999';" : ''}${stuck ? '' : `oldest-=10;${virtualize ? "list.innerHTML=Array.from({length:10},(_,i)=>row(oldest+i)).join('');" : "list.insertAdjacentHTML('afterbegin',Array.from({length:10},(_,i)=>row(oldest+i)).join(''));"}list.scrollTop=800;`}}};`}
</script>`;
  let visits = 0;
  await context.route('**/*', r => {
    if (!r.request().url().startsWith('https://web.telegram.org/a/')) return r.abort();
    // Web A can restore a middle slice without its newest marker on reload.
    // Keeping the already verified cursor in the same live list avoids that
    // extra hydration cycle; the fixture never invents an end-of-history signal.
    const body = restoreMiddle && visits++ ? html.replace("+'<div class=\"list-bottom-marker\"></div>'", "+''") : html;
    return r.fulfill({ contentType: 'text/html', body });
  });
  return { page, reader: createChatReader(page, { allowedChatIds: ['321'], timeoutMs: retryIntersection ? 5000 : 3500 }) };
}

test('history pages are older, exclusive and nonoverlapping across a lazy-loaded boundary', async t => {
  const { reader } = await fixture(t);
  const first = await reader.history({ chatId: '321', limit: 5 });
  assert.deepEqual(first.messages.map(m => m.id), ['26','27','28','29','30']);
  assert.equal(first.nextBefore, '26');
  const second = await reader.history({ chatId: '321', before: first.nextBefore, limit: 5 });
  assert.deepEqual(second.messages.map(m => m.id), ['21','22','23','24','25']);
  const third = await reader.history({ chatId: '321', before: second.nextBefore, limit: 5 });
  assert.deepEqual(third.messages.map(m => m.text), ['history-16','history-17','history-18','history-19','history-20']);
  assert.equal(third.historyComplete, false);
});

test('a verified live cursor continues across lazy history without resetting into a restored middle slice', async t => {
  const { reader } = await fixture(t, { restoreMiddle: true });
  const latest = await reader.latest({ chatId: '321', limit: 5 });
  assert.deepEqual(latest.messages.map(message => message.id), ['26', '27', '28', '29', '30']);
  const first = await reader.history({ chatId: '321', before: latest.messages[0].id, limit: 5 });
  assert.deepEqual(first.messages.map(message => message.id), ['21', '22', '23', '24', '25']);
  const older = await reader.history({ chatId: '321', before: first.nextBefore, limit: 5 });
  assert.deepEqual(older.messages.map(message => message.id), ['16', '17', '18', '19', '20']);
});

test('an explicit older cursor can start in a freshly restored verified middle slice without demanding newest UI', async t => {
  const { reader, page } = await fixture(t, { restoreMiddle: true });
  await reader.latest({ chatId: '321', limit: 5 });
  await page.goto('about:blank');
  await page.goto('https://web.telegram.org/a/#321');
  assert.equal(await page.locator('.list-bottom-marker').count(), 0);
  const freshReader = createChatReader(page, { allowedChatIds: ['321'], timeoutMs: 3500 });
  const result = await freshReader.history({ chatId: '321', before: '26', limit: 5 });
  assert.deepEqual(result.messages.map(message => message.id), ['21', '22', '23', '24', '25']);
});

test('live-window reuse never reads a substituted root list or skips a newer exclusive range', async t => {
  const { reader, page } = await fixture(t);
  await reader.latest({ chatId: '321', limit: 5 });
  await page.evaluate(() => {
    for (const row of document.querySelectorAll('.Message')) row.dataset.messageId = String(Number(row.dataset.messageId) - 10);
  });
  const result = await reader.history({ chatId: '321', before: '26', limit: 5 });
  assert.deepEqual(result.messages.map(message => message.id), ['21', '22', '23', '24', '25']);
  await page.evaluate(() => {
    document.querySelector('.MessageList').dataset.listKey = '321_7_thread';
    for (const row of document.querySelectorAll('.Message')) row.classList.add('forbidden');
  });
  await assert.rejects(reader.history({ chatId: '321', before: result.nextBefore, limit: 5 }), /CLIENT_CHANGED/);
});

test('an ignored native loading intersection is rearmed without navigating away or looping forever', async t => {
  const { reader } = await fixture(t, { restoreMiddle: true, retryIntersection: true });
  await reader.latest({ chatId: '321', limit: 5 });
  const result = await reader.history({ chatId: '321', before: '21', limit: 5 });
  assert.deepEqual(result.messages.map(message => message.id), ['16', '17', '18', '19', '20']);
});

test('exact media-anchor lookup survives an ignored native history load instead of declaring it unavailable after two seconds', async t => {
  const { reader } = await fixture(t, { retryIntersection: true });
  const result = await reader.message({ chatId: '321', messageId: '16' });
  assert.equal(result.message.id, '16');
  assert.equal(result.message.text, 'history-16');
});

test('history retains the nearest observed rows when native virtualization replaces them before the page fills', async t => {
  const { reader } = await fixture(t, { virtualize: true });
  await reader.latest({ chatId: '321', limit: 5 });
  const result = await reader.history({ chatId: '321', before: '26', limit: 10 });
  assert.deepEqual(result.messages.map(message => message.id), ['16', '17', '18', '19', '20', '21', '22', '23', '24', '25']);
  assert.deepEqual(result.messages.map(message => message.text), Array.from({ length: 10 }, (_, index) => 'history-' + (index + 16)));
  assert.ok(result.messages.every(message => 'timestamp' in message && Array.isArray(message.attachments)));
  assert.equal(result.nextBefore, '16');
});

test('history represents an album as an explicitly omitted group, without leaking its caption', async t => {
 const {reader} = await fixture(t,{album:true});
 const r=await reader.history({chatId:'321',limit:1});
 assert.equal(r.messages[0].id,'30');
 assert.equal(r.messages[0].text,'');
 assert.equal(r.messages[0].omittedReason,'ALBUM');
 assert.equal(r.messages[0].lastGroupedMessageId,'32');
});

test('history never substitutes another peer/list, coerces a cursor or returns a stalled latest page', async t => {
  for (const options of [{wrongList:true},{flip:true},{stuck:true}]) {
    const {reader} = await fixture(t, options);
    await assert.rejects(reader.history({chatId:'321',before:'21'}), /CLIENT_CHANGED|READ_TARGET_CHANGED|HISTORY_NOT_LOADED/);
  }
  const {page,reader} = await fixture(t);
  for(const before of [0, '0', '01', '4_5', true]) await assert.rejects(reader.history({chatId:'321',before}), /INVALID_READ_REQUEST/);
  await assert.rejects(reader.history({chatId:'999'}), /ACCESS_DENIED/);
  assert.equal(page.url(),'about:blank');
});
