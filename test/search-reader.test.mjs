import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createChatReader } from '../src/chat-reader.mjs';

async function fixture(t, { wrongScope = false, flip = false, empty = false, stuck = false } = {}) {
  const browser = await chromium.launch({ channel:'chromium', headless:true, chromiumSandbox:true });
  t.after(()=>browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const html = `<div id="LeftColumn">UNRELATED</div><div id="MiddleColumn"><div class="MiddleHeader"><div class="chat-info-wrapper"><i data-peer-id="321"></i><span class="title">Native name</span></div><div class="header-tools"><button id="search"><i class="icon-search"></i></button></div></div><div class="MessageList" data-list-key="321_-1_thread"></div><div contenteditable="true" id="composer"></div></div>
<div id="MiddleSearch" hidden><div><i data-peer-id="${wrongScope ? 999 : 321}"></i><div class="SearchInput"><input type="text"><div id="results" class="custom-scroll"></div></div></div></div>
<script>
location.hash='321';document.querySelector('#search').onmousedown=()=>document.querySelector('#MiddleSearch').hidden=false;
document.querySelector('input').oninput=()=>{document.querySelector('#results').innerHTML='<div class="Loading"></div>';setTimeout(()=>{${flip ? "location.hash='999';" : ''}${stuck ? '' : `document.querySelector('#results').innerHTML=${JSON.stringify(empty ? '<span class="hash-empty-64">No result</span>' : Array.from({length:7},(_,i)=>`<div class="MiddleSearchResult"><div class="Avatar"></div><div class="hashed-info"><div class="hashed-top"><div class="LastMessageMeta"><span class="time">time-${i}</span></div></div><div class="hash-txt-84" dir="auto">needle-${i}</div></div></div>`).join(''))};`}},250)};
document.querySelector('#composer').oninput=()=>{throw Error('COMPOSER-TOUCHED')};
Object.defineProperty(document.querySelector('#LeftColumn'),'textContent',{get(){throw Error('SIDEBAR-READ')}});
</script>`;
  await context.route('**/*', r=>r.request().url().startsWith('https://web.telegram.org/a/')?r.fulfill({contentType:'text/html',body:html}):r.abort());
  return {page,reader:createChatReader(page,{allowedChatIds:['321'],timeoutMs:3000})};
}

test('native chat search returns only bounded message previews, without touching composer/global search', async t=>{
 const {reader}=await fixture(t);
 const result=await reader.search({chatId:'321',query:'needle',limit:5});
 assert.deepEqual(result.matches.map(m=>m.preview),['needle-0','needle-1','needle-2','needle-3','needle-4']);
 assert.equal(result.scopeVerifiedByUi,true);
 assert.equal(result.resultsComplete,false);
 assert.equal(result.contentIsUntrusted,true);
});

test('wrong search scope or changing peer is rejected and a spinner is never an empty result', async t=>{
 for(const options of [{wrongScope:true},{flip:true},{stuck:true}]){
  const {reader}=await fixture(t,options);
  await assert.rejects(reader.search({chatId:'321',query:'needle'}),/SEARCH_SCOPE_CHANGED|SEARCH_NOT_READY/);
 }
});

test('empty native search is explicit; global hashtag/member modes and unapproved chats fail before input',async t=>{
 const {reader,page}=await fixture(t,{empty:true});
 for(const query of ['', '#global', 'from:person', 'a\ncompose']) await assert.rejects(reader.search({chatId:'321',query}),/INVALID_READ_REQUEST/);
 await assert.rejects(reader.search({chatId:'999',query:'needle'}),/ACCESS_DENIED/);
 assert.equal(page.url(),'about:blank');
 const result=await reader.search({chatId:'321',query:'needle'});
 assert.deepEqual(result.matches,[]);
 assert.equal(result.emptyByUi,true);
});
