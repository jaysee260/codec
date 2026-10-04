/** Mimetype helpers for voice messages (pure, no browser APIs). */

/** `audio/webm;codecs=opus` -> `audio/webm`. Trims and lower-cases; '' stays ''. */
export function containerMimeType(mime: string | null | undefined): string {
  if (!mime) return '';
  return mime.split(';')[0]!.trim().toLowerCase();
}

/** File extension for a (container) mimetype: ogg | webm | m4a | wav | mp3 | bin. */
export function extensionFor(mime: string | null | undefined): string {
  const container = containerMimeType(mime);
  switch (container) {
    case 'audio/ogg':
    case 'application/ogg':
      return 'ogg';
    case 'audio/webm':
    case 'video/webm':
      return 'webm';
    case 'audio/mp4':
    case 'audio/x-m4a':
    case 'audio/m4a':
    case 'audio/aac':
    case 'video/mp4':
      return 'm4a';
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
      return 'wav';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/flac':
      return 'flac';
    default:
      return 'bin';
  }
}

/** `Voice message.<ext>`: the `org.matrix.msc1767.file.name` of a voice message. */
export function voiceFileName(mime: string | null | undefined): string {
  return `Voice message.${extensionFor(mime)}`;
}

export function isAudioMimeType(mime: string | null | undefined): boolean {
  return containerMimeType(mime).startsWith('audio/');
}
