import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createChatReader } from '../src/chat-reader.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lH8AAAAASUVORK5CYII=';
async function fixture(t, { file = false, album = false, protectedPhoto = false, external = false, large = false, flip = false, wrongList = false, unknownSize = false, spoiler = false, lazy = false, deferred = false, intersection = false } = {}) {
  const browser = await chromium.launch({channel:'chromium',headless:true,chromiumSandbox:true});
  const close = () => browser.close();
  t.after(close);
  const context = await browser.newContext({acceptDownloads:false});
  const page = await context.newPage();
  const photo = id => `<div class="media-inner interactive"${album ? ` id="album-media-message-${id}"` : ''}>${deferred || intersection ? '<canvas class="thumbnail"></canvas>' : '<img class="full-media">'}${lazy ? '<i class="icon-download"></i>' : ''}${spoiler ? '<div class="media-spoiler" style="height:20px;width:20px"></div>' : ''}${protectedPhoto ? '<span class="protector"></span>' : ''}</div>`;
  const media = file ? `<div class="File interactive"><div class="file-icon-container"><i class="action-icon icon-download"></i></div><div class="file-title">../untrusted.txt</div><div class="file-subtitle">${unknownSize ? 'unknown' : large ? '999.9 MB' : '0.1 KB'}<span class="bullet">•</span><span>Untrusted timestamp metadata</span></div></div>` : album ? photo('41') + photo('42') + '<i data-last-message-id="42"></i>' : photo('41');
  const html = `<style>.MessageList{height:300px;overflow:auto}.Message{min-height:100px}.media-inner{height:30px;width:30px}.file-icon-container{height:30px;width:30px}.action-icon{display:block;height:15px;width:15px}</style>
<div id="LeftColumn">UNRELATED</div><div id="MiddleColumn"><div class="MiddleHeader"><div class="chat-info-wrapper"><i class="Avatar" data-peer-id="321"></i><span class="title">Native</span></div></div>
<div class="MessageList" data-list-key="${wrongList ? '999' : '321'}_-1_thread"><div class="Message" data-message-id="41"><div class="text-content">caption</div>${media}<div class="WebPage"><div class="media-inner interactive"><img class="full-media" src="https://example.invalid/EXTERNAL"></div></div></div>${intersection ? '<div style="height:1800px"></div>' : ''}<div class="list-bottom-marker"></div></div><div id="composer" contenteditable="true"></div></div>
<script>
location.hash='321';window.clicks=0;
for(const element of document.querySelectorAll('.media-inner'))element.onclick=()=>{window.clicks++;};
const data=Uint8Array.from(atob(${JSON.stringify(png)}),c=>c.charCodeAt(0));
for(const image of document.querySelectorAll('.media-inner img:not([src])')) {
  const load=()=>{image.src=${external ? "'https://example.invalid/EXTERNAL'" : "URL.createObjectURL(new Blob([data],{type:'image/png'}))"};};
  if(${lazy})image.closest('.media-inner').onclick=()=>{window.clicks++;load();};else load();
}
if(${deferred})setTimeout(()=>{const image=document.createElement('img');image.className='full-media';image.src=URL.createObjectURL(new Blob([data],{type:'image/png'}));document.querySelector('.media-inner').append(image);},800);
if(${intersection}){
  const list=document.querySelector('.MessageList'),media=list.querySelector('.media-inner');
  list.scrollTop=list.scrollHeight;
  window.initialPhotoOutsideLoadingRoot=media.getBoundingClientRect().bottom<list.getBoundingClientRect().top-500;
  const observer=new IntersectionObserver(entries=>{
    if(!entries.some(entry=>entry.target===media&&entry.isIntersecting))return;
    observer.disconnect();
    const spinner=document.createElement('div');spinner.className='media-loading';spinner.innerHTML='<div class="ProgressSpinner"><i class="icon-close"></i><canvas class="ProgressSpinner_canvas"></canvas></div>';media.append(spinner);
    ${flip ? "location.hash='999';" : ''}
    setTimeout(()=>{const image=document.createElement('img');image.className='full-media';image.src=URL.createObjectURL(new Blob([data],{type:'image/png'}));media.append(image);spinner.remove();},150);
  },{root:list,rootMargin:'500px'});
  observer.observe(media);
}
const control=document.querySelector('.file-icon-container');if(control)control.onclick=()=>{window.clicks++;${flip ? "location.hash='999';" : ''}const link=document.createElement('a');link.href=URL.createObjectURL(new Blob(['fixture file bytes'],{type:'text/plain'}));link.download='unsafe.txt';link.click();};
Object.defineProperty(document.querySelector('#LeftColumn'),'textContent',{get(){throw Error('SIDEBAR-READ')}});
document.querySelector('#composer').oninput=()=>{throw Error('COMPOSER-TOUCHED')};
</script>`;
  await context.route('**/*',route=>route.request().url().startsWith('https://web.telegram.org/a/')?route.fulfill({contentType:'text/html',body:html}):route.abort());
  return {page, reader:createChatReader(page,{allowedChatIds:['321'],timeoutMs:4000}), close};
}

