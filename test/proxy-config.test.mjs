import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProxy } from '../src/proxy-config.mjs';

function rejects(value, code = 'INVALID_PROXY') {
  assert.throws(() => normalizeProxy(value), error => {
    assert.equal(error.constructor, Error);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('canonical HTTPS URL moves decoded credentials into separate Playwright fields', () => {
  assert.deepEqual(normalizeProxy('https://proxy-user:p%40ss%3A%2F%25+%20word@proxy.example:8443'), {
    server: 'https://proxy.example:8443', username: 'proxy-user', password: 'p@ss:/%+ word',
  });
  assert.deepEqual(normalizeProxy({ server: 'https://user:p%40ss%2B%20@example.invalid:443' }), {
    server: 'https://example.invalid', username: 'user', password: 'p@ss+ ',
  });
});

test('only explicit HTTP, HTTPS and SOCKS5 authorities are accepted without guessing provider formats', () => {
  for (const value of [
    'proxy.example:8080', 'proxy.example:8080:user:password',
    'http:proxy.example:8080', 'http:/proxy.example:8080', 'http:///proxy.example:8080',
    'ftp://proxy.example:21', 'socks4://proxy.example:1080', 'https://',
    'http://proxy.example:65536', 'http://proxy.example:', 'http://proxy.example:0',
    'socks5://proxy.example', ' http://proxy.example', 'http://proxy.example ',
    'http://proxy.example\\\\other', 'http://proxy.example/path',
    'http://proxy.example/./', 'http://proxy.example/path/..',
    'http://proxy.example?', 'http://proxy.example?key=value',
    'http://proxy.example#', 'http://proxy.example/#fragment',
  ]) rejects(value);
});

test('URL canonicalization preserves HTTPS, IPv6 and default HTTP ports without credentials', () => {
  assert.deepEqual(normalizeProxy('HTTP://PROXY.example:80/'), { server: 'http://proxy.example' });
  assert.deepEqual(normalizeProxy('https://proxy.example:443'), { server: 'https://proxy.example' });
  assert.deepEqual(normalizeProxy('https://[2001:0db8:0:0::1]:8443/'), { server: 'https://[2001:db8::1]:8443' });
  assert.deepEqual(normalizeProxy('http://[::1]:80'), { server: 'http://[::1]' });
  assert.deepEqual(normalizeProxy('socks5://[::1]:1080/'), { server: 'socks5://[::1]:1080' });
});

test('any SOCKS5 authentication is rejected, including empty or undefined supplied fields', () => {
  for (const value of [
    'socks5://user:password@proxy.example:1080', 'socks5://@proxy.example:1080',
    'socks5://:@proxy.example:1080', 'socks5://user@proxy.example:1080',
    'socks5://:password@proxy.example:1080',
    { server: 'socks5://proxy.example:1080', username: '' },
    { server: 'socks5://proxy.example:1080', password: '' },
    { server: 'socks5://proxy.example:1080', username: undefined },
    { server: 'socks5://proxy.example:1080', password: null },
  ]) rejects(value, 'SOCKS_AUTH_UNSUPPORTED');
});

test('inline credentials cannot be combined with any separate credential fields', () => {
  for (const server of ['http://user:password@proxy.example', 'https://@proxy.example', 'https://:@proxy.example']) {
    for (const credentials of [{ username: 'other' }, { password: 'other' }, { username: '' }, { password: '' }, { username: undefined }]) rejects({ server, ...credentials });
  }
  rejects('https://:@proxy.example');
});

test('inline credentials decode exactly once and preserve plus signs, spaces and Unicode', () => {
  assert.deepEqual(normalizeProxy('https://%20u+%252F%20:%20p+%2520%25%C3%A9%E2%80%83%20@proxy.example'), {
    server: 'https://proxy.example', username: ' u+%2F ', password: ' p+%20%é\u2003 ',
  });
  assert.deepEqual(normalizeProxy('https:// user : password @proxy.example'), {
    server: 'https://proxy.example', username: ' user ', password: ' password ',
  });
});

test('malformed percent escapes, controls and oversized values always fail with a safe error', () => {
  for (const credential of ['%', '%2', '%GG', '%FF', '%C0%AF', '%ED%A0%80', '%00', '%09', '%0A', '%0D', '%7F', '%C2%85']) {
    rejects(`https://${credential}:safe@proxy.example`);
    rejects(`https://safe:${credential}@proxy.example`);
  }
  for (const control of ['\u0000', '\t', '\n', '\r', '\u001f', '\u007f', '\u0085']) {
    rejects(`http://proxy${control}.example`);
    rejects(`https://user:pass${control}word@proxy.example`);
    rejects({ server: 'http://proxy.example', username: `u${control}` });
    rejects({ server: 'http://proxy.example', password: `p${control}` });
    rejects(control);
  }
  rejects('socks5://bad%ZZ:1080');
  rejects(`http://${'x'.repeat(8192)}`);
  rejects({ server: 'http://proxy.example', username: 'u'.repeat(2049) });
  rejects({ server: 'http://proxy.example', password: 'p'.repeat(2049) });
  rejects(`https://${'u'.repeat(2049)}:p@proxy.example`);
  rejects(`https://u:${'%70'.repeat(2049)}@proxy.example`);
  rejects(`https://u:${'x'.repeat(8192)}@proxy.example`);
  assert.equal(normalizeProxy({ server: 'http://proxy.example', username: 'u', password: 'p'.repeat(2048) }).password.length, 2048);
  assert.equal(normalizeProxy(`https://u:${'%70'.repeat(2048)}@proxy.example`).password.length, 2048);
});

test('missing proxy differs from invalid types and unsafe object shapes with fixed safe errors', () => {
  for (const value of [undefined, null, '', '   ', {}, { server: '' }]) rejects(value, 'PROXY_REQUIRED');
  for (const value of [
    false, 0, 1, [], ['http://proxy.example'], new URL('http://proxy.example'),
    { server: null }, { server: 8080 }, { server: 'http://proxy.example', bypass: '' },
    { server: 'http://proxy.example', username: undefined },
    { server: 'http://proxy.example', password: 42 },
  ]) rejects(value);
  rejects({ server: 'http://proxy.example', [Symbol('extra')]: 'private' });
  rejects(Object.create({ server: 'http://proxy.example' }));
  rejects({ get server() { throw new Error('private-password'); } });
});

test('separate Playwright credentials remain literal, including whitespace and percent signs', () => {
  const input = Object.freeze({ server: 'https://PROXY.example:443/', username: ' user+%2F ', password: ' pass%ZZ+%20 ' });
  assert.deepEqual(normalizeProxy(input), {
    server: 'https://proxy.example', username: ' user+%2F ', password: ' pass%ZZ+%20 ',
  });
  rejects({ server: 'http://proxy.example:8080', username: '', password: '' });
  rejects({ server: 'http://proxy.example:8080', password: 'secret' });
  rejects('https://:secret@proxy.example');
  assert.deepEqual(normalizeProxy('https://user:@proxy.example'), { server: 'https://proxy.example', username: 'user', password: '' });
});
