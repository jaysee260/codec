/**
 * `@mention` autocomplete state for the composer (DEV-B-10).
 *
 * Tracks the `@token` immediately before the caret, filters the room's joined members on display
 * name and localpart, and remembers which mentions were inserted so `send` can build the
 * `formatted_body` (matrix.to links) plus `m.mentions.user_ids`.
 */
import { useCallback, useMemo, useState } from 'react';
import { useMembers, useMyUserId } from '@/store/hooks.ts';
import { escapeHtml } from '@/lib/format.ts';
import { localpartOf } from '@/lib/matrix/utils.ts';

const MAX_OPTIONS = 8;
/** `@` at the start or after whitespace, then the (possibly empty) query up to the caret. */
const TRIGGER = /(?:^|\s)@([\p{L}\p{N}._:-]*)$/u;

export interface MentionOption {
  userId: string;
  name: string;
  avatarUrl: string;
}

export interface MentionInsert {
  value: string;
  caret: number;
}

export interface MentionsApi {
  open: boolean;
  options: MentionOption[];
  activeIndex: number;
  move(delta: number): void;
  /** Recompute from the textarea value + caret position. */
  sync(value: string, caret: number): void;
  close(): void;
  /** Build the replacement text for an option, or null when the trigger is gone. */
  accept(option: MentionOption, value: string, caret: number): MentionInsert | null;
  /** Reset the tracked mentions (after a send or a room change). */
  reset(): void;
  /** `{ html, mentions }` additions for `sendText`, or `{}` when the body has no mention. */
  contentFor(text: string): { html?: string; mentions?: string[] };
}

export function useMentions(roomId: string): MentionsApi {
  const { joined } = useMembers(roomId);
  const myUserId = useMyUserId();
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [tracked, setTracked] = useState<MentionOption[]>([]);

  const candidates = useMemo(
    () => joined.filter((m) => m.userId !== myUserId).map((m) => ({ userId: m.userId, name: m.name, avatarUrl: m.avatarUrl })),
    [joined, myUserId],
  );

  const options = useMemo(() => {
    if (query === null) return [];
    const needle = query.toLowerCase();
    return candidates
      .filter((c) => !needle || c.name.toLowerCase().includes(needle) || localpartOf(c.userId).toLowerCase().includes(needle))
      .slice(0, MAX_OPTIONS);
  }, [candidates, query]);

  const sync = useCallback((value: string, caret: number) => {
    const match = TRIGGER.exec(value.slice(0, caret));
    setQuery(match ? (match[1] ?? '') : null);
    setActiveIndex(0);
  }, []);

  const close = useCallback(() => setQuery(null), []);

  const move = useCallback(
    (delta: number) => setActiveIndex((i) => (options.length === 0 ? 0 : (i + delta + options.length) % options.length)),
    [options.length],
  );

  const accept = useCallback((option: MentionOption, value: string, caret: number): MentionInsert | null => {
    const before = value.slice(0, caret);
    const match = TRIGGER.exec(before);
    if (!match) return null;
    const start = before.length - match[0]!.length + (match[0]!.startsWith('@') ? 0 : 1);
    const insert = `@${option.name} `;
    setTracked((list) => (list.some((m) => m.userId === option.userId) ? list : [...list, option]));
    setQuery(null);
    return { value: value.slice(0, start) + insert + value.slice(caret), caret: start + insert.length };
  }, []);

  const reset = useCallback(() => {
    setTracked([]);
    setQuery(null);
  }, []);

  const contentFor = useCallback(
    (text: string): { html?: string; mentions?: string[] } => {
      const used = tracked.filter((m) => text.includes(`@${m.name}`));
      if (used.length === 0) return {};
      let html = escapeHtml(text);
      for (const mention of used) {
        const needle = escapeHtml(`@${mention.name}`);
        html = html
          .split(needle)
          .join(`<a href="https://matrix.to/#/${mention.userId}">${escapeHtml(mention.name)}</a>`);
      }
      return { html: html.replace(/\n/g, '<br />'), mentions: used.map((m) => m.userId) };
    },
    [tracked],
  );

  return { open: query !== null && options.length > 0, options, activeIndex, move, sync, close, accept, reset, contentFor };
}
