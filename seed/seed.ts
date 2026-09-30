/**
 * Seed the local homeserver with the fixture dataset from docs/SEED_DATA.md.
 *
 *   npm run seed          -> node seed/seed.ts   (Node >= 22.6 strips the types natively)
 *   npm run seed:reset    -> wipe the homeserver and seed again
 *
 * Plain fetch against /_matrix/client/v3, no SDK. Idempotent guard: if #acme-hq:localhost already
 * resolves we print a hint and exit 0. Writes seed/seed-output.json (room ids + key event ids) for QA.
 *
 * Only type annotations are used (no enums, namespaces or parameter properties) so the file runs
 * under Node's built-in type stripping.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HS = (process.env.HS_URL ?? 'http://localhost:8008').replace(/\/+$/, '');
const SERVER = process.env.HS_SERVER_NAME ?? 'localhost';
const PASSWORD = 'password123';
const SEED_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(SEED_DIR, 'assets');
const OUTPUT_FILE = path.join(SEED_DIR, 'seed-output.json');
const V3 = '/_matrix/client/v3';
/** Room version 11: explicit creator power level (100). v12 makes creators "infinite" and rejects them in users. */
const ROOM_VERSION = '11';

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

class MatrixError extends Error {
  status: number;
  errcode: string;
  constructor(status: number, errcode: string, message: string) {
    super(message);
    this.status = status;
    this.errcode = errcode;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

interface ApiOptions {
  token?: string;
  body?: unknown;
  raw?: Uint8Array;
  contentType?: string;
  query?: Record<string, string>;
}

async function api<T = Json>(method: string, endpoint: string, opts: ApiOptions = {}): Promise<T> {
  const url = new URL(HS + endpoint);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 30; attempt++) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    let body: BodyInit | undefined;
    if (opts.raw) {
      headers['Content-Type'] = opts.contentType ?? 'application/octet-stream';
      body = opts.raw as unknown as BodyInit;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = { error: text };
    }
    if (res.status === 429) {
      const wait = Number(json.retry_after_ms ?? 1000);
      console.log(`  429 on ${method} ${endpoint}, waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      throw new MatrixError(
        res.status,
        String(json.errcode ?? 'M_UNKNOWN'),
        `${method} ${endpoint} -> ${res.status} ${String(json.error ?? text)}`,
      );
    }
    return json as T;
  }
  throw new Error(`Rate limited too many times: ${method} ${endpoint}`);
}

async function waitForHomeserver(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  let lastError = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${HS}/_matrix/client/versions`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await sleep(1000);
  }
  throw new Error(`Homeserver at ${HS} is not reachable (${lastError}). Run "npm run hs:up" first.`);
}

// ---------------------------------------------------------------------------
// PNG generation (RGBA, no dependencies) + a tiny 5x7 bitmap font for initials
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', new Uint8Array(deflateSync(raw))), pngChunk('IEND', new Uint8Array(0))];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const GLYPHS: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
};

type Rgb = [number, number, number];

/** Solid `bg` square with a white glyph (scaled bitmap letter) centred in it. */
function letterPng(size: number, bg: Rgb, letter: string, scale: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) px.set([bg[0], bg[1], bg[2], 255], i * 4);
  const glyph = GLYPHS[letter.toUpperCase()] ?? GLYPHS.A!;
  const gw = 5 * scale;
  const gh = 7 * scale;
  const ox = Math.floor((size - gw) / 2);
  const oy = Math.floor((size - gh) / 2);
  for (let gy = 0; gy < 7; gy++) {
    for (let gx = 0; gx < 5; gx++) {
      if (glyph[gy]![gx] !== '#') continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const x = ox + gx * scale + sx;
          const y = oy + gy * scale + sy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          px.set([255, 255, 255, 255], (y * size + x) * 4);
        }
      }
    }
  }
  return encodePng(size, size, px);
}

