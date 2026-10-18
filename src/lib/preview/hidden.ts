/**
 * Hidden previews (Phase 6, brief decision 4): the "x" on a card hides it for this viewer only, remembered in
 * localStorage per (event id, url). Nothing is sent to the room. Works without localStorage (private mode,
 * Node): the set then lives in memory for the session.
 *
 * Subscribable so `useHiddenPreview` can use `useSyncExternalStore`; also reacts to `storage` events (other tabs).
 */
export const HIDDEN_PREVIEWS_STORAGE_KEY = 'matrix-poc.hiddenPreviews';
/** Oldest entries are dropped past this many (keeps the JSON blob bounded). */
export const HIDDEN_PREVIEWS_MAX = 1000;

type Listener = () => void;

let memory: string[] | null = null;
const listeners = new Set<Listener>();
let storageHooked = false;

/** `${eventId}|${url}` (hash-stripped URL as `extractPreviewUrls` returns it). */
export function hiddenPreviewKey(eventId: string, url: string): string {
  return `${eventId}|${url}`;
}

function storage(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function load(): string[] {
  if (memory) return memory;
  const s = storage();
  let list: string[] = [];
  if (s) {
    try {
      const parsed = JSON.parse(s.getItem(HIDDEN_PREVIEWS_STORAGE_KEY) ?? '[]') as unknown;
      if (Array.isArray(parsed)) list = parsed.filter((k): k is string => typeof k === 'string');
    } catch {
      list = [];
    }
  }
  memory = list;
  return list;
}

function save(list: string[]): void {
  memory = list;
  const s = storage();
  if (s) {
    try {
      if (list.length) s.setItem(HIDDEN_PREVIEWS_STORAGE_KEY, JSON.stringify(list));
      else s.removeItem(HIDDEN_PREVIEWS_STORAGE_KEY);
    } catch {
      /* quota / private mode: memory copy still applies this session */
    }
  }
  for (const l of listeners) l();
}

function hookStorageEvents(): void {
  if (storageHooked) return;
  storageHooked = true;
  const w = globalThis as { addEventListener?: (type: string, cb: (e: { key: string | null }) => void) => void };
  w.addEventListener?.('storage', (e) => {
    if (e.key === null || e.key === HIDDEN_PREVIEWS_STORAGE_KEY) {
      memory = null;
      for (const l of listeners) l();
    }
  });
}

export function isPreviewHidden(eventId: string, url: string): boolean {
  return load().includes(hiddenPreviewKey(eventId, url));
}

export function hidePreview(eventId: string, url: string): void {
  const key = hiddenPreviewKey(eventId, url);
  const list = load().filter((k) => k !== key);
  list.push(key);
  save(list.length > HIDDEN_PREVIEWS_MAX ? list.slice(list.length - HIDDEN_PREVIEWS_MAX) : list);
}

export function unhidePreview(eventId: string, url: string): void {
  const key = hiddenPreviewKey(eventId, url);
  const list = load();
  if (list.includes(key)) save(list.filter((k) => k !== key));
}

/** Forget every hidden preview (devtools / tests). */
export function clearHiddenPreviews(): void {
  save([]);
}

/** Notifies on every change in this tab and on `storage` events from other tabs. Returns the unsubscribe. */
export function subscribeHiddenPreviews(listener: Listener): () => void {
  hookStorageEvents();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot token for `useSyncExternalStore` (changes whenever the set changes). */
export function hiddenPreviewsVersion(): string {
  return load().join('\n');
}
