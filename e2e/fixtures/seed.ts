/**
 * Seed fixture contract (docs/SEED_DATA.md).
 *
 * Reads `seed/seed-output.json` for room ids, user ids and the 11 key event ids. Room ids are
 * also resolvable from the homeserver via the published alias
 * (`GET /_matrix/client/v3/directory/room/{alias}`), which is the fallback when the file is
 * missing, stale or was written by a different seed run.
 *
 * Tests must tolerate extra messages in seeded rooms (the devs post manually against the same
 * homeserver), so locate seeded events by event id from here and anything new by text.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_FILE = resolve(HERE, '../../seed/seed-output.json');

export const HS_URL = process.env.E2E_HS_URL ?? process.env.HS_URL ?? 'http://localhost:8008';
export const SERVER_NAME = 'localhost';
export const PASSWORD = 'password123';

export type UserKey = 'alice' | 'bob' | 'carol' | 'dave';

export type RoomKey =
  | 'acme-hq'
  | 'general'
  | 'random'
  | 'dev'
  | 'gaming'
  | 'lobby'
  | 'dm-alice-bob'
  | 'dm-alice-carol';

export type EventKey =
  | 'general.first'
  | 'general.last'
  | 'general.replyTarget'
  | 'general.reply'
  | 'general.bold'
  | 'general.reacted'
  | 'general.image'
  | 'general.edited'
  | 'general.link'
  | 'general.mention'
  | 'general.code';

interface SeedOutput {
  users: Record<string, string>;
  rooms: Record<string, string>;
  events: Record<string, string>;
}

/** Published alias per room key; DMs have none (they are private, alias-less). */
const ALIASES: Partial<Record<RoomKey, string>> = {
  'acme-hq': `#acme-hq:${SERVER_NAME}`,
  general: `#general:${SERVER_NAME}`,
  random: `#random:${SERVER_NAME}`,
  dev: `#dev:${SERVER_NAME}`,
  gaming: `#gaming:${SERVER_NAME}`,
  lobby: `#lobby:${SERVER_NAME}`,
};

function loadSeed(): SeedOutput {
  if (!existsSync(SEED_FILE)) {
    throw new Error(
      `seed/seed-output.json not found at ${SEED_FILE}. Run \`npm run seed\` against the homeserver first.`,
    );
  }
  const parsed = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as Partial<SeedOutput>;
  if (!parsed.rooms || !parsed.events || !parsed.users) {
    throw new Error(`seed/seed-output.json is malformed: expected { users, rooms, events }`);
  }
  return parsed as SeedOutput;
}

export const seed: SeedOutput = loadSeed();

/** User id for a seeded local part, e.g. `userId('bob') === '@bob:localhost'`. */
export function userId(key: UserKey): string {
  const id = seed.users[key] ?? `@${key}:${SERVER_NAME}`;
  return id;
}

/** Room id straight from the seed file. Throws when the key is absent (never returns ''). */
export function roomId(key: RoomKey): string {
  const id = seed.rooms[key];
  if (!id) {
    throw new Error(
      `seed-output.json has no room "${key}". Known keys: ${Object.keys(seed.rooms).join(', ')}`,
    );
  }
  return id;
}

/** Seeded event id. Throws when absent so a stale seed file fails loudly, not as a bad locator. */
export function eventId(key: EventKey): string {
  const id = seed.events[key];
  if (!id) {
    throw new Error(
      `seed-output.json has no event "${key}". Known keys: ${Object.keys(seed.events).join(', ')}`,
    );
  }
  return id;
}

const resolved = new Map<RoomKey, string>();

/**
 * Room id with an alias-resolution fallback: trusts the seed file when its id still exists on the
 * homeserver, otherwise resolves `#alias:localhost` through the room directory. Use this in
 * `beforeAll` when a stale `seed-output.json` would otherwise produce mystifying locator misses.
 */
export async function resolveRoom(key: RoomKey): Promise<string> {
  const cached = resolved.get(key);
  if (cached) return cached;

  const alias = ALIASES[key];
  if (!alias) {
    const id = roomId(key);
    resolved.set(key, id);
    return id;
  }

  let fromFile: string | undefined;
  try {
    fromFile = roomId(key);
  } catch {
    fromFile = undefined;
  }

  const res = await fetch(
    `${HS_URL}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
  );
  if (res.ok) {
    const body = (await res.json()) as { room_id?: string };
    if (body.room_id) {
      if (fromFile && fromFile !== body.room_id) {
        console.warn(
          `[seed] ${key}: seed-output.json says ${fromFile} but ${alias} resolves to ${body.room_id}; using the alias.`,
        );
      }
      resolved.set(key, body.room_id);
      return body.room_id;
    }
  }
  if (fromFile) {
    resolved.set(key, fromFile);
    return fromFile;
  }
  throw new Error(`cannot resolve room "${key}": alias ${alias} returned HTTP ${res.status}`);
}

/** Display names, asserted by the navigation/member criteria. */
export const DISPLAY_NAMES: Record<UserKey, string> = {
  alice: 'Alice Park',
  bob: 'Bob Ruiz',
  carol: 'Carol Nguyen',
  dave: 'Dave Okafor',
};

/** Room/space names exactly as `data-name` should carry them (bare, no `#`). */
export const NAMES = {
  acme: 'Acme HQ',
  gaming: 'Gaming',
  general: 'general',
  random: 'random',
  dev: 'dev',
  lobby: 'lobby',
} as const;

export const TOPICS = {
  general: 'Company-wide chat. Be nice.',
  random: 'Off-topic, memes, lunch plans.',
  dev: 'Engineering talk. Stack traces welcome.',
  lobby: 'Find a squad.',
} as const;

/**
 * Seeded message bodies referenced by the criteria, by `<room>.<#>` from docs/SEED_DATA.md.
 * Only the ones the acceptance criteria name are listed.
 */
export const BODIES = {
  general1: 'Welcome to Acme HQ! 🎉 This is our new home for company chat.',
  general6: 'Is this replacing email for internal stuff?',
  general7: 'Mostly, yes. Long-form docs still go in the wiki.',
  general11: 'Lunch today? Thinking tacos.',
  general18: 'Looks great. Love the colors.',
  general18Original: 'Looks grate. Love the colors.',
  general34: 'Will there be snacks?',
  general35: 'There will be snacks.',
  general40: 'Done. Have a good weekend all!',
  random1: 'Best pizza place near the office? Go.',
  random5: "Settled: we're getting both.",
  random8: 'In, if there are snacks.',
  dev6: 'Ship it.',
  lobby2: 'Me, after 8.',
  dmBob1: 'Hey, got a sec?',
} as const;

/** The 6 keys in the client's hardcoded reaction picker (docs/SEED_DATA.md 6). */
export const PICKER_KEYS = ['👍', '❤️', '😂', '🎉', '🔥', '👀'] as const;

/** A name nothing else in the run can collide with, for created channels/spaces. */
export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}