function ensureAsset(fileName: string, make: () => Uint8Array): Uint8Array {
  mkdirSync(ASSETS_DIR, { recursive: true });
  const file = path.join(ASSETS_DIR, fileName);
  if (!existsSync(file)) writeFileSync(file, make());
  return new Uint8Array(readFileSync(file));
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

interface UserSpec {
  localpart: string;
  displayName: string;
  color: Rgb;
}

interface Session {
  localpart: string;
  userId: string;
  token: string;
}

const USER_SPECS: UserSpec[] = [
  { localpart: 'alice', displayName: 'Alice Park', color: [0x58, 0x65, 0xf2] },
  { localpart: 'bob', displayName: 'Bob Ruiz', color: [0x23, 0xa5, 0x59] },
  { localpart: 'carol', displayName: 'Carol Nguyen', color: [0xf0, 0xb2, 0x32] },
  { localpart: 'dave', displayName: 'Dave Okafor', color: [0xeb, 0x45, 0x9e] },
];

async function login(localpart: string): Promise<Session> {
  const r = await api<{ user_id: string; access_token: string }>('POST', `${V3}/login`, {
    body: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: localpart },
      password: PASSWORD,
      initial_device_display_name: 'seed script',
    },
  });
  return { localpart, userId: r.user_id, token: r.access_token };
}

async function ensureUser(spec: UserSpec): Promise<Session> {
  let session: Session;
  try {
    const r = await api<{ user_id: string; access_token?: string }>('POST', `${V3}/register`, {
      body: {
        username: spec.localpart,
        password: PASSWORD,
        auth: { type: 'm.login.dummy' },
        initial_device_display_name: 'seed script',
        inhibit_login: false,
      },
    });
    session = r.access_token
      ? { localpart: spec.localpart, userId: r.user_id, token: r.access_token }
      : await login(spec.localpart);
    console.log(`  registered ${session.userId}`);
  } catch (e) {
    if (e instanceof MatrixError && e.errcode === 'M_USER_IN_USE') {
      session = await login(spec.localpart);
      console.log(`  exists     ${session.userId}`);
    } else {
      throw e;
    }
  }
  await api('PUT', `${V3}/profile/${enc(session.userId)}/displayname`, {
    token: session.token,
    body: { displayname: spec.displayName },
  });
  const png = ensureAsset(`avatar-${spec.localpart}.png`, () => letterPng(64, spec.color, spec.localpart[0]!, 6));
  const mxc = await upload(session, png, `avatar-${spec.localpart}.png`);
  await api('PUT', `${V3}/profile/${enc(session.userId)}/avatar_url`, { token: session.token, body: { avatar_url: mxc } });
  return session;
}

