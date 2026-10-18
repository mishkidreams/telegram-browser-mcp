const REQUIRED = Symbol('PROXY_REQUIRED');
const SOCKS_AUTH = Symbol('SOCKS_AUTH_UNSUPPORTED');
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_SERVER_LENGTH = 8192;
const MAX_CREDENTIAL_LENGTH = 2048;

/**
 * Accept an explicit http://, https:// or unauthenticated socks5:// URL, or a
 * plain { server, username?, password? } object. A trailing root slash is allowed;
 * paths, queries, fragments, unknown fields and mixed credential sources are not.
 * URL userinfo is percent-decoded once; separate credentials are already literal.
 * No trimming or form-style '+' conversion is applied to credentials.
 * Any HTTP(S) authentication requires a nonempty username, because Playwright
 * otherwise silently disables proxy auth. An empty password is supported.
 * Limits are 8192 UTF-16 code units for the supplied server URL and 2048 per
 * decoded/literal credential. HTTP(S) may omit a port; SOCKS5 requires one.
 * Throws only PROXY_REQUIRED, INVALID_PROXY or SOCKS_AUTH_UNSUPPORTED, never
 * parser details or user input. Normalization does not verify proxy reachability.
 *
 * @param {string | {server: string, username?: string, password?: string}} value
 * @returns {{server: string, username?: string, password?: string}}
 */
export function normalizeProxy(value) {
  try {
    if (value === undefined || value === null) throw REQUIRED;
    let input;
    if (typeof value === 'string') {
      input = { server: value };
    } else {
      if (typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('INVALID_PROXY');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(descriptors).some(key => !['server', 'username', 'password'].includes(key)) || Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) throw new Error('INVALID_PROXY');
      input = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
    }
    if (!Object.hasOwn(input, 'server')) throw REQUIRED;
    if (typeof input.server !== 'string' || input.server.length > MAX_SERVER_LENGTH || CONTROLS.test(input.server)) throw new Error('INVALID_PROXY');
    if (!input.server.trim()) throw REQUIRED;
    if (/%(?![\da-f]{2})/i.test(input.server)) throw new Error('INVALID_PROXY');
    // Inspect the original authority too: URL repairs slashes and dot-paths and
    // forgets empty query/fragment delimiters, which are not valid proxy config.
    const match = /^(https?|socks5):\/\/([^/?#\\]+)\/?$/i.exec(input.server);
    if (!match || input.server.trim() !== input.server || match[2].endsWith(':')) throw new Error('INVALID_PROXY');
    const url = new URL(input.server);
    if (!url.hostname || CONTROLS.test(decodeURIComponent(url.hostname)) || url.port === '0' || (url.protocol === 'socks5:' && !url.port)) throw new Error('INVALID_PROXY');
    const inlineAuth = match[2].includes('@');
    const separateAuth = ['username', 'password'].some(key => Object.hasOwn(input, key));
    if (url.protocol === 'socks5:' && (inlineAuth || separateAuth)) throw SOCKS_AUTH;
    if (inlineAuth && separateAuth) throw new Error('INVALID_PROXY');
    const result = { server: `${url.protocol}//${url.host}` };
    for (const key of ['username', 'password']) {
      if (!Object.hasOwn(input, key)) continue;
      if (typeof input[key] !== 'string') throw new Error('INVALID_PROXY');
      result[key] = input[key];
    }
    if (inlineAuth) {
      result.username = decodeURIComponent(url.username);
      result.password = decodeURIComponent(url.password);
    }
    for (const key of ['username', 'password']) {
      if (Object.hasOwn(result, key) && (result[key].length > MAX_CREDENTIAL_LENGTH || CONTROLS.test(result[key]))) throw new Error('INVALID_PROXY');
    }
    if ((inlineAuth || separateAuth) && !result.username) throw new Error('INVALID_PROXY');
    return result;
  } catch (error) {
    throw new Error(error === REQUIRED ? 'PROXY_REQUIRED' : error === SOCKS_AUTH ? 'SOCKS_AUTH_UNSUPPORTED' : 'INVALID_PROXY');
  }
}
