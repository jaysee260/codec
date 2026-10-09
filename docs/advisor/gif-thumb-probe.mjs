#!/usr/bin/env node
/**
 * Advisor probe: what does this Synapse's /_matrix/media/v3/thumbnail return for an animated GIF?
 * Uploads a real multi-frame GIF as alice, then fetches the thumbnail with and without `animated=true`
 * (spec v1.11 query param) and the full /download, reporting content-type and frame count (GIF: count
 * of image descriptors 0x2C after the header; WebP: presence of an ANIM chunk). Logs out at the end.
 *   GIF=path/to/animated.gif node docs/advisor/gif-thumb-probe.mjs
 */
import { readFileSync } from 'node:fs';
const HS = process.env.HS_URL ?? 'http://127.0.0.1:8008';
const gif = readFileSync(process.env.GIF);
const j = async (method, path, tok, body, type = 'application/json') => {
  const r = await fetch(HS + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': type }, body: body && (type === 'application/json' ? JSON.stringify(body) : body) });
  return r.json();
};
const { access_token: tok } = await (await fetch(`${HS}/_matrix/client/v3/login`, { method: 'POST', body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: 'alice' }, password: 'password123', initial_device_display_name: 'advisor-gif-probe' }) })).json();
const version = await j('GET', '/_synapse/admin/v1/server_version', tok);
const { content_uri } = await j('POST', `/_matrix/media/v3/upload?filename=probe.gif`, tok, gif, 'image/gif');
const [server, id] = content_uri.replace('mxc://', '').split('/');
const frames = (buf, ct) => ct.includes('gif') ? [...buf.subarray(13)].filter((b, i, a) => b === 0x2c && a[i + 9] !== undefined).length : ct.includes('webp') ? (buf.includes(Buffer.from('ANIM')) ? 'ANIM chunk present' : 'no ANIM chunk') : 'n/a';
const probe = async (label, path) => { const r = await fetch(HS + path); const ct = r.headers.get('content-type') ?? ''; const buf = Buffer.from(await r.arrayBuffer()); console.log(`${label}: HTTP ${r.status} ${ct} ${buf.length} B, frames=${frames(buf, ct)}`); };
console.log('synapse', version.server_version, '| uploaded', content_uri, '| source gif frames =', frames(gif, 'gif'));
await probe('download              ', `/_matrix/media/v3/download/${server}/${id}`);
await probe('thumbnail (default)   ', `/_matrix/media/v3/thumbnail/${server}/${id}?width=200&height=200&method=scale`);
await probe('thumbnail animated=true', `/_matrix/media/v3/thumbnail/${server}/${id}?width=200&height=200&method=scale&animated=true`);
await j('POST', '/_matrix/client/v3/logout', tok);