async function upload(s: Session, bytes: Uint8Array, filename: string, contentType = 'image/png'): Promise<string> {
  const r = await api<{ content_uri: string }>('POST', '/_matrix/media/v3/upload', {
    token: s.token,
    raw: bytes,
    contentType,
    query: { filename },
  });
  return r.content_uri;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

async function resolveAlias(alias: string, token?: string): Promise<string | null> {
  try {
    const r = await api<{ room_id: string }>('GET', `${V3}/directory/room/${enc(alias)}`, { token });
    return r.room_id;
  } catch (e) {
    if (e instanceof MatrixError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Alias state: "live" (alice is joined), "stale" (alias exists but the room is unusable, e.g. a createRoom
 * that failed after registering the alias - Synapse does that), or "missing".
 */
async function aliasState(alias: string, s: Session): Promise<'missing' | 'stale' | 'live'> {
  const roomId = await resolveAlias(alias, s.token);
  if (!roomId) return 'missing';
  try {
    const member = await api<{ membership?: string }>('GET', `${V3}/rooms/${enc(roomId)}/state/m.room.member/${enc(s.userId)}`, { token: s.token });
    return member.membership === 'join' ? 'live' : 'stale';
  } catch (e) {
    if (e instanceof MatrixError && (e.status === 404 || e.status === 403)) return 'stale';
    throw e;
  }
}

async function clearStaleAlias(alias: string, s: Session): Promise<void> {
  if ((await aliasState(alias, s)) !== 'stale') return;
  console.log(`  removing stale alias ${alias}`);
  await api('DELETE', `${V3}/directory/room/${enc(alias)}`, { token: s.token });
}

async function createRoom(s: Session, body: Json): Promise<string> {
  if (typeof body.room_alias_name === 'string') await clearStaleAlias(`#${body.room_alias_name}:${SERVER}`, s);
  const r = await api<{ room_id: string }>('POST', `${V3}/createRoom`, { token: s.token, body: { room_version: ROOM_VERSION, ...body } });
  return r.room_id;
}

async function join(s: Session, roomId: string): Promise<void> {
  await api('POST', `${V3}/join/${enc(roomId)}`, { token: s.token, body: {} });
}

async function sendState(s: Session, roomId: string, type: string, stateKey: string, content: Json): Promise<void> {
  await api('PUT', `${V3}/rooms/${enc(roomId)}/state/${enc(type)}/${enc(stateKey)}`, { token: s.token, body: content });
}

let txnCounter = 0;
const txnId = (): string => `seed-${Date.now()}-${txnCounter++}`;

async function sendEvent(s: Session, roomId: string, type: string, content: Json): Promise<string> {
  const r = await api<{ event_id: string }>('PUT', `${V3}/rooms/${enc(roomId)}/send/${enc(type)}/${txnId()}`, {
    token: s.token,
    body: content,
  });
  return r.event_id;
}

async function sendReceipt(s: Session, roomId: string, eventId: string): Promise<void> {
  await api('POST', `${V3}/rooms/${enc(roomId)}/receipt/m.read/${enc(eventId)}`, { token: s.token, body: {} });
}

async function getDirect(s: Session): Promise<Record<string, string[]>> {
  try {
    return await api<Record<string, string[]>>('GET', `${V3}/user/${enc(s.userId)}/account_data/m.direct`, { token: s.token });
  } catch (e) {
    if (e instanceof MatrixError && e.status === 404) return {};
    throw e;
  }
}

async function addDirect(s: Session, otherUserId: string, roomId: string): Promise<void> {
  const map = await getDirect(s);
  map[otherUserId] = Array.from(new Set([...(map[otherUserId] ?? []), roomId]));
  await api('PUT', `${V3}/user/${enc(s.userId)}/account_data/m.direct`, { token: s.token, body: map });
}

// ---------------------------------------------------------------------------
// Message scripts (docs/SEED_DATA.md)
// ---------------------------------------------------------------------------

const HTML = 'org.matrix.custom.html';

interface Step {
  who: string;
  body: string;
  html?: string;
  /** 1-based index of the message this replies to. */
  replyTo?: number;
  /** Reactions to add right after sending: [key, senders[]]. */
  reactions?: [string, string[]][];
  image?: boolean;
  /** Original (typo) body to send first; `body` is then sent as an m.replace. */
  editFrom?: string;
  mentions?: string[];
  /** Record the resulting event id under this key in seed-output.json. */
  key?: string;
  /** alice sends an m.read receipt for this message right after it (and any reactions). */
  receipt?: boolean;
}

const GENERAL: Step[] = [
  { who: 'alice', body: 'Welcome to Acme HQ! 🎉 This is our new home for company chat.', reactions: [['🎉', ['bob', 'carol', 'dave']]], key: 'general.first' },
  { who: 'alice', body: 'A few ground rules: #general for announcements, #random for everything else.' },
  { who: 'bob', body: 'Hey everyone 👋' },
  { who: 'carol', body: 'Hi! Excited to be here.' },
  { who: 'dave', body: 'o/' },
  { who: 'bob', body: 'Is this replacing email for internal stuff?', key: 'general.replyTarget' },
  { who: 'alice', body: 'Mostly, yes. Long-form docs still go in the wiki.', replyTo: 6, key: 'general.reply' },
  { who: 'carol', body: 'Reminder: the Q4 planning meeting is Thursday at 10am.', html: 'Reminder: the <strong>Q4 planning meeting</strong> is Thursday at 10am.', key: 'general.bold' },
  { who: 'dave', body: 'Will it be recorded?' },
  { who: 'carol', body: 'Yes, recording goes in the shared drive afterwards.' },
  { who: 'bob', body: 'Lunch today? Thinking tacos.', reactions: [['👍', ['alice', 'carol']]], key: 'general.reacted' },
  { who: 'alice', body: 'Tacos works. Noon?' },
  { who: 'bob', body: 'Noon it is.' },
  { who: 'dave', body: 'PSA: the VPN cert rotates tonight, you may need to reconnect tomorrow morning.', reactions: [['👀', ['bob']]] },
  { who: 'carol', body: 'Thanks for the heads up' },
  { who: 'alice', body: "Here's the new logo draft:" },
  { who: 'alice', body: 'acme-logo.png', image: true, key: 'general.image' },
  { who: 'bob', body: 'Looks great. Love the colors.', editFrom: 'Looks grate. Love the colors.', key: 'general.edited' },
  { who: 'carol', body: 'Can we get it as an SVG too?' },
  { who: 'alice', body: "Sure, I'll post it in #dev later." },
  { who: 'dave', body: 'Anyone else seeing slow builds this morning?' },
  { who: 'bob', body: 'Yeah, CI is backed up. Check https://status.example.com', html: 'Yeah, CI is backed up. Check <a href="https://status.example.com">https://status.example.com</a>', key: 'general.link' },
  { who: 'dave', body: 'Thanks' },
  { who: 'carol', body: 'New hire starting Monday: please say hi to Erin when she joins!' },
  { who: 'alice', body: 'Welcome in advance, Erin 👋' },
  { who: 'bob', body: 'Quick one: how do I mention someone here?' },
  { who: 'alice', body: 'Type @ and start typing their name.' },
  { who: 'bob', body: 'carol test 😄', html: `<a href="https://matrix.to/#/@carol:${SERVER}">carol</a> test 😄`, mentions: [`@carol:${SERVER}`], key: 'general.mention' },
  { who: 'carol', body: 'It works 🙂' },
  { who: 'dave', body: 'Snippet for the curious, our deploy command:' },
  { who: 'dave', body: 'npm run build && npm run deploy -- --env=prod', html: '<pre><code class="language-bash">npm run build &amp;&amp; npm run deploy -- --env=prod</code></pre>', key: 'general.code' },
  { who: 'alice', body: "Don't run that from your laptop please 😅" },
  { who: 'bob', body: 'Friday demo is at 3pm. Agenda: 1) new chat client 2) Q4 roadmap 3) AOB' },
  { who: 'carol', body: 'Will there be snacks?' },
  { who: 'bob', body: 'There will be snacks.', replyTo: 34 },
  { who: 'dave', body: '🍩' },
  { who: 'alice', body: 'Reminder to fill in your timesheets before EOD.' },
  { who: 'carol', body: 'Done ✅' },
  { who: 'dave', body: 'Done' },
  { who: 'bob', body: 'Done. Have a good weekend all!', key: 'general.last', receipt: true },
];

const RANDOM: Step[] = [
  { who: 'bob', body: 'Best pizza place near the office? Go.' },
  { who: 'carol', body: "Luigi's, no contest." },
  { who: 'dave', body: "Luigi's is overrated. Mario's." },
  { who: 'alice', body: 'You two settle this over lunch.' },
  { who: 'bob', body: "Settled: we're getting both.", receipt: true },
  { who: 'carol', body: 'Anyone want to do a board game night Thursday?' },
  { who: 'dave', body: 'In.' },
  { who: 'bob', body: 'In, if there are snacks.' },
];

const DEV: Step[] = [
  { who: 'dave', body: 'Build is green again.' },
  { who: 'bob', body: '🙌' },
  { who: 'alice', body: 'SVG logo is in the design repo under /brand.' },
  { who: 'dave', body: 'Bumping Node to 24 in CI this week, shout if that breaks anything.' },
  { who: 'bob', body: "Should be fine, we're already on 24 locally." },
  { who: 'alice', body: 'Ship it.', receipt: true },
];

const LOBBY: Step[] = [
  { who: 'dave', body: "Who's up for some co-op tonight?" },
  { who: 'bob', body: 'Me, after 8.', receipt: true },
  { who: 'dave', body: '8 works.' },
  { who: 'dave', body: 'Voice is still on the other app... until this thing gets voice 😉' },
];

const DM_ALICE_BOB: Step[] = [
  { who: 'bob', body: 'Hey, got a sec?' },
  { who: 'alice', body: "Sure, what's up?" },
  { who: 'bob', body: 'Can you review my PR before the demo?' },
  { who: 'alice', body: 'On it. Link?' },
  { who: 'bob', body: 'https://github.com/acme/chat/pull/42' },
  { who: 'alice', body: 'Looks good, left two comments.', receipt: true },
];

const DM_ALICE_CAROL: Step[] = [
  { who: 'carol', body: 'Are you joining the planning meeting?' },
  { who: 'alice', body: "Yes, I'll be there." },
  { who: 'carol', body: "Great, I'll add you to the invite." },
  { who: 'alice', body: 'Thanks!', receipt: true },
];

async function runScript(
  sessions: Record<string, Session>,
  roomId: string,
  steps: Step[],
  events: Record<string, string>,
  logoPng?: Uint8Array,
): Promise<void> {
  const ids: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const sender = sessions[step.who]!;
    let content: Json;
    if (step.image) {
      const bytes = logoPng ?? ensureAsset('acme-logo.png', () => letterPng(256, [0x58, 0x65, 0xf2], 'A', 24));
      const mxc = await upload(sender, bytes, 'acme-logo.png');
      content = { msgtype: 'm.image', body: step.body, url: mxc, info: { w: 256, h: 256, mimetype: 'image/png', size: bytes.length } };
    } else {
      content = { msgtype: 'm.text', body: step.editFrom ?? step.body };
      if (step.html && !step.editFrom) {
        content.format = HTML;
        content.formatted_body = step.html;
      }
      if (step.mentions) content['m.mentions'] = { user_ids: step.mentions };
      if (step.replyTo) content['m.relates_to'] = { 'm.in_reply_to': { event_id: ids[step.replyTo - 1] } };
    }
    const eventId = await sendEvent(sender, roomId, 'm.room.message', content);
    ids.push(eventId);
    if (step.key) events[step.key] = eventId;

    if (step.editFrom) {
      const newContent: Json = { msgtype: 'm.text', body: step.body };
      if (step.html) {
        newContent.format = HTML;
        newContent.formatted_body = step.html;
      }
      await sendEvent(sender, roomId, 'm.room.message', {
        msgtype: 'm.text',
        body: `* ${step.body}`,
        'm.new_content': newContent,
        'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
      });
    }
    for (const [key, senders] of step.reactions ?? []) {
      for (const who of senders) {
        await sendEvent(sessions[who]!, roomId, 'm.reaction', {
          'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },
        });
      }
    }
    if (step.receipt) await sendReceipt(sessions.alice!, roomId, eventId);
  }
  console.log(`  sent ${steps.length} messages`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface ChannelSpec {
  name: string;
  alias: string;
  topic: string;
  members: string[];
  order: string;
  script: Step[];
  key: string;
}

interface SpaceSpec {
  name: string;
  alias: string;
  topic: string;
  members: string[];
  key: string;
  channels: ChannelSpec[];
}

const SPACES: SpaceSpec[] = [
  {
    name: 'Acme HQ',
    alias: 'acme-hq',
    topic: 'Everything Acme',
    members: ['alice', 'bob', 'carol', 'dave'],
    key: 'acme-hq',
    channels: [
      { name: 'general', alias: 'general', topic: 'Company-wide chat. Be nice.', members: ['alice', 'bob', 'carol', 'dave'], order: '01', script: GENERAL, key: 'general' },
      { name: 'random', alias: 'random', topic: 'Off-topic, memes, lunch plans.', members: ['alice', 'bob', 'carol', 'dave'], order: '02', script: RANDOM, key: 'random' },
      { name: 'dev', alias: 'dev', topic: 'Engineering talk. Stack traces welcome.', members: ['alice', 'bob', 'dave'], order: '03', script: DEV, key: 'dev' },
    ],
  },
  {
    name: 'Gaming',
    alias: 'gaming',
    topic: 'After-hours squad',
    members: ['alice', 'bob', 'dave'],
    key: 'gaming',
    channels: [{ name: 'lobby', alias: 'lobby', topic: 'Find a squad.', members: ['alice', 'bob', 'dave'], order: '01', script: LOBBY, key: 'lobby' }],
  },
];

async function main(): Promise<void> {
  console.log(`Seeding ${HS} (server_name ${SERVER})`);
  await waitForHomeserver();

  console.log('Users');
  const sessions: Record<string, Session> = {};
  for (const spec of USER_SPECS) sessions[spec.localpart] = await ensureUser(spec);
  const alice = sessions.alice!;
  const bob = sessions.bob!;

  const state = await aliasState(`#acme-hq:${SERVER}`, alice);
  if (state === 'live') {
    console.log('already seeded - run npm run seed:reset');
    return;
  }
  if (state === 'stale') console.log('found a stale #acme-hq alias from a failed run; cleaning up');

  const powerLevels = { users: { [alice.userId]: 100, [bob.userId]: 50 } };
  const rooms: Record<string, string> = {};
  const events: Record<string, string> = {};

  for (const space of SPACES) {
    console.log(`Space ${space.name}`);
    const spaceId = await createRoom(alice, {
      name: space.name,
      room_alias_name: space.alias,
      topic: space.topic,
      preset: 'public_chat',
      visibility: 'public',
      creation_content: { type: 'm.space' },
      power_level_content_override: powerLevels,
    });
    rooms[space.key] = spaceId;
    for (const who of space.members) if (who !== 'alice') await join(sessions[who]!, spaceId);

    for (const channel of space.channels) {
      console.log(`Channel #${channel.name}`);
      const roomId = await createRoom(alice, {
        name: channel.name,
        room_alias_name: channel.alias,
        topic: channel.topic,
        preset: 'public_chat',
        visibility: 'public',
        power_level_content_override: powerLevels,
        initial_state: [{ type: 'm.space.parent', state_key: spaceId, content: { via: [SERVER], canonical: true } }],
      });
      rooms[channel.key] = roomId;
      await sendState(alice, spaceId, 'm.space.child', roomId, { via: [SERVER], order: channel.order });
      for (const who of channel.members) if (who !== 'alice') await join(sessions[who]!, roomId);
      await runScript(sessions, roomId, channel.script, events);
    }
  }

  const dms: { other: string; key: string; script: Step[] }[] = [
    { other: 'bob', key: 'dm-alice-bob', script: DM_ALICE_BOB },
    { other: 'carol', key: 'dm-alice-carol', script: DM_ALICE_CAROL },
  ];
  for (const dm of dms) {
    const other = sessions[dm.other]!;
    console.log(`DM alice <-> ${dm.other}`);
    const roomId = await createRoom(alice, { is_direct: true, preset: 'trusted_private_chat', invite: [other.userId] });
    await join(other, roomId);
    await addDirect(alice, other.userId, roomId);
    await addDirect(other, alice.userId, roomId);
    rooms[dm.key] = roomId;
    await runScript(sessions, roomId, dm.script, events);
  }

  const output = {
    users: Object.fromEntries(Object.entries(sessions).map(([k, s]) => [k, s.userId])),
    rooms,
    events,
  };
  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n');
  console.log(`Done. Wrote ${path.relative(process.cwd(), OUTPUT_FILE)}`);
}

main().catch((e: unknown) => {
  console.error('Seed failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
