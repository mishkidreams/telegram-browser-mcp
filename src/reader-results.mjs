// Internal egress whitelist. References identify data; current policy and DOM
// identity are always rechecked by the MCP server and browser reader.
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { ensurePrivateDirectory } from './local-storage.mjs';
import { normalizeMessageEvidence } from './message-metadata.mjs';
import { basename, dirname, join, resolve } from 'node:path';
const peer = '-?[1-9]\\d{0,19}';
const id = '[1-9]\\d{0,19}';
const messagePattern = new RegExp(`^tgm1:(${peer}):(${id})(?::(${id}))?$`);
const attachmentPattern = new RegExp(`^tga1:(${peer}):(${id}):(0|[1-9]\\d?)(?::(${id}))?$`);
const idPattern = new RegExp(`^${id}$`);
const peerPattern = new RegExp(`^${peer}$`);
const clean = text => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
const invalid = () => { throw new Error('READ_FAILED'); };

export function parseReference(value, attachment = false) {
  const match = typeof value === 'string' && (attachment ? attachmentPattern : messagePattern).exec(value);
  if (!match) throw new Error('INVALID_READ_REQUEST');
  const postId = match[attachment ? 4 : 3];
  if (postId && !match[1].startsWith('-100')) throw new Error('INVALID_READ_REQUEST');
  return { chatId: match[1], messageId: match[2], ...(attachment ? { attachmentIndex: Number(match[3]) } : {}), ...(postId ? { postId } : {}) };
}
export function messageReference({ chatId, messageId, postId }) {
  return `tgm1:${chatId}:${messageId}${postId ? ':' + postId : ''}`;
}
function attachmentReference(scope, index) {
  return `tga1:${scope.chatId}:${scope.messageId}:${index}${scope.postId ? ':' + scope.postId : ''}`;
}
export function safeFilename(value) {
  if (typeof value !== 'string') return 'attachment';
  let name = value.replaceAll('\\', '/').split('/').at(-1).replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/[\u202a-\u202e\u2066-\u2069]/g, '').replace(/[. ]+$/g, '').slice(0, 128);
  if (!name || name === '.' || name === '..') name = 'attachment';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
