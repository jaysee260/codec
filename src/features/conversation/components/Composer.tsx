/**
 * Composer (DEV-B-2 / B-6 / B-8 / B-9 / B-10 / B-12 / B-15 / B-20 / B-22).
 *
 * Enter sends, Shift+Enter inserts a newline, the textarea auto-grows, typing notifications are
 * throttled to one every 4 s, attachments come from the paperclip or a clipboard paste, and the
 * reply / edit banners are driven by the shared conversation UI store. ArrowUp on an empty composer
 * opens edit mode on my last message; Escape cancels reply/edit.
 *
 * Phase 2: the trailing button is a *slot* holding both `composer-mic` and `composer-send`, stacked
 * on each other with only one visible at a time (AC-V1-1 "send takes its place"). Both stay mounted
 * with a full-size box so AC-B2-4 (`composer-send` disabled while the input is blank) and AC-V6-1
 * (all three composer buttons >= 44 px on phone) hold at the same time. While a voice note is being
 * recorded / uploaded, `composer-recording` replaces the whole input box.
 *
 * Phase 3: one `source` prop decides which timeline this composer writes to.
 *
 *  - `{ roomId }` - the channel composer, byte-identical to Phase 1/2 (ids unprefixed, sends with no
 *    relation, reply banner available).
 *  - `{ roomId, threadRootId }` - the thread panel's composer: every id is prefixed
 *    (`thread-composer-input`, `thread-composer-send`, `thread-composer-mic`, ...), the placeholder
 *    reads `Replying in thread`, and text, files and voice notes all carry `threadRoot` so the core
 *    builds the contract `m.relates_to` (docs/PHASE3_ACCEPTANCE.md "Thread reply event"). Quote
 *    replies are out of scope inside a thread, so `replyTo` is never set there and can never collide
 *    with `threadRoot` (which `sendText` rejects).
 *
 * Reply/edit/focus state is keyed by `sourceKey(source)`, so an edit started in the panel fills the
 * panel's composer and the channel's banner stays closed (AC-T6-9).
 *
 * Phase 4 adds the GIF picker (DEV-B-23 / DEV-B-24). Two triggers, one target:
 *
 *  - `composer-gif` next to the paperclip toggles the picker open on trending;
 *  - a draft matching `/gif` or `/giphy` (optionally followed by a query) is a **slash command**:
 *    Enter / `composer-send` does not send it, it opens the picker pre-searched and clears the draft
 *    (AC-G6-3). Anything else starting with `/` is an ordinary message (AC-G6-4).
 *
 * Which composer owns the picker lives in `useGifPicker` rather than here, because the picker's test
 * ids are never prefixed: only one may exist on the page, so opening it from the thread panel closes
 * the channel's instance (AC-G6-6). `GifPickerMount` positions it and owns dismissal.
 *
 * `onPick` sends straight away - `gif-pending` ("Sending GIF...") replaces nothing and disables
 * `composer-gif` until the event is acked or fails, so there is at most one GIF in flight per
 * composer (AC-G7-3), and the caret goes back into the input afterwards (AC-G7-1).
 *
 * Phase 5 (DEV-B-29): in an encrypted room `composer[data-encrypted="true"]` and the placeholder gains
 * " (encrypted)" (`Message #vault (encrypted)`, both composers). `prepareToEncrypt(roomId)` runs when the
 * room opens and on every input focus, so the Megolm session (member devices, `/keys/query`, key shares) is
 * ready before Enter (AC-E6-3). A send the session cannot encrypt - crypto failed to start
 * (`useSecurityStore.cryptoError`, `EncryptionNotReadyError`) or the SDK's encryption step threw - shows
 * "Could not encrypt the message, try again" and puts the text back into the input. Files and voice notes
 * need nothing here: `sendFile` / `sendVoiceMessage` encrypt by themselves in encrypted rooms. No URL preview
 * is ever requested (there is no preview code at all, AC-E6-4).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { ImagePlay, Mic, SendHorizontal, X } from 'lucide-react';
import { MatrixError } from 'matrix-js-sdk';
import { canEditEvent, editText, EncryptionNotReadyError, prepareToEncrypt, sendFile, sendGif, sendText } from '@/lib/matrix/actions.ts';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { displayNameOf, getDisplayBody, isGifEvent, isPendingEvent } from '@/lib/matrix/utils.ts';
import type { GifResult } from '@/lib/gif';
import {
  sourceKey,
  useIsPhone,
  useMyUserId,
  useRoomEncrypted,
  useRoomSummary,
  useSecurityStore,
  useThreadStore,
  useTimeline,
  type TimelineSource,
} from '@/store/hooks.ts';
import { showToast, withToast } from '@/store/toast.ts';
import { useConversationUi, useEditingId, useFocusTick, useReplyTargetId } from '../hooks/useConversationUi.ts';
import { useGifPickerFor, useGifPickerStore } from '../hooks/useGifPicker.ts';
import { useMentions, type MentionOption } from '../hooks/useMentions.ts';
import { useTypingNotifier } from '../hooks/useTypingNotifier.ts';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder.ts';
import { makeTid, type Tid } from '../tid.ts';
import { AttachButton } from './AttachButton.tsx';
import { GifPickerMount } from './GifPickerMount.tsx';
import { MentionAutocomplete } from './MentionAutocomplete.tsx';
import { UploadProgress } from './UploadProgress.tsx';
import { VoiceErrorBanner, VoiceRecorderBar } from './VoiceRecorderBar.tsx';
import styles from './Composer.module.css';

const MAX_HEIGHT = 340;

/**
 * The GIF slash command (AC-G6-3 / AC-G6-4). The whole draft must be the command, case-insensitively,
 * followed by the end of the text or whitespace + the query: `/gif`, `/GIPHY tacos`, `/gif  a b` all
 * match; `/gifs tacos`, `/giffy`, `/ gif tacos` and `/slap bob` do not and are sent as plain text.
 * `[\s\S]` rather than `.` so a multi-line draft starting with `/gif` is still recognised.
 */
