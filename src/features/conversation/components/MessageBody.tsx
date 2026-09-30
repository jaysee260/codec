/**
 * Message content (DEV-B-4).
 *
 * - `org.matrix.custom.html` bodies go through `sanitizeHtml()` (DOMPurify) and are then post-processed
 *   to turn `matrix.to` user links into mention pills. The post-processing runs on the *sanitised*
 *   markup and only inserts text through `textContent`, so nothing escapes the sanitiser.
 * - plain bodies are linkified and keep their line breaks (`white-space: pre-wrap`).
 * - `m.image` / `m.file` / stickers render attachments; redacted events render the deleted placeholder.
 *
 * `message-body` contains the message text and nothing else: the `(edited)` marker is a sibling so
 * reading the body's text gives exactly what the sender wrote (AC-B1-4).
 */
import { useMemo } from 'react';
import { MsgType, type Room } from 'matrix-js-sdk';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { displayNameOf, type DisplayBody } from '@/lib/matrix/utils.ts';
import { linkify, sanitizeHtml } from '@/lib/format.ts';
import { ImageAttachment, FileAttachment } from './ImageAttachment.tsx';
import styles from './MessageBody.module.css';

const MATRIX_TO_USER = /^https?:\/\/matrix\.to\/#\/(@[^/?#]+)/;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
/** Variation selector 16 and zero-width joiner keep multi-codepoint emoji in the "emoji only" set. */
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|️|‍|\s)+$/u;

/** Sanitise, then rewrite user pills. Pure string -> string so it can be memoised per body. */
function renderRichHtml(html: string, room: Room | null, mentionClass: string): string {
  const clean = sanitizeHtml(html);
  if (typeof DOMParser === 'undefined') return clean;
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${clean}</body>`, 'text/html');
  for (const anchor of Array.from(doc.body.querySelectorAll('a[href]'))) {
    const match = MATRIX_TO_USER.exec(anchor.getAttribute('href') ?? '');
    if (!match) continue;
    let userId = match[1]!;
    try {
      userId = decodeURIComponent(userId);
    } catch {
      /* keep the raw value */
    }
    const pill = doc.createElement('span');
    pill.setAttribute('class', mentionClass);
    pill.setAttribute('data-testid', 'message-mention');
    pill.setAttribute('data-user-id', userId);
    pill.textContent = `@${displayNameOf(room, userId)}`;
    anchor.replaceWith(pill);
  }
  return doc.body.innerHTML;
}

export function MessageBody({ roomId, body }: { roomId: string; body: DisplayBody }) {
  const room = getClientOrNull()?.getRoom(roomId) ?? null;
  const html = useMemo(
    () => (body.html ? renderRichHtml(body.html, room, styles.mention) : ''),
    // `room` is a stable SDK object; display names are resolved at render time.
    [body.html, room],
  );

  if (body.isRedacted) {
    return (
      <div className={`${styles.body} ${styles.redacted}`} data-testid="message-redacted">
        Message deleted
      </div>
    );
  }

  const isImage = body.msgtype === MsgType.Image || body.msgtype === 'm.sticker';
  const isFile = body.msgtype === MsgType.File || body.msgtype === MsgType.Video || body.msgtype === MsgType.Audio;
  const emojiOnly =
    !body.html && !isImage && !isFile && body.text.length <= 24 && PICTOGRAPHIC.test(body.text) && EMOJI_ONLY.test(body.text);

  return (
    <div className={styles.line}>
      <div
        className={`${styles.body} ${isImage || isFile ? styles.blockBody : styles.inlineBody} ${emojiOnly ? styles.jumbo : ''}`}
        data-testid="message-body"
      >
        {isImage ? (
          <ImageAttachment body={body} />
        ) : isFile ? (
          <FileAttachment body={body} />
        ) : body.html ? (
          <span className={styles.rich} dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <span className={styles.plain}>
            {linkify(body.text).map((segment, i) =>
              segment.kind === 'link' ? (
                <a key={i} href={segment.href} target="_blank" rel="noopener noreferrer">
                  {segment.value}
                </a>
              ) : (
                <span key={i}>{segment.value}</span>
              ),
            )}
          </span>
        )}
      </div>
      {body.isEdited && (
        <span className={styles.edited} data-testid="message-edited" title="This message was edited">
          (edited)
        </span>
      )}
    </div>
  );
}
