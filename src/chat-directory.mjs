// Private dated native-header observations, never permissions or custom aliases.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const TTL = 24 * 60 * 60_000;
const key = name => name.normalize('NFC').trim().toLowerCase();
export function nativeDisplayName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 256);
  return name || null;
}
export async function readChatDirectory(root, allowedChatIds) {
  let saved = [];
  try {
    const text = await readFile(join(root, 'private/chat-directory.json'), 'utf8');
    if (text.length > 1_000_000) throw new Error('INVALID_CACHE');
    const data = JSON.parse(text);
    if (data?.version !== 1 || !Array.isArray(data.chats) || data.chats.length > 1000) throw new Error('INVALID_CACHE');
    const seen = new Set();
    for (const item of data.chats) {
      if (!item || typeof item.chatId !== 'string' || seen.has(item.chatId) || !nativeDisplayName(item.displayName) || typeof item.observedAt !== 'string' || !Number.isFinite(Date.parse(item.observedAt)) || Date.parse(item.observedAt) > Date.now() + 60_000) throw new Error('INVALID_CACHE');
      seen.add(item.chatId);
    }
    saved = data.chats;
  } catch { /* No cache must never become an authority to browse by name. */ }
  return allowedChatIds.map(chatId => {
    const item = saved.find(x => x.chatId === chatId);
    const observedAt = item ? new Date(item.observedAt).toISOString() : null;
    return { chatId, displayName: item ? nativeDisplayName(item.displayName) : null, observedAt, stale: !observedAt || Date.now() - Date.parse(observedAt) > TTL };
  });
}
export async function rememberChat(root, allowedChatIds, { chatId, displayName }) {
  displayName = nativeDisplayName(displayName);
  if (!allowedChatIds.includes(chatId) || !displayName) return false;
  const chats = (await readChatDirectory(root, allowedChatIds)).filter(x => x.displayName && x.chatId !== chatId).map(({ chatId, displayName, observedAt }) => ({ chatId, displayName, observedAt }));
  chats.push({ chatId, displayName, observedAt: new Date().toISOString() });
  const path = join(root, 'private/chat-directory.json');
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, chats }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
  return true;
}
export async function resolveChatName(root, allowedChatIds, name) {
  const matches = (await readChatDirectory(root, allowedChatIds)).filter(x => x.displayName && key(x.displayName) === key(name));
  if (!matches.length) throw new Error('CHAT_NAME_NOT_FOUND');
  if (matches.length !== 1) throw new Error('CHAT_NAME_AMBIGUOUS');
  // The cached name always selects its original numeric ID, never a fresh
  // global Telegram search or a reassigned @username.
  return matches[0].chatId;
}
