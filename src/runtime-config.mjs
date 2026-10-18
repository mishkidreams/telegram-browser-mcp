// All user settings come from the MCP client's env entry, not hidden policy files.
import { homedir, tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, win32, posix } from 'node:path';
import { normalizeProxy } from './proxy-config.mjs';

const settings = new Set(['TG_ALLOWED_CHAT_IDS', 'TG_PROXY', 'TG_PROXY_USERNAME', 'TG_PROXY_PASSWORD', 'TG_BROWSER', 'TG_DATA_DIR', 'TG_PROFILE_DIR', 'TG_DOWNLOADS_DIR']);
// --config is an isolation boundary: omitted TG_* settings MUST use defaults,
// never accidental values inherited from another harness/project or the OS.
export function mcpEntryEnvironment(entry, inherited = process.env) {
  if (!entry || (entry.env !== undefined && (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)))) throw new Error('INVALID_CONFIGURATION');
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^TG_/i.test(key)));
  for (const [key, value] of Object.entries(entry.env ?? {})) {
    if (typeof value !== 'string') throw new Error('INVALID_CONFIGURATION');
    if (!/^TG_/i.test(key)) continue;
    if (!settings.has(key) || value.startsWith('!')) throw new Error('INVALID_CONFIGURATION');
    env[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      if (typeof inherited[name] !== 'string') throw new Error('INVALID_CONFIGURATION');
      return inherited[name];
    });
  }
  return env;
}

export function validateReaderPolicy(value) {
  if (!value || Object.keys(value).length !== 1 || !Array.isArray(value.allowedChatIds) || value.allowedChatIds.length < 1 || value.allowedChatIds.length > 1000 || value.allowedChatIds.some(id => typeof id !== 'string' || !/^-?[1-9]\d{0,19}$/.test(id))) throw new Error('READ_NOT_AUTHORIZED');
  return { allowedChatIds: [...new Set(value.allowedChatIds)] };
}
export function defaultPaths({ platform = process.platform, home = homedir(), temp = tmpdir(), env = process.env, uid = process.getuid?.() } = {}) {
  const path = platform === 'win32' ? win32 : posix;
  const dataDir = platform === 'win32' ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'telegram-browser-mcp')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'telegram-browser-mcp')
    : path.join(env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share'), 'telegram-browser-mcp');
  return { dataDir, downloadsDir: path.join(temp, `telegram-browser-mcp${platform === 'win32' || uid === undefined ? '' : '-' + uid}`, 'downloads') };
}
function directory(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw new Error('INVALID_CONFIGURATION');
  return value;
}
export function loadRuntimeConfig(env = process.env) {
  // OS-provided macOS temp/home aliases (e.g. /var -> /private/var) are
  // canonicalized once. User-supplied destination redirects remain rejected.
  const defaults = defaultPaths({ env, home: realpathSync(homedir()), temp: realpathSync(tmpdir()) });
  const dataDir = directory(env.TG_DATA_DIR, defaults.dataDir);
  const browser = env.TG_BROWSER ?? 'chromium';
  if (!['chromium', 'chrome'].includes(browser)) throw new Error('INVALID_CONFIGURATION');
  let allowedChatIds = [];
  if (env.TG_ALLOWED_CHAT_IDS !== undefined && env.TG_ALLOWED_CHAT_IDS !== '') {
    if (typeof env.TG_ALLOWED_CHAT_IDS !== 'string') throw new Error('READ_NOT_AUTHORIZED');
    allowedChatIds = validateReaderPolicy({ allowedChatIds: env.TG_ALLOWED_CHAT_IDS.split(',').map(id => id.trim()) }).allowedChatIds;
  }
  let proxy;
  if (env.TG_PROXY !== undefined || env.TG_PROXY_USERNAME !== undefined || env.TG_PROXY_PASSWORD !== undefined) {
    proxy = normalizeProxy({ server: env.TG_PROXY,
      ...(env.TG_PROXY_USERNAME !== undefined ? { username: env.TG_PROXY_USERNAME } : {}),
      ...(env.TG_PROXY_PASSWORD !== undefined ? { password: env.TG_PROXY_PASSWORD } : {}) });
  }
  return { dataDir, profileDir: directory(env.TG_PROFILE_DIR, join(dataDir, 'profile-' + browser)), downloadsDir: directory(env.TG_DOWNLOADS_DIR, defaults.downloadsDir), browser, proxy, allowedChatIds };
}
