/**
 * Composer (DEV-B-2 / B-6 / B-8 / B-9 / B-10 / B-12 / B-15).
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
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Mic, SendHorizontal, X } from 'lucide-react';
import { canEditEvent, editText, sendFile, sendText } from '@/lib/matrix/actions.ts';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { displayNameOf, getDisplayBody, isPendingEvent } from '@/lib/matrix/utils.ts';
import { useMyUserId, useRoomSummary, useRoomTimeline } from '@/store/hooks.ts';
import { withToast } from '@/store/toast.ts';
import { useConversationUi, useEditingId, useReplyTargetId } from '../hooks/useConversationUi.ts';
import { useMentions, type MentionOption } from '../hooks/useMentions.ts';
import { useTypingNotifier } from '../hooks/useTypingNotifier.ts';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder.ts';
import { AttachButton } from './AttachButton.tsx';
import { MentionAutocomplete } from './MentionAutocomplete.tsx';
import { UploadProgress } from './UploadProgress.tsx';
import { VoiceErrorBanner, VoiceRecorderBar } from './VoiceRecorderBar.tsx';
import styles from './Composer.module.css';

const MAX_HEIGHT = 340;

export function Composer({ roomId }: { roomId: string }) {
  const summary = useRoomSummary(roomId);
  const { events } = useRoomTimeline(roomId);
  const myUserId = useMyUserId();
  const replyToId = useReplyTargetId(roomId);
  const editingId = useEditingId(roomId);
  const focusTick = useConversationUi((s) => s.focusTick);
  const startEdit = useConversationUi((s) => s.startEdit);
  const cancelEdit = useConversationUi((s) => s.cancelEdit);
  const cancelReply = useConversationUi((s) => s.cancelReply);
  const clearTargets = useConversationUi((s) => s.clearComposerTargets);

  const [text, setText] = useState('');
  const [uploads, setUploads] = useState<string[]>([]);
  /** Last edit target the input was seeded from; see the edit block below. */
  const [editSeed, setEditSeed] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const typing = useTypingNotifier(roomId);
  const mentions = useMentions(roomId);
  const recorder = useVoiceRecorder(roomId);
  const room = getClientOrNull()?.getRoom(roomId) ?? null;

  // --- room change -----------------------------------------------------------
  useEffect(() => {
    setText('');
    mentions.reset();
    clearTargets(roomId);
    inputRef.current?.focus();
    // Intentionally only on room change; the helpers are stable store actions.
  }, [roomId]);

  // --- focus requests from the message list (reply / edit buttons) ------------
  useEffect(() => {
    if (focusTick) inputRef.current?.focus();
  }, [focusTick]);

  // --- edit mode ---------------------------------------------------------------
  // Derived during render (not in an effect) so the prefilled body is already in the DOM in the same
  // commit that shows `composer-edit-banner`; an effect would leave one frame with an empty input.
  if (editingId !== editSeed) {
    setEditSeed(editingId);
    const target = editingId ? room?.findEventById(editingId) : undefined;
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
      if (event.getSender() === myUserId && !isPendingEvent(event) && canEditEvent(event)) return event.getId();
    }
    return undefined;
  }, [events, myUserId]);

  const uploadFiles = useCallback(
    (files: File[]): void => {
      for (const file of files) {
        const name = file.name || 'clipboard image';
        setUploads((list) => [...list, name]);
        void withToast(() => sendFile(roomId, file), `Could not upload ${name}`).finally(() =>
          setUploads((list) => {
            const index = list.indexOf(name);
            return index < 0 ? list : [...list.slice(0, index), ...list.slice(index + 1)];
          }),
        );
      }
    },
    [roomId],
  );

  const submit = (): void => {
    const body = text.trim();
    if (!body) return;
    const extra = mentions.contentFor(body);

    if (editingId) {
      const target = editingId;
      setText('');
      cancelEdit(roomId);
      mentions.reset();
      void withToast(() => editText(roomId, target, body, extra.html), 'Could not save the edit');
      return;
    }

    setText('');
    typing.stop();
    mentions.reset();
    clearTargets(roomId);
    void withToast(() => sendText(roomId, body, { ...extra, replyTo: replyToId }), 'Could not send the message');
    inputRef.current?.focus();
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

    if (e.key === 'Escape') {
      if (editingId) {
        e.preventDefault();
        cancelEdit(roomId);
        return;
      }
      if (replyToId) {
        e.preventDefault();
        cancelReply(roomId);
        return;
      }
    }

    if (e.key === 'ArrowUp' && !text && !editingId && lastOwnEditableId) {
      e.preventDefault();
      startEdit(roomId, lastOwnEditableId);
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

  const replyName = replyToId ? displayNameOf(room, room?.findEventById(replyToId)?.getSender() ?? '') : '';
  const placeholder = summary ? (summary.isDm ? `Message @${summary.name}` : `Message #${summary.name}`) : 'Message';
  const canSend = text.trim().length > 0;
  const attached = !!(editingId || replyToId || uploads.length || (!recorder.barOpen && recorder.error));
  /** `composer-mic` only ever reports idle | requesting | denied (test-id registry). */
  const micState = recorder.state === 'requesting' || recorder.state === 'denied' ? recorder.state : 'idle';
  const micTitle = recorder.supported
    ? 'Record a voice message'
    : 'Voice messages need the app or an https page (no microphone on this page)';

  return (
    <div className={styles.composer} data-testid="composer">
      {mentions.open && (
        <MentionAutocomplete
          options={mentions.options}
          activeIndex={mentions.activeIndex}
          onPick={applyMention}
          onHover={(index) => mentions.move(index - mentions.activeIndex)}
        />
      )}

      <UploadProgress names={uploads} />

      {editingId && (
        <div className={styles.banner} data-testid="composer-edit-banner">
          <span className={styles.bannerText}>Editing message</span>
          <span className={styles.bannerHint}>escape to cancel &middot; enter to save</span>
          <button
            type="button"
            className={styles.bannerClose}
            data-testid="composer-edit-cancel"
            title="Cancel editing"
            aria-label="Cancel editing"
            onClick={() => cancelEdit(roomId)}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {!editingId && replyToId && (
        <div className={styles.banner} data-testid="composer-reply-banner">
          <span className={styles.bannerText}>Replying to {replyName}</span>
          <button
            type="button"
            className={styles.bannerClose}
            data-testid="composer-reply-cancel"
            title="Cancel reply"
            aria-label="Cancel reply"
            onClick={() => cancelReply(roomId)}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {!recorder.barOpen && recorder.error && <VoiceErrorBanner message={recorder.error} />}

      {recorder.barOpen ? (
        <VoiceRecorderBar recorder={recorder} />
      ) : (
        <div className={`${styles.box} ${attached ? styles.boxAttached : ''}`}>
          <AttachButton onFiles={uploadFiles} />
          <textarea
            ref={inputRef}
            className={styles.input}
            data-testid="composer-input"
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
              data-testid="composer-mic"
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
              data-testid="composer-send"
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