test('photos have exact message references and return real bounded raster bytes, not a page screenshot',async t=>{
  const {reader}=await fixture(t);
  const result=await reader.latest({chatId:'321',limit:1});
  assert.deepEqual(result.messages[0].attachments,[{index:0,kind:'photo',messageId:'41'}]);
  const image=await reader.attachment({chatId:'321',messageId:'41',attachmentIndex:0});
  assert.equal(image.data,png);
  assert.equal(image.variant,'displayed');
  assert.equal(image.mimeType,'image/png');
  assert.equal(image.messageId,'41');
  assert.doesNotMatch(JSON.stringify(image),/blob:|UNRELATED|EXTERNAL/);
  await assert.rejects(reader.attachment({chatId:'321',messageId:'41',attachmentIndex:0,maxBytes:10}),/DOWNLOAD_TOO_LARGE/);
});

test('a native unloaded photo is loaded once without opening an unrelated viewer',async t=>{
  const {reader,page}=await fixture(t,{lazy:true});
  const image=await reader.attachment({chatId:'321',messageId:'41',attachmentIndex:0});
  assert.equal(image.data,png);
  assert.equal(await page.evaluate(()=>window.clicks),1);
});

test('automatic lazy photo loading waits for the native blob without clicking a thumbnail',async t=>{
  const {reader,page}=await fixture(t,{deferred:true});
  const image=await reader.attachment({chatId:'321',messageId:'41',attachmentIndex:0});
  assert.equal(image.data,png);
  assert.equal(await page.evaluate(()=>window.clicks),0);
});

test('an exact offscreen photo enters the native loading observer before its bytes are read',async t=>{
  const {reader,page}=await fixture(t,{intersection:true});
  const image=await reader.attachment({chatId:'321',messageId:'41',attachmentIndex:0});
  assert.equal(image.data,png);
  assert.equal(await page.evaluate(()=>window.initialPhotoOutsideLoadingRoot),true);
  assert.equal(await page.evaluate(()=>window.clicks),0);
});

test('a scope change during an offscreen photo native load fails closed without clicks',async t=>{
  const {reader,page}=await fixture(t,{intersection:true,flip:true});
  await assert.rejects(reader.attachment({chatId:'321',messageId:'41',attachmentIndex:0}),/READ_TARGET_CHANGED/);
  assert.equal(await page.evaluate(()=>window.initialPhotoOutsideLoadingRoot),true);
  assert.equal(await page.evaluate(()=>window.clicks),0);
});

test('protected or spoiler-covered offscreen photos are rejected before native loading is triggered',async t=>{
  for(const options of [{protectedPhoto:true},{spoiler:true}]){
    const {reader,page,close}=await fixture(t,{intersection:true,...options});
    try {
      await assert.rejects(reader.attachment({chatId:'321',messageId:'41',attachmentIndex:0}),/MEDIA_UNSUPPORTED/);
      assert.equal(await page.evaluate(()=>{
        const list=document.querySelector('.MessageList'),media=list.querySelector('.media-inner');
        return media.getBoundingClientRect().bottom<list.getBoundingClientRect().top-500;
      }),true);
      assert.equal(await page.evaluate(()=>window.clicks),0);
    } finally {
      await close();
    }
  }
});

test('album media retain individual message IDs and can be requested without guessing slots',async t=>{
  const {reader}=await fixture(t,{album:true});
  const result=await reader.latest({chatId:'321',limit:1});
  assert.equal(result.messages[0].lastGroupedMessageId,'42');
  assert.deepEqual(result.messages[0].attachments.map(item=>[item.messageId,item.index]),[['41',0],['42',0]]);
  const second=await reader.attachment({chatId:'321',messageId:'42',attachmentIndex:0});
  assert.equal(second.messageId,'42');assert.equal(second.data,png);
});

test('native file downloads never enable browser disk writes and return only bounded same-origin blob bytes',async t=>{
  const {reader,page}=await fixture(t,{file:true});
  const result=await reader.attachment({chatId:'321',messageId:'41',attachmentIndex:0});
  assert.equal(Buffer.from(result.data,'base64').toString(),'fixture file bytes');
  assert.equal(result.variant,'original');
  assert.equal(result.filename,'../untrusted.txt'); // sanitized at the MCP egress seam, not used as a path
  assert.equal(await page.evaluate(()=>window.clicks),1);
});

test('protected/external/missing/oversized/unknown-size attachments and changed scopes fail closed',async t=>{
  for(const options of [{protectedPhoto:true},{spoiler:true},{external:true},{file:true,large:true},{file:true,unknownSize:true},{file:true,flip:true},{wrongList:true}]){
    const {reader,close}=await fixture(t,options);
    try {
      await assert.rejects(reader.attachment({chatId:'321',messageId:'41',attachmentIndex:0}),/MEDIA_UNSUPPORTED|ATTACHMENT_UNAVAILABLE|DOWNLOAD_TOO_LARGE|ATTACHMENT_SIZE_UNKNOWN|READ_TARGET_CHANGED|CLIENT_CHANGED/);
    } finally {
      await close();
    }
  }
  const {reader,page}=await fixture(t);
  await assert.rejects(reader.attachment({chatId:'999',messageId:'41',attachmentIndex:0}),/ACCESS_DENIED/);
  assert.equal(page.url(),'about:blank');
  await assert.rejects(reader.attachment({chatId:'321',messageId:'41',attachmentIndex:99}),/ATTACHMENT_UNAVAILABLE/);
});
