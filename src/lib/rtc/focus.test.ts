/**
 * Phase 7: focus discovery parsers (well-known `rtc_foci`, `/rtc/transports`, overrides) and the discovery order.
 */
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearFocusCache, discoverFocus, focusFromOverride, parseFociFromTransports, parseFociFromWellKnown, parseFocus } from './focus.ts';
import { CallError } from './types.ts';

describe('focus parsers', () => {
  test('parseFocus accepts livekit foci with http(s) urls, trims trailing slashes, rejects the rest', () => {
    assert.deepEqual(parseFocus({ type: 'livekit', livekit_service_url: 'https://rtc.704.chat/' }), { type: 'livekit', livekit_service_url: 'https://rtc.704.chat' });
    assert.equal(parseFocus({ type: 'livekit', livekit_service_url: 'ws://x' }), null);
    assert.equal(parseFocus({ type: 'full_mesh' }), null);
    assert.equal(parseFocus(null), null);
  });

  test('parseFociFromWellKnown takes the first usable entry of org.matrix.msc4143.rtc_foci', () => {
    const doc = { 'm.homeserver': { base_url: 'http://localhost:8008/' }, 'org.matrix.msc4143.rtc_foci': [{ type: 'full_mesh' }, { type: 'livekit', livekit_service_url: 'http://localhost:7980' }] };
    assert.deepEqual(parseFociFromWellKnown(doc), { type: 'livekit', livekit_service_url: 'http://localhost:7980' });
    assert.equal(parseFociFromWellKnown({ 'm.homeserver': {} }), null);
    assert.equal(parseFociFromWellKnown('nope'), null);
  });

  test('parseFociFromTransports reads rtc_transports (and the older rtc_foci key)', () => {
    assert.deepEqual(parseFociFromTransports({ rtc_transports: [{ type: 'livekit', livekit_service_url: 'https://a' }] }), { type: 'livekit', livekit_service_url: 'https://a' });
    assert.deepEqual(parseFociFromTransports({ 'org.matrix.msc4143.rtc_foci': [{ type: 'livekit', livekit_service_url: 'https://b' }] }), { type: 'livekit', livekit_service_url: 'https://b' });
    assert.equal(parseFociFromTransports({ errcode: 'M_UNRECOGNIZED' }), null);
  });

  test('focusFromOverride adds http:// when no scheme was typed and ignores blanks', () => {
    assert.deepEqual(focusFromOverride(' 192.168.1.5:7980 '), { type: 'livekit', livekit_service_url: 'http://192.168.1.5:7980' });
    assert.equal(focusFromOverride(''), null);
    assert.equal(focusFromOverride(undefined), null);
  });
});

describe('discoverFocus', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearFocusCache();
  });

  const client = { baseUrl: 'http://hs.test/', getAccessToken: () => 'tok', getUserId: () => '@a:hs.test' };

  test('tries /rtc/transports with the token first, then the base-url well-known, and caches the answer', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${url}${init?.headers && 'Authorization' in (init.headers as Record<string, string>) ? ' +auth' : ''}`);
      if (url.endsWith('/rtc/transports')) return new Response(JSON.stringify({ errcode: 'M_UNRECOGNIZED' }), { status: 404 });
      if (url === 'http://hs.test/.well-known/matrix/client') return new Response(JSON.stringify({ 'org.matrix.msc4143.rtc_foci': [{ type: 'livekit', livekit_service_url: 'http://jwt.test' }] }));
      return new Response('', { status: 500 });
    }) as typeof fetch;
    const focus = await discoverFocus(client);
    assert.equal(focus.livekit_service_url, 'http://jwt.test');
    assert.deepEqual(calls, ['http://hs.test/_matrix/client/unstable/org.matrix.msc4143/rtc/transports +auth', 'http://hs.test/.well-known/matrix/client']);
    await discoverFocus(client);
    assert.equal(calls.length, 2, 'cached');
    await discoverFocus(client, { fresh: true });
    assert.equal(calls.length, 4, 'fresh re-discovers');
  });

  test('falls back to https://<server name>/.well-known for non-localhost servers and throws no-focus otherwise', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response('', { status: 404 });
    }) as typeof fetch;
    await assert.rejects(discoverFocus(client), (e: unknown) => e instanceof CallError && e.code === 'no-focus');
    assert.ok(seen.includes('https://hs.test/.well-known/matrix/client'));
    seen.length = 0;
    await assert.rejects(discoverFocus({ ...client, getUserId: () => '@a:localhost' }));
    assert.ok(!seen.some((u) => u.startsWith('https://localhost')), 'never probes https://localhost');
  });
});