const GIF_COMMAND = /^\/(?:gif|giphy)(?:\s+([\s\S]*))?$/i;

/** The query a draft asks the picker for, or null when the draft is not a GIF command. */
export function gifCommandQuery(draft: string): string | null {
  const match = GIF_COMMAND.exec(draft.trim());
  return match ? (match[1] ?? '').trim() : null;
}

const ENCRYPT_FAILED = 'Could not encrypt the message, try again';

/**
 * True when a failed send in an encrypted room failed at the encryption step rather than at the server: our
 * own pre-check, or anything the SDK threw that is not an HTTP answer (`MatrixError` carries `httpStatus`).
 */
function isEncryptionFailure(e: unknown): boolean {
  if (e instanceof EncryptionNotReadyError) return true;
  if (e instanceof MatrixError && typeof e.httpStatus === 'number') return false;
  const name = (e as { name?: string } | null)?.name ?? '';
  return name !== 'AbortError' && name !== 'ConnectionError';
}

export interface ComposerProps {
  source: TimelineSource;
  /** Id prefix for every id this composer owns (`'thread-'` inside the panel). */
  testIdPrefix?: string;
}

export function Composer({ source, testIdPrefix }: ComposerProps) {
  const roomId = source.roomId;
  const threadRoot = source.threadRootId;
  const key = sourceKey(source);
  const tid: Tid = useMemo(() => makeTid(testIdPrefix), [testIdPrefix]);

  const summary = useRoomSummary(roomId);
  const encrypted = useRoomEncrypted(roomId);
  const { events } = useTimeline(source);
  const myUserId = useMyUserId();
  const isPhone = useIsPhone();
  const replyToId = useReplyTargetId(key);
  const editingId = useEditingId(key);
  const focusTick = useFocusTick(key);
  const startEdit = useConversationUi((s) => s.startEdit);
  const cancelEdit = useConversationUi((s) => s.cancelEdit);
  const cancelReply = useConversationUi((s) => s.cancelReply);
  const clearTargets = useConversationUi((s) => s.clearComposerTargets);
  const closeThread = useThreadStore((s) => s.closeThread);

  const [text, setText] = useState('');
  const [uploads, setUploads] = useState<string[]>([]);
  /** Last edit target the input was seeded from; see the edit block below. */
  const [editSeed, setEditSeed] = useState<string | undefined>(undefined);
  /** True from a pick until `sendGif` resolves or rejects: `gif-pending` + `composer-gif` disabled. */
  const [gifPending, setGifPending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const gifButtonRef = useRef<HTMLButtonElement>(null);

  const gifPicker = useGifPickerFor(key);
  const openGifPicker = useGifPickerStore((s) => s.openFor);
  const closeGifPicker = useGifPickerStore((s) => s.close);

  const typing = useTypingNotifier(roomId);
  const mentions = useMentions(roomId);
  const recorder = useVoiceRecorder(roomId, { threadRoot });
  const room = getClientOrNull()?.getRoom(roomId) ?? null;

  /**
   * Find an event by id for the edit prefill. `Room.findEventById` searches the main timeline and
   * the room's thread timelines, but a reply that only exists in the thread snapshot we are rendering
   * (a just-sent local echo, or a reply loaded by `/relations` alone) is looked up in that snapshot.
   */
  const findEvent = useCallback(
    (eventId: string) => room?.findEventById(eventId) ?? events.find((e) => e.getId() === eventId),
    [room, events],
  );

  // --- source change ---------------------------------------------------------
  // Closing the picker here covers both AC-G6-7 (a room switch remounts this composer with a new key)
  // and half of AC-G6-6 (the thread panel mounting its composer closes a channel-opened picker).
  useEffect(() => {
    setText('');
    setGifPending(false);
    mentions.reset();
    clearTargets(key);
    closeGifPicker();
    inputRef.current?.focus();
    // Unmounting (the thread panel closing, a logout) must not leave the singleton pointing at a
    // composer that no longer exists - nothing would render it and nothing would close it.
    return () => {
      if (useGifPickerStore.getState().open?.key === key) closeGifPicker();
    };
    // Intentionally only on source change; the helpers are stable store actions.
  }, [key]);

  // --- encryption: warm the Megolm session up as soon as the room is open (and again on focus) --------
  useEffect(() => {
    if (encrypted) prepareToEncrypt(roomId);
  }, [roomId, encrypted]);

  // --- focus requests addressed to this composer (reply / edit buttons, panel open) -------------
  useEffect(() => {
    if (focusTick) inputRef.current?.focus();
  }, [focusTick]);

  // --- edit mode ---------------------------------------------------------------
  // Derived during render (not in an effect) so the prefilled body is already in the DOM in the same
  // commit that shows `composer-edit-banner`; an effect would leave one frame with an empty input.
  if (editingId !== editSeed) {
    setEditSeed(editingId);
    const target = editingId ? findEvent(editingId) : undefined;
    setText(target ? getDisplayBody(target).text : '');
  }

  useEffect(() => {
    const input = inputRef.current;
    if (!editingId || !input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editingId]);

  // --- auto-grow -------------------------------------------------------------
  // `recorder.barOpen` is a dependency because the textarea is unmounted while the recording bar is
  // up: without it the remounted textarea would keep whatever height the last run computed.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, MAX_HEIGHT)}px`;
  }, [text, recorder.barOpen]);

  // --- recording bar closed: give the input the focus back (AC-V1-3) ---------
  const barWasOpen = useRef(false);
  useEffect(() => {
    if (barWasOpen.current && !recorder.barOpen) inputRef.current?.focus();
    barWasOpen.current = recorder.barOpen;
  }, [recorder.barOpen]);

  const lastOwnEditableId = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      // GIFs are not editable (AC-G8-2), so ArrowUp skips them exactly as the toolbar hides the action.
      if (event.getSender() === myUserId && !isPendingEvent(event) && canEditEvent(event) && !isGifEvent(event))
        return event.getId();
    }
    return undefined;
  }, [events, myUserId]);

  const uploadFiles = useCallback(
    (files: File[]): void => {
      for (const file of files) {
        const name = file.name || 'clipboard image';
        setUploads((list) => [...list, name]);
        void withToast(() => sendFile(roomId, file, { threadRoot }), `Could not upload ${name}`).finally(() =>
          setUploads((list) => {
            const index = list.indexOf(name);
            return index < 0 ? list : [...list.slice(0, index), ...list.slice(index + 1)];
          }),
        );
      }
    },
    [roomId, threadRoot],
  );

  /** Open the picker for this composer and park the caret for when it closes again. */
  const openPicker = useCallback(
    (query: string): void => {
      openGifPicker(key, query);
    },
    [openGifPicker, key],
  );

  const onPickGif = useCallback(
    (gif: GifResult): void => {
      // Close first: the picker is gone in the same commit the chip appears, so the pick never looks
      // like it did nothing while the request is in flight (AC-G7-1).
      closeGifPicker();
      setGifPending(true);
      inputRef.current?.focus();
      void withToast(() => sendGif(roomId, gif, { threadRoot }), 'Could not send GIF').finally(() => {
        setGifPending(false);
        inputRef.current?.focus();
      });
    },
    [closeGifPicker, roomId, threadRoot],
  );

  const submit = (): void => {
    const body = text.trim();
    if (!body) return;

    // `/gif` / `/giphy` is consumed, never sent (AC-G6-3). Not while editing an existing message: the
    // draft there is that message's text, and "/gif ..." may well be what it legitimately says.
    if (!editingId) {
      const query = gifCommandQuery(body);
      if (query !== null) {
        if (gifPending) return; // one GIF in flight per composer (AC-G7-3)
        setText('');
        typing.stop();
        mentions.reset();
        openPicker(query);
        return;
      }
    }

    // The crypto engine never started (`getCryptoError()`): nothing can be encrypted, so keep the draft.
    if (encrypted && useSecurityStore.getState().cryptoError) {
      showToast(ENCRYPT_FAILED, 'error');
      return;
    }

    const extra = mentions.contentFor(body);

    if (editingId) {
      const target = editingId;
      setText('');
      cancelEdit(key);
      mentions.reset();
      // No `threadRoot` here on purpose: the core derives it from the *target* event, which keeps an
      // edit of a reply inside the thread and an edit of the root in the main timeline (AC-T9-1).
      // No draft restore for an edit: the input would hold the text without the edit banner, and Enter
      // would then send it as a new message.
      void sendOrRestore(() => editText(roomId, target, body, extra.html), 'Could not save the edit', null);
      return;
    }

    setText('');
    typing.stop();
    mentions.reset();
    clearTargets(key);
    // `replyTo` and `threadRoot` are mutually exclusive in the core; inside a thread there is no
    // reply action, so this branch is the only place either of them is set.
    void sendOrRestore(
      () => sendText(roomId, body, threadRoot ? { ...extra, threadRoot } : { ...extra, replyTo: replyToId }),
      'Could not send the message',
      text,
    );
    inputRef.current?.focus();
  };

  /**
   * Run a send. Plain rooms keep the Phase 1 behaviour (error toast, the failed local echo says so). In an
   * encrypted room an encryption failure gets its own toast and the draft comes back into the input, unless
   * the reader has started typing something else meanwhile.
   */
  const sendOrRestore = async (send: () => Promise<unknown>, label: string, draft: string | null): Promise<void> => {
    try {
      await send();
    } catch (e) {
      if (encrypted && isEncryptionFailure(e)) {
        showToast(ENCRYPT_FAILED, 'error');
        if (draft !== null) setText((current) => (current ? current : draft));
        return;
      }
      showToast(`${label}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const applyMention = (option: MentionOption): void => {
    const input = inputRef.current;
    const caret = input?.selectionStart ?? text.length;
    const next = mentions.accept(option, text, caret);
    if (!next) return;
    setText(next.value);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(next.caret, next.caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mentions.open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentions.move(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentions.move(-1);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        mentions.close();
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        const option = mentions.options[mentions.activeIndex];
        if (option) {
          e.preventDefault();
          applyMention(option);
          return;
        }
      }
    }

    // The picker is checked before the reply / edit / thread branches so Escape dismisses only the
    // overlay: a reply banner opened before the picker is still there afterwards (AC-G6-5). In
    // practice `gif-search` has the focus while it is open and `GifPickerMount`'s document listener
    // gets there first; this is the path for a composer that somehow kept the caret.
    if (e.key === 'Escape' && gifPicker) {
      e.preventDefault();
      e.stopPropagation();
      closeGifPicker();
      return;
    }

    if (e.key === 'Escape') {
      if (editingId) {
        e.preventDefault();
        cancelEdit(key);
        return;
      }
      if (replyToId) {
        e.preventDefault();
        cancelReply(key);
        return;
      }
      // Inside a thread: Escape first clears a draft, and only closes the panel when there is
      // nothing to lose (AC-T6-9; desktop only, phone closes with `header-back`).
      if (threadRoot) {
        e.preventDefault();
        e.stopPropagation();
        if (text) setText('');
        else if (!isPhone) closeThread();
        return;
      }
    }

    if (e.key === 'ArrowUp' && !text && !editingId && lastOwnEditableId) {
      e.preventDefault();
      startEdit(key, lastOwnEditableId);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    uploadFiles(files);
  };

  const replyName = replyToId ? displayNameOf(room, findEvent(replyToId)?.getSender() ?? '') : '';
  const basePlaceholder = threadRoot
    ? 'Replying in thread'
    : summary
      ? summary.isDm
        ? `Message @${summary.name}`
        : `Message #${summary.name}`
      : 'Message';
  const placeholder = encrypted ? `${basePlaceholder} (encrypted)` : basePlaceholder;
  const canSend = text.trim().length > 0;
  const attached = !!(editingId || replyToId || uploads.length || (!recorder.barOpen && recorder.error));
  /** `composer-mic` only ever reports idle | requesting | denied (test-id registry). */
  const micState = recorder.state === 'requesting' || recorder.state === 'denied' ? recorder.state : 'idle';
  const micTitle = recorder.supported
    ? 'Record a voice message'
    : 'Voice messages need the app or an https page (no microphone on this page)';

  return (
    <div className={styles.composer} data-testid={tid('composer')} data-encrypted={encrypted ? 'true' : 'false'}>
      {mentions.open && (
        <MentionAutocomplete
          options={mentions.options}
          activeIndex={mentions.activeIndex}
          onPick={applyMention}
          onHover={(index) => mentions.move(index - mentions.activeIndex)}
        />
      )}

      {gifPicker && (
        <GifPickerMount
          // A fresh mount per open, so re-opening re-runs the search and resets the selection.
          key={gifPicker.nonce}
          initialQuery={gifPicker.initialQuery}
          variant={isPhone ? 'sheet' : 'popover'}
          trigger={gifButtonRef}
          onPick={onPickGif}
          onClose={() => {
            closeGifPicker();
            inputRef.current?.focus();
          }}
        />
      )}

      <UploadProgress names={uploads} />

      {gifPending && (
        <div className={styles.gifPending} data-testid={tid('gif-pending')} role="status">
          <ImagePlay size={14} className={styles.gifPendingIcon} aria-hidden="true" />
          <span>Sending GIF...</span>
        </div>
      )}

      {editingId && (
        <div className={styles.banner} data-testid={tid('composer-edit-banner')}>
          <span className={styles.bannerText}>Editing message</span>
          <span className={styles.bannerHint}>escape to cancel &middot; enter to save</span>
          <button
            type="button"
            className={styles.bannerClose}
            data-testid={tid('composer-edit-cancel')}
            title="Cancel editing"
            aria-label="Cancel editing"
            onClick={() => cancelEdit(key)}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {!editingId && replyToId && (
        <div className={styles.banner} data-testid={tid('composer-reply-banner')}>
          <span className={styles.bannerText}>Replying to {replyName}</span>
          <button
            type="button"
            className={styles.bannerClose}
            data-testid={tid('composer-reply-cancel')}
            title="Cancel reply"
            aria-label="Cancel reply"
            onClick={() => cancelReply(key)}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {!recorder.barOpen && recorder.error && <VoiceErrorBanner message={recorder.error} />}

      {recorder.barOpen ? (
        <VoiceRecorderBar recorder={recorder} tid={tid} />
      ) : (
        <div className={`${styles.box} ${attached ? styles.boxAttached : ''}`}>
          <AttachButton tid={tid} onFiles={uploadFiles} />
          {/*
           * A toggle: clicking it while the picker is open closes it (AC-G6-2). `GifPickerMount`
           * excludes this button from its outside-click test, so the mousedown does not close the
           * picker before this click can read `gifPicker` and decide.
           */}
          <button
            ref={gifButtonRef}
            type="button"
            className={styles.gif}
            data-testid={tid('composer-gif')}
            data-open={gifPicker ? 'true' : 'false'}
            title="Send a GIF"
            aria-label="Send a GIF"
            aria-haspopup="dialog"
            aria-expanded={gifPicker ? true : false}
            disabled={gifPending}
            onClick={() => {
              if (gifPicker) {
                closeGifPicker();
                inputRef.current?.focus();
                return;
              }
              typing.stop();
              openPicker('');
            }}
          >
            <ImagePlay size={20} aria-hidden="true" />
          </button>
          <textarea
            ref={inputRef}
            className={styles.input}
            data-testid={tid('composer-input')}
            placeholder={placeholder}
            rows={1}
            value={text}
            aria-label={placeholder}
            onChange={(e) => {
              setText(e.target.value);
              mentions.sync(e.target.value, e.target.selectionStart ?? e.target.value.length);
              if (e.target.value.trim()) typing.onInput();
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={() => prepareToEncrypt(roomId)}
            onBlur={typing.stop}
          />
          {/*
           * One slot, two stacked buttons: whichever is hidden keeps its box (so a bounding-box check
           * finds 44 px for both on phone) but is invisible and unreachable.
           */}
          <div className={styles.slot} data-mode={canSend ? 'send' : 'mic'}>
            <button
              type="button"
              className={styles.mic}
              data-testid={tid('composer-mic')}
              data-state={micState}
              data-supported={recorder.supported ? 'true' : 'false'}
              title={micTitle}
              aria-label={micTitle}
              aria-hidden={canSend ? true : undefined}
              tabIndex={canSend ? -1 : undefined}
              disabled={canSend || !recorder.supported || recorder.state === 'requesting'}
              onClick={() => {
                typing.stop();
                recorder.start();
              }}
            >
              <Mic size={20} />
            </button>
            <button
              type="button"
              className={styles.send}
              data-testid={tid('composer-send')}
              title={editingId ? 'Save changes' : 'Send message'}
              aria-label={editingId ? 'Save changes' : 'Send message'}
              aria-hidden={canSend ? undefined : true}
              tabIndex={canSend ? undefined : -1}
              disabled={!canSend}
              onClick={submit}
            >
              <SendHorizontal size={20} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
