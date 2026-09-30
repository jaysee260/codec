/**
 * Placeholder MessageList (Dev B replaces the internals). Renders every displayable event as a
 * simple row: avatar, author, time, body (HTML sanitised), image, reply quote, reactions, (edited).
 * testids used: message-list, timeline-start, timeline-loading, message-{eventId}, message-author,
 *   message-timestamp, message-body, message-edited, message-redacted, message-image,
 *   message-reply-quote, message-reply-quote-author, message-reactions, reaction-{key}
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { MsgType, type MatrixEvent } from 'matrix-js-sdk';
import { useRoomTimeline, useRoomSummary } from '@/store/hooks.ts';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { getReactions, markRoomRead, toggleReaction } from '@/lib/matrix/actions.ts';
import { avatarUrlOf, displayNameOf, getDisplayBody, isPendingEvent, mxcToHttp, previewText } from '@/lib/matrix/utils.ts';
import { colorFor, formatFullTime, formatTime, initialsOf, linkify, sanitizeHtml } from '@/lib/format.ts';
import { withToast } from '@/store/toast.ts';
import styles from './MessageList.module.css';

export function MessageList({ roomId }: { roomId: string }) {
  const { events, hasMore, isPaginating, paginateBack, version } = useRoomTimeline(roomId);
  const summary = useRoomSummary(roomId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Track whether the user is near the bottom so new messages only auto-scroll then.
  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  useLayoutEffect(() => {
    stickToBottom.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [roomId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [version, events.length]);

  // Mark the room read when opened and whenever new events arrive while it is open.
  useEffect(() => {
    const t = setTimeout(() => void markRoomRead(roomId).catch(() => undefined), 500);
    return () => clearTimeout(t);
  }, [roomId, events.length]);

  const label = summary ? (summary.isDm ? summary.name : `#${summary.name}`) : 'this room';

  return (
    <div className={styles.list} data-testid="message-list" ref={scrollRef} onScroll={onScroll}>
      <div className={styles.top}>
        {hasMore ? (
          <button className={styles.loadMore} onClick={() => void paginateBack()} disabled={isPaginating} data-testid="timeline-load-more">
            {isPaginating ? 'Loading...' : 'Load older messages'}
          </button>
        ) : (
          <div className={styles.start} data-testid="timeline-start">
            <div className={styles.startTitle}>This is the beginning of {label}</div>
            {summary?.topic && <div className={styles.startTopic}>{summary.topic}</div>}
          </div>
        )}
        {isPaginating && <div className={styles.loading} data-testid="timeline-loading" />}
      </div>
      {events.map((event) => (
        <MessageRow key={event.getId()} event={event} roomId={roomId} />
      ))}
    </div>
  );
}

function MessageRow({ event, roomId }: { event: MatrixEvent; roomId: string }) {
  const room = getClientOrNull()?.getRoom(roomId) ?? null;
  const sender = event.getSender() ?? '';
  const name = displayNameOf(room, sender);
  const avatar = avatarUrlOf(room, sender, 40);
  const body = getDisplayBody(event);
  const eventId = event.getId() ?? '';
  const reactions = getReactions(roomId, eventId);
  const replyTarget = body.replyTo ? room?.findEventById(body.replyTo) : undefined;
  const pending = isPendingEvent(event);

  return (
    <div
      className={`${styles.row} ${pending ? styles.pending : ''}`}
      data-testid={`message-${eventId}`}
      data-sender={sender}
      data-event-type={event.getType()}
    >
      <span className={`u-avatar ${styles.avatar}`} style={{ background: colorFor(sender) }} data-testid="message-avatar">
        {avatar ? <img src={avatar} alt="" /> : initialsOf(name)}
      </span>
      <div className={styles.content}>
        {replyTarget && (
          <div className={styles.replyQuote} data-testid="message-reply-quote">
            <span className={styles.replyAuthor} data-testid="message-reply-quote-author">
              {displayNameOf(room, replyTarget.getSender() ?? '')}
            </span>
            <span className={`${styles.replyText} u-truncate`}>{previewText(replyTarget)}</span>
          </div>
        )}
        <div className={styles.meta}>
          <span className={styles.author} data-testid="message-author">
            {name}
          </span>
          <span className={styles.time} data-testid="message-timestamp" title={formatFullTime(event.getTs())}>
            {formatTime(event.getTs())}
          </span>
        </div>
        <Body body={body} />
        {reactions.length > 0 && (
          <div className={styles.reactions} data-testid="message-reactions">
            {reactions.map((r) => (
              <button
                key={r.key}
                className={`${styles.reaction} ${r.mine ? styles.reactionMine : ''}`}
                data-testid={`reaction-${r.key}`}
                data-count={r.count}
                data-mine={r.mine ? 'true' : 'false'}
                title={r.senders.map((s) => displayNameOf(room, s)).join(', ')}
                onClick={() => void withToast(() => toggleReaction(roomId, eventId, r.key), 'Reaction failed')}
              >
                <span>{r.key}</span>
                <span className={styles.reactionCount}>{r.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Body({ body }: { body: ReturnType<typeof getDisplayBody> }) {
  if (body.isRedacted) {
    return (
      <div className={`${styles.body} ${styles.redacted}`} data-testid="message-redacted">
        Message deleted
      </div>
    );
  }
  if (body.msgtype === MsgType.Image && body.url) {
    const w = body.info?.w ?? 400;
    const h = body.info?.h ?? 300;
    const scale = Math.min(1, 400 / w, 300 / h);
    return (
      <div className={styles.body} data-testid="message-body">
        <a href={mxcToHttp(body.url)} target="_blank" rel="noopener noreferrer">
          <img
            className={styles.image}
            data-testid="message-image"
            src={mxcToHttp(body.url, 400, 300, 'scale')}
            alt={body.text}
            width={Math.round(w * scale)}
            height={Math.round(h * scale)}
          />
        </a>
      </div>
    );
  }
  if (body.msgtype === MsgType.File && body.url) {
    return (
      <div className={styles.body} data-testid="message-body">
        <a href={mxcToHttp(body.url)} target="_blank" rel="noopener noreferrer" download={body.text}>
          {body.text}
        </a>
      </div>
    );
  }
  return (
    <div className={styles.body} data-testid="message-body">
      {body.html ? (
        <span className={styles.html} dangerouslySetInnerHTML={{ __html: sanitizeHtml(body.html) }} />
      ) : (
        <span className={styles.text}>
          {linkify(body.text).map((seg, i) =>
            seg.kind === 'link' ? (
              <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer">
                {seg.value}
              </a>
            ) : (
              <span key={i}>{seg.value}</span>
            ),
          )}
        </span>
      )}
      {body.isEdited && (
        <span className={styles.edited} data-testid="message-edited">
          (edited)
        </span>
      )}
    </div>
  );
}
