// Official Web A attachment DOM only; never arbitrary URL/file/browser access.
// Ajaxy/telegram-tt f67a40879a7d78c2683ec5a296cf55bc22417d56 Photo/Album/File/Document.
export async function inspectMediaDom({ phase, chatId, messageIds, messageId, attachmentIndex, maxBytes, downloadUrl, threadPeerId, threadRootId }) {
  const fail = code => ({ error: code });
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  if (location.origin !== 'https://web.telegram.org' || location.pathname !== '/a/') return fail('READ_TARGET_CHANGED');
  const threaded = threadPeerId !== undefined;
  if (location.hash !== (threaded ? `#${threadPeerId}_${threadRootId}` : '#' + chatId)) return fail('READ_TARGET_CHANGED');
  const lists = [...document.querySelectorAll('#MiddleColumn .MessageList')].filter(visible);
  if (lists.length !== 1 || lists[0].getAttribute('data-list-key') !== (threaded ? `${threadPeerId}_${threadRootId}_thread` : `${chatId}_-1_thread`)) return fail('READ_TARGET_CHANGED');
  if (!threaded) {
    const headers = [...document.querySelectorAll('#MiddleColumn .MiddleHeader .chat-info-wrapper')].filter(visible);
    if (headers.length !== 1) return fail('READ_TARGET_CHANGED');
    const peers = [...new Set([...headers[0].querySelectorAll('[data-peer-id]')].map(x => x.getAttribute('data-peer-id')))];
    if (peers.length !== 1 || peers[0] !== chatId) return fail('READ_TARGET_CHANGED');
  }
  const list = lists[0];
  const rows = [...list.querySelectorAll('.Message[data-message-id]')].filter(visible);
  const excluded = '.WebPage, .web-page, .LinkPreview, .EmbeddedMessage, .reply-preview, .message-reply';
  function collect(row) {
    const records = [];
    const candidates = [...row.querySelectorAll('.media-inner.interactive, .File.interactive')];
    const indices = new Map();
    for (const element of candidates) {
      if (element.closest(excluded) || element.closest('.Message') !== row || !visible(element)) continue;
      const member = element.closest('[id^="album-media-message-"]');
      const id = member ? /^album-media-message-([1-9]\d{0,19})$/.exec(member.id)?.[1] : row.getAttribute('data-message-id');
      if (!id || (threaded && id === threadRootId)) continue;
      const file = element.classList.contains('File');
      // Video/stickers are not silently returned as a photo. No playback clicks.
      const video = !file && !!element.querySelector('video, .icon-play, .VideoPlayer, .video-duration');
      if (!file && !video && !element.querySelector('img.full-media, canvas.thumbnail, .icon-download')) continue;
      const index = indices.get(id) ?? 0; indices.set(id, index + 1);
      const filename = file ? element.querySelector('.file-title')?.textContent?.trim().slice(0, 256) : undefined;
      records.push({ element, image: !file && !video ? element.querySelector(':scope > img.full-media') : null,
        descriptor: { index, kind: file ? 'file' : video ? 'video' : 'photo', messageId: id, ...(filename ? { filename } : {}) } });
    }
    return records;
  }
  if (phase === 'metadata') {
    const messages = [];
    for (const id of messageIds) {
      const matches = rows.filter(row => row.getAttribute('data-message-id') === id || [...row.querySelectorAll('[id^="album-media-message-"]')].some(member => member.id === 'album-media-message-' + id));
      if (matches.length !== 1 || (threaded && id === threadRootId)) return fail('MESSAGE_UNAVAILABLE');
      messages.push({ id, attachments: collect(matches[0]).filter(record => matches[0].getAttribute('data-message-id') === id || record.descriptor.messageId === id).map(record => record.descriptor) });
    }
    return { messages };
  }
  const records = rows.flatMap(collect).filter(record => record.descriptor.messageId === messageId && record.descriptor.index === attachmentIndex);
  if (records.length !== 1) return fail('ATTACHMENT_UNAVAILABLE');
  const record = records[0];
  const spoiler = record.element.querySelector('.media-spoiler');
  if (record.element.querySelector('.protector') || record.element.closest('.is-protected') || (visible(spoiler) && Number(getComputedStyle(spoiler).opacity) > 0.01)) return fail('MEDIA_UNSUPPORTED');
  if (record.descriptor.kind === 'video') return fail('MEDIA_UNSUPPORTED');
  if (phase === 'load-photo') {
    if (record.descriptor.kind !== 'photo') return fail('MEDIA_UNSUPPORTED');
    if (record.image?.complete && record.image.naturalWidth && record.image.currentSrc?.startsWith('blob:https://web.telegram.org/')) return { started: false };
    // A rendered overscan photo can still be outside Web A's loading observer.
    // Bring only this verified, unprotected photo into its native loading area.
    record.element.scrollIntoView({ block: 'center', behavior: 'instant' });
    // Wait for the native full-media blob; never click a thumbnail (which could
    // open a viewer). The caller rechecks scope on every blob poll.
    if (record.element.querySelector('.ProgressSpinner, .progress-spinner')) return { pending: true };
    if (!visible(record.element.querySelector('.icon-download'))) {
      if (!record.image?.currentSrc || record.image.currentSrc.startsWith('blob:https://web.telegram.org/')) return { pending: true };
      return fail('ATTACHMENT_UNAVAILABLE');
    }
    record.element.click();
    return { started: true };
  }
  if (phase === 'click-file') {
    if (record.descriptor.kind !== 'file') return fail('MEDIA_UNSUPPORTED');
    const container = record.element.querySelector('.file-icon-container');
    const icon = container?.querySelector('.action-icon.icon-download:not(.hidden)');
    if (!visible(icon) || record.element.querySelector('.ProgressSpinner, .progress-spinner, .icon-close:not(.hidden)')) return fail('ATTACHMENT_UNAVAILABLE');
    const sizeNode = record.element.querySelector('.file-subtitle')?.firstChild;
    const sizeText = sizeNode?.nodeType === Node.TEXT_NODE ? sizeNode.textContent : '';
    const size = /^\s*(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB|TB|Б|КБ|МБ|ГБ|ТБ)\s*$/i.exec(sizeText);
    if (!size) return fail('ATTACHMENT_SIZE_UNKNOWN');
    const units = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4, 'Б': 0, 'КБ': 1, 'МБ': 2, 'ГБ': 3, 'ТБ': 4 };
    const exponent = units[size[2].toUpperCase()];
    const upperBound = Math.ceil((Number(size[1].replace(',', '.')) + 0.1) * 1024 ** exponent);
    if (upperBound > maxBytes) return fail('DOWNLOAD_TOO_LARGE');
    container.click();
    return { ...record.descriptor };
  }
  if (phase !== 'blob') return fail('ATTACHMENT_UNAVAILABLE');
  const url = record.descriptor.kind === 'photo' ? record.image?.currentSrc : downloadUrl;
  if (typeof url !== 'string' || !url.startsWith('blob:https://web.telegram.org/')) return fail('ATTACHMENT_UNAVAILABLE');
  if (record.descriptor.kind === 'photo' && (!record.image.complete || !record.image.naturalWidth)) return fail('ATTACHMENT_UNAVAILABLE');
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) return fail('ATTACHMENT_UNAVAILABLE');
    const stream = response.body.getReader();
    const chunks = []; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await stream.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) { await stream.cancel(); return fail('DOWNLOAD_TOO_LARGE'); }
        chunks.push(value);
      }
    } finally { stream.releaseLock(); }
    if (!bytes) return fail('ATTACHMENT_UNAVAILABLE');
    const blob = new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
    // Recheck scope after asynchronous I/O; never return bytes from a changed page.
    const verified = await inspectMediaDom({ phase: 'metadata', chatId, messageIds: [messageId], threadPeerId, threadRootId });
    if (verified.error || !record.element.isConnected) return fail('READ_TARGET_CHANGED');
    return { ...record.descriptor, mimeType: blob.type, data: dataUrl.slice(dataUrl.indexOf(',') + 1), variant: record.descriptor.kind === 'photo' ? 'displayed' : 'original' };
  } catch { return fail('ATTACHMENT_UNAVAILABLE'); }
}

export async function enrichMedia(page, result) {
  const key = Array.isArray(result.messages) ? 'messages' : Array.isArray(result.comments) ? 'comments' : null;
  if (!key || !result[key].length) return result;
  const args = { phase: 'metadata', chatId: result.peerId ?? result.channelPeerId, messageIds: result[key].map(message => message.id),
    ...(result.thread ? { threadPeerId: result.thread.peerId, threadRootId: result.thread.rootMessageId } : {}) };
  const media = await page.evaluate(inspectMediaDom, args);
  if (media?.error || !media?.messages) throw new Error(media?.error ?? 'READ_TARGET_CHANGED');
  return { ...result, [key]: result[key].map(message => ({ ...message, attachments: media.messages.find(item => item.id === message.id)?.attachments ?? [] })) };
}
