#!/usr/bin/env node
/**
 * Post a voice message to a room through the client-server API (Phase 2, PRIN-5 verification; QA fixture;
 * demo prep: "a voice note bob sent"). Builds exactly the event shape in docs/archive/PHASE2_ACCEPTANCE.md.
 *
 *   npm run voice:sample                                 # bob -> #dev:localhost, 2.5 s generated WAV
 *   node scripts/send-voice-sample.mjs --as alice --room "#general:localhost" --seconds 4
 *   node scripts/send-voice-sample.mjs --file e2e/fixtures/test-voice.wav     # upload an existing file
 *   node scripts/send-voice-sample.mjs --room '!abc:localhost' --out seed/assets/voice-sample.wav --json out.json
 *
 * Without --file a 16 kHz mono 16-bit PCM WAV is generated (a short melody with pauses, so the waveform is not
 * flat). The waveform is computed from the PCM exactly like the client (peak amplitude per bucket, 100 buckets,
 * ints 0..1024). For non-WAV --file inputs (webm/ogg/m4a) Node cannot decode the audio, so a synthetic envelope
 * is used and the duration must be given with --duration-ms (default 3000).
 *
 * After sending, the event is fetched back and validated against the contract; the summary is printed as JSON
 * (and written to --json when given) so scripts/verify-phone-shell.mjs can round-trip it through getVoiceMessage.
 *
 * Environment: HS_URL (http://localhost:8008), PASSWORD (password123).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const HS = (process.env.HS_URL ?? 'http://localhost:8008').replace(/\/+$/, '');
const PASSWORD = process.env.PASSWORD ?? 'password123';
const WAVEFORM_SAMPLES = 100;

const args = process.argv.slice(2);
const value = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const user = value('--as', 'bob');
const roomArg = value('--room', '#dev:localhost');
const file = value('--file');
const seconds = Number(value('--seconds', '2.5'));
const outWav = value('--out');
const outJson = value('--json');
const durationOverride = value('--duration-ms');

// ---------------------------------------------------------------------------
// WAV generation + analysis (mirrors src/lib/audio/analysis.ts)
// ---------------------------------------------------------------------------

function generateWav(secs, sampleRate = 16000) {
  const total = Math.round(secs * sampleRate);
  const pcm = new Int16Array(total);
  // Notes (Hz) with gaps; amplitude envelope per note so the waveform shows distinct bumps.
  const notes = [440, 0, 523.25, 587.33, 0, 659.25, 0, 783.99, 659.25, 0, 523.25, 440];
  const noteLen = total / notes.length;
  for (let i = 0; i < total; i++) {
    const n = Math.min(notes.length - 1, Math.floor(i / noteLen));
    const f = notes[n];
    if (!f) continue;
    const t = i / sampleRate;
    const pos = (i - n * noteLen) / noteLen; // 0..1 within the note
    const env = Math.sin(Math.PI * pos) ** 0.6 * (0.35 + 0.45 * ((n * 7) % 5) / 4);
    const s = Math.sin(2 * Math.PI * f * t) * 0.7 + Math.sin(2 * Math.PI * f * 2 * t) * 0.2;
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(s * env * 32767)));
  }
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(pcm.buffer).copy(buf, 44);
  return buf;
}

/** Parse a 16-bit PCM WAV -> { samples: Float32Array (mono mix), sampleRate, durationMs }. */
function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12;
  let fmt;
  let data;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV without fmt/data chunks');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`only 16-bit PCM WAV is supported (got format ${fmt.format}, ${fmt.bits} bits)`);
  const frames = data.length / (2 * fmt.channels);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) acc += data.readInt16LE((i * fmt.channels + c) * 2) / 32768;
    samples[i] = acc / fmt.channels;
  }
  return { samples, sampleRate: fmt.sampleRate, durationMs: Math.round((frames / fmt.sampleRate) * 1000) };
}

/** Peak per bucket, normalised so the loudest bucket is 1024 (same as src/lib/audio computeWaveform). */
function waveformFromSamples(samples, buckets = WAVEFORM_SAMPLES) {
  const peaks = new Array(buckets).fill(0);
  const n = samples.length;
  let loudest = 0;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * n) / buckets);
    const end = Math.max(start + 1, Math.floor(((b + 1) * n) / buckets));
    let peak = 0;
    for (let i = start; i < end && i < n; i++) peak = Math.max(peak, Math.abs(samples[i]));
    peaks[b] = peak;
    loudest = Math.max(loudest, peak);
  }
  const scale = loudest > 0 ? 1 / loudest : 1;
  return peaks.map((p) => Math.round(Math.min(1, p * scale) * 1024));
}

function syntheticWaveform(buckets = WAVEFORM_SAMPLES) {
  return Array.from({ length: buckets }, (_, i) => Math.round(((Math.sin(i / 4) + 1) / 2) * 700 + 100));
}

function mimeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  return { '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.webm': 'audio/webm', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.mp3': 'audio/mpeg' }[ext] ?? 'application/octet-stream';
}
function extFor(mime) {
  return { 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/aac': 'm4a', 'audio/mpeg': 'mp3' }[mime] ?? 'bin';
}

// ---------------------------------------------------------------------------
// Matrix API (plain fetch, like seed/seed.ts)
// ---------------------------------------------------------------------------

async function api(method, endpoint, { token, body, raw, contentType, query } = {}) {
  const url = new URL(HS + endpoint);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 10; attempt++) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (raw) {
      headers['Content-Type'] = contentType ?? 'application/octet-stream';
      payload = raw;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers, body: payload });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text };
    }
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, Number(json.retry_after_ms ?? 1000)));
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${endpoint} -> ${res.status} ${json.errcode ?? ''} ${json.error ?? text}`);
    return json;
  }
  throw new Error(`${method} ${endpoint}: still rate limited`);
}

async function main() {
  // 1. audio bytes
  let bytes;
  let mimetype;
  let durationMs;
  let waveform;
  if (file) {
    bytes = readFileSync(file);
    mimetype = mimeFor(file);
    if (mimetype === 'audio/wav') {
      const wav = parseWav(bytes);
      durationMs = wav.durationMs;
      waveform = waveformFromSamples(wav.samples);
    } else {
      durationMs = Number(durationOverride ?? 3000);
      waveform = syntheticWaveform();
      console.log(`note: ${mimetype} cannot be decoded in Node; using --duration-ms ${durationMs} and a synthetic waveform`);
    }
  } else {
    bytes = generateWav(seconds);
    mimetype = 'audio/wav';
    const wav = parseWav(bytes);
    durationMs = wav.durationMs;
    waveform = waveformFromSamples(wav.samples);
    if (outWav) {
      mkdirSync(path.dirname(outWav), { recursive: true });
      writeFileSync(outWav, bytes);
      console.log(`wrote ${outWav} (${bytes.length} bytes, ${durationMs} ms)`);
    }
  }
  if (durationOverride && !file) durationMs = Number(durationOverride);
  const name = `Voice message.${extFor(mimetype)}`;

  // 2. login
  const login = await api('POST', '/_matrix/client/v3/login', {
    body: { type: 'm.login.password', identifier: { type: 'm.id.user', user }, password: PASSWORD, initial_device_display_name: 'send-voice-sample' },
  });
  const token = login.access_token;
  console.log(`logged in as ${login.user_id}`);

  // 3. room id
  let roomId = roomArg;
  if (roomArg.startsWith('#')) {
    const r = await api('GET', `/_matrix/client/v3/directory/room/${encodeURIComponent(roomArg)}`);
    roomId = r.room_id;
  }
  try {
    await api('POST', `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, { token, body: {} });
  } catch (e) {
    console.log(`join skipped: ${e.message}`);
  }

  // 4. upload
  const up = await api('POST', '/_matrix/media/v3/upload', { token, raw: bytes, contentType: mimetype, query: { filename: name } });
  const url = up.content_uri;
  console.log(`uploaded ${bytes.length} bytes as ${mimetype} -> ${url}`);

  // 5. send (contract shape)
  const content = {
    msgtype: 'm.audio',
    body: 'Voice message',
    url,
    info: { duration: durationMs, mimetype, size: bytes.length },
    'org.matrix.msc1767.text': 'Voice message',
    'org.matrix.msc1767.file': { url, name, mimetype, size: bytes.length },
    'org.matrix.msc1767.audio': { duration: durationMs, waveform },
    'org.matrix.msc3245.voice': {},
  };
  const txn = `voice-${Date.now()}`;
  const sent = await api('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`, { token, body: content });
  console.log(`sent ${sent.event_id} to ${roomId}`);

  // 6. read back + validate
  const ev = await api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(sent.event_id)}`, { token });
  const c = ev.content;
  const checks = {
    msgtype: c.msgtype === 'm.audio',
    body: c.body === 'Voice message',
    url: typeof c.url === 'string' && c.url.startsWith('mxc://'),
    infoDuration: Number.isInteger(c.info?.duration) && c.info.duration === c['org.matrix.msc1767.audio']?.duration,
    infoMimetype: c.info?.mimetype === mimetype && !/;/.test(c.info.mimetype),
    infoSize: c.info?.size === bytes.length,
    text: c['org.matrix.msc1767.text'] === 'Voice message',
    fileUrl: c['org.matrix.msc1767.file']?.url === c.url,
    fileName: c['org.matrix.msc1767.file']?.name === name,
    waveform: Array.isArray(c['org.matrix.msc1767.audio']?.waveform) && c['org.matrix.msc1767.audio'].waveform.length >= 30 && c['org.matrix.msc1767.audio'].waveform.length <= 120 && c['org.matrix.msc1767.audio'].waveform.every((v) => Number.isInteger(v) && v >= 0 && v <= 1024) && c['org.matrix.msc1767.audio'].waveform.some((v) => v > 0),
    voiceKey: JSON.stringify(c['org.matrix.msc3245.voice']) === '{}',
  };
  const media = await fetch(`${HS}/_matrix/media/v3/download/${url.slice('mxc://'.length)}`);
  const back = Buffer.from(await media.arrayBuffer());
  checks.mediaBytes = back.length === bytes.length && back.equals(bytes);
  checks.mediaContentType = (media.headers.get('content-type') ?? '').startsWith(mimetype);
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);

  const summary = {
    ok: failed.length === 0,
    failedChecks: failed,
    sender: login.user_id,
    roomId,
    roomAlias: roomArg.startsWith('#') ? roomArg : undefined,
    eventId: sent.event_id,
    mxc: url,
    httpUrl: `${HS}/_matrix/media/v3/download/${url.slice('mxc://'.length)}`,
    mimetype,
    durationMs,
    size: bytes.length,
    waveformSamples: waveform.length,
    waveformMax: Math.max(...waveform),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (outJson) {
    mkdirSync(path.dirname(outJson), { recursive: true });
    writeFileSync(outJson, JSON.stringify({ ...summary, content: c }, null, 2));
    console.log(`wrote ${outJson}`);
  }
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