export function projectAttachments(value, scope, lastGroupedMessageId) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) invalid();
  const seen = new Set();
  return value.map(item => {
    if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index > 99 || !['photo', 'file', 'video', 'audio', 'unknown'].includes(item.kind)) invalid();
    const messageId = item.messageId === undefined ? scope.messageId : item.messageId;
    if (typeof messageId !== 'string' || !idPattern.test(messageId) || BigInt(messageId) < BigInt(scope.messageId) || BigInt(messageId) > BigInt(lastGroupedMessageId ?? scope.messageId)) invalid();
    const reference = attachmentReference({ ...scope, messageId }, item.index);
    if (seen.has(reference)) invalid();
    seen.add(reference);
    if (item.sizeBytes !== undefined && (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0)) invalid();
    if (item.filename !== undefined && typeof item.filename !== 'string') invalid();
    if (item.mimeType !== undefined && (typeof item.mimeType !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(item.mimeType) || item.mimeType.length > 128)) invalid();
    return { index: item.index, kind: item.kind, messageId, attachmentRef: reference,
      ...(item.filename !== undefined ? { filename: safeFilename(item.filename) } : {}),
      ...(item.mimeType !== undefined ? { mimeType: item.mimeType.toLowerCase() } : {}),
      ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}) };
  });
}
export function projectMessage(message, scope, full = false) {
  if (!message || typeof message.id !== 'string' || !idPattern.test(message.id) || typeof message.text !== 'string') invalid();
  if (message.lastGroupedMessageId !== undefined && (typeof message.lastGroupedMessageId !== 'string' || !idPattern.test(message.lastGroupedMessageId) || BigInt(message.lastGroupedMessageId) < BigInt(message.id))) invalid();
  const target = { ...scope, messageId: message.id };
  const evidence = ['timestamp', 'timeZone', 'timestampSource', 'sender', 'replyTo', 'topic', 'mentioned'].some(key => key in message) ? normalizeMessageEvidence(message) : {};
  const references = { messageRef: messageReference(target), attachments: projectAttachments(message.attachments, target, message.lastGroupedMessageId), ...evidence };
  if (message.omittedReason !== undefined) {
    if (message.omittedReason !== 'ALBUM' || message.text !== '' || !message.lastGroupedMessageId) invalid();
    return { id: message.id, text: '', nonTextOnly: true, omittedReason: 'ALBUM', lastGroupedMessageId: message.lastGroupedMessageId, ...references };
  }
  const text = clean(message.text);
  return { id: message.id, text: full ? text : text.slice(0, 4096), textTruncated: message.textTruncated === true || (!full && text.length > 4096), nonTextOnly: message.nonTextOnly === true,
    displayTime: typeof message.displayTime === 'string' ? clean(message.displayTime).slice(0, 256) : '', outgoing: message.outgoing === true,
    ...(message.lastGroupedMessageId ? { lastGroupedMessageId: message.lastGroupedMessageId } : {}), ...references };
}
export function projectThread(value) {
  if (!value || value.openedFromVerifiedPost !== true || typeof value.peerId !== 'string' || !peerPattern.test(value.peerId) || typeof value.rootMessageId !== 'string' || !idPattern.test(value.rootMessageId)) invalid();
  return { peerId: value.peerId, rootMessageId: value.rootMessageId, openedFromVerifiedPost: true };
}
export function budgetResult(result, operation, limit) {
  const budget = 16 * 1024;
  const key = Array.isArray(result.messages) ? 'messages' : Array.isArray(result.comments) ? 'comments' : Array.isArray(result.matches) ? 'matches' : null;
  if (key && key !== 'matches' && result[key].some((item, i, all) => i && BigInt(item.id) <= BigInt(all[i - 1].id))) invalid();
  result.stopReason = 'RENDERED_SLICE';
  const continuation = () => {
    if (key === 'messages') {
      result.nextBefore = result.messages[0]?.id ?? null;
      result.next = result.nextBefore ? { tool: 'get_history', arguments: { chatId: result.chatId, before: result.nextBefore, limit } } : null;
    }
  };
  continuation();
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > budget) {
    if (!key || result[key].length <= (key === 'comments' ? 0 : 1)) throw new Error('OUTPUT_TOO_LARGE');
    if (key === 'matches') result[key].pop();
    else result[key].shift();
    result.stopReason = 'OUTPUT_BUDGET';
    result.omittedByBudget = (result.omittedByBudget ?? 0) + 1;
    continuation();
  }
  return result;
}
// Sniff only bounded raster headers; never decode, execute or trust claimed MIME.
function rasterInfo(bytes) {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND') {
    return { mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 16 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    let offset = 2;
    while (offset + 4 < bytes.length && bytes[offset] === 0xff) {
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        return { mimeType: 'image/jpeg', width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  if (bytes.length >= 25 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) === bytes.length - 8 && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(16) <= bytes.length - 20) {
    const type = bytes.toString('ascii', 12, 16);
    if (type === 'VP8X' && bytes.length >= 30 && bytes.readUInt32LE(16) >= 10) return { mimeType: 'image/webp', width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    if (type === 'VP8L' && bytes[20] === 0x2f && bytes.readUInt32LE(16) >= 5) {
      const packed = bytes.readUInt32LE(21);
      return { mimeType: 'image/webp', width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    }
    if (type === 'VP8 ' && bytes.length >= 30 && bytes.readUInt32LE(16) >= 10 && bytes.subarray(23, 26).equals(Buffer.from('9d012a', 'hex'))) return { mimeType: 'image/webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return null;
}
export function projectAttachment(value, target, { mode, maxBytes }) {
  const thread = verifyScope(value, target);
  if (value.messageId !== target.messageId || value.attachmentIndex !== target.attachmentIndex || !['photo', 'file', 'video', 'audio', 'unknown'].includes(value.kind) || !['original', 'displayed'].includes(value.variant) || typeof value.data !== 'string') invalid();
  if (value.data.length > Math.ceil(maxBytes / 3) * 4) throw new Error('FILE_TOO_LARGE');
  if (!value.data.length || value.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) invalid();
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.length > maxBytes) throw new Error('FILE_TOO_LARGE');
  if (bytes.toString('base64') !== value.data) invalid();
  const viewing = mode === 'view' || (mode === 'auto' && value.kind === 'photo');
  const raster = rasterInfo(bytes);
  const mimeType = raster?.width && raster?.height ? raster.mimeType : 'application/octet-stream';
  if (viewing && (['video', 'audio'].includes(value.kind) || mimeType === 'application/octet-stream')) throw new Error('MEDIA_UNSUPPORTED');
  if (viewing && (bytes.length > 8 * 1024 * 1024 || raster.width * raster.height > 16 * 1024 * 1024)) throw new Error('FILE_TOO_LARGE');
  if (!viewing && value.variant !== 'original') throw new Error('ORIGINAL_UNAVAILABLE');
  return { bytes, viewing, data: value.data, metadata: { kind: value.kind, filename: safeFilename(value.filename), mimeType, size: bytes.length, variant: value.variant,
    sha256: createHash('sha256').update(bytes).digest('hex'), contentIsUntrusted: true,
    source: { type: 'official-web-dom', chatId: target.chatId, messageId: target.messageId, attachmentIndex: target.attachmentIndex,
      attachmentRef: attachmentReference(target, target.attachmentIndex), ...(target.postId ? { postId: target.postId, thread } : {}), observedAt: new Date().toISOString() } } };
}
async function checkedDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('EXPORT_UNSAFE');
  const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const absolute = resolve(path);
  if (normalized(await realpath(path)) !== normalized(join(await realpath(dirname(absolute)), basename(absolute)))) throw new Error('EXPORT_UNSAFE');
}
export async function saveAttachment(root, bytes, signal, { directory: configuredDirectory } = {}) {
  const privateDir = join(resolve(root), 'private'), directory = configuredDirectory ?? join(privateDir, 'exports');
  await checkedDirectory(root);
  await checkedDirectory(privateDir);
  if (configuredDirectory) await ensurePrivateDirectory(directory);
  else {
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  await checkedDirectory(directory);
  let lock;
  const lockPath = configuredDirectory ? directory + '.lock' : join(privateDir, 'exports.lock');
  try { lock = await open(lockPath, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw new Error('EXPORT_BUSY'); throw error; }
  let destination, file;
  try {
    let total = 0;
    const entries = await readdir(directory);
    if (entries.length >= 200) throw new Error('EXPORT_QUOTA_EXCEEDED');
    for (const name of entries) {
      const stat = await lstat(join(directory, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('EXPORT_UNSAFE');
      total += stat.size;
    }
    if (total + bytes.length > 256 * 1024 * 1024) throw new Error('EXPORT_QUOTA_EXCEEDED');
    if (signal?.aborted) throw new Error('READ_CANCELLED');
    destination = join(directory, randomBytes(24).toString('hex') + '.bin');
    file = await open(destination, 'wx', 0o600);
    await file.writeFile(bytes, { signal });
    await file.close(); file = undefined;
    await checkedDirectory(directory);
    if (signal?.aborted) throw new Error('READ_CANCELLED');
    return destination;
  } catch (error) {
    await file?.close().catch(() => {});
    if (destination) await rm(destination, { force: true }).catch(() => {});
    throw error;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
export function verifyScope(value, { chatId, postId }) {
  if (!value || value.peerId !== chatId || value.source !== 'official-web-dom' || value.contentIsUntrusted !== true || value.postId !== postId) invalid();
  if (postId) return projectThread(value.thread);
  if (value.thread !== undefined && value.thread !== null) invalid();
  return undefined;
}
