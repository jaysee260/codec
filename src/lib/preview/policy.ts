/**
 * The one place that knows *when* a preview may be requested (Phase 6, brief decisions 1-2), plus the
 * event-level convenience over `extractPreviewUrls`.
 *
 * Encrypted rooms: asking the homeserver for a preview reveals the URL, which defeats E2EE, so nothing is fetched
 * automatically; each link gets a "Show preview" button and the click calls `getLinkPreview` for that one URL.
 * Same spirit as GIFs (AC-E6-5 click-to-load).
 */
import type { MatrixEvent } from 'matrix-js-sdk';
import { getHsUrl } from '../matrix/config.ts';
import { getDisplayBody, isRoomEncrypted } from '../matrix/utils.ts';
import { extractPreviewUrls, PREVIEW_MAX_LINKS } from './extract.ts';

/**
 * True when previews may be fetched without a click: the room has no `m.room.encryption`. Pass the event too and
 * an encrypted event in a (still) unencrypted room also counts as encrypted (the SDK ignores encryption removal,
 * but be conservative).
 */
export function shouldAutoPreview(roomId: string | null | undefined, event?: Pick<MatrixEvent, 'isEncrypted'> | null): boolean {
  if (event?.isEncrypted()) return false;
  return !isRoomEncrypted(roomId);
}

/**
 * The previewable links of a timeline event (message order, deduped, at most `max` = 3), using the current
 * homeserver URL for the own-media rule. Empty for GIFs, redacted / undecryptable / decrypting events and media.
 * Does not look at the room's encryption: in an encrypted room these are the links that get a button.
 */
export function getPreviewUrls(event: MatrixEvent, max: number = PREVIEW_MAX_LINKS): string[] {
  if (event.getType() !== 'm.room.message' && event.getType() !== 'm.room.encrypted') return [];
  if (event.isRedacted()) return [];
  return extractPreviewUrls(getDisplayBody(event), { max, hsUrl: getHsUrl() });
}
