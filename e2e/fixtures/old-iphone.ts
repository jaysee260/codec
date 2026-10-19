/**
 * "Old iPhone" simulation for Chromium (docs/archive/VOICE_FORMAT_PLAN.md AC-F5..F7, F11): a browser that can
 * play neither Ogg nor WebM natively (iOS Safari < 18.4), but plays WAV/MP4/AAC. Install it with
 * {@link simulateOldIphone} **before** the first navigation (it is an init script).
 *
 * What it changes, so the app *must* take its software-decode fallback:
 *  1. `HTMLMediaElement.prototype.canPlayType` returns `''` for any `audio|video/(ogg|webm)*` type
 *     (unless `canPlayTypeLies`, which answers `'maybe'` like some WKWebViews do; then only step 2
 *     stops native playback and the app's *format-error* fallback is what gets tested).
 *  2. `<audio>` refuses Ogg/WebM sources. `URL.createObjectURL` records each Blob's type, and when
 *     `src` (property or attribute, `new Audio(url)` included) is set to a blob: URL of an Ogg/WebM
 *     blob, or to an http(s) URL ending in .ogg/.oga/.opus/.webm, the element is really pointed at an
 *     unloadable source, so it fires `error` with `MEDIA_ERR_SRC_NOT_SUPPORTED` and `play()` rejects
 *     with `NotSupportedError` — the way Safari fails. The `src` / `currentSrc` getters keep returning
 *     the URL the app set, so the app's own bookkeeping (which path a failing source belongs to) sees
 *     what it would on a real device.
 *  3. `AudioContext.decodeAudioData` rejects Ogg/WebM bytes (magic `OggS` / `1A 45 DF A3`) with
 *     `EncodingError`, so an accidental Web Audio path cannot make a fallback test pass in Chromium.
 *
 * `window.__qaOldIphone` records what the simulation refused (`refused`, `decodeRefused`) and every
 * blob type it saw (`blobTypes`), for assertions and for triage in a failing trace.
 */
import type { Page } from '@playwright/test';

export interface OldIphoneOptions {
  /** Answer `'maybe'` instead of `''` for Ogg/WebM (the app must then recover from the `<audio>` error). */
  canPlayTypeLies?: boolean;
}

export interface OldIphoneLog {
  refused: string[];
  decodeRefused: number;
  blobTypes: string[];
}

export async function simulateOldIphone(page: Page, opts: OldIphoneOptions = {}): Promise<void> {
  await page.addInitScript(({ lies }) => {
    const BLOCKED_TYPE = /^(audio|video)\/(ogg|webm|x-matroska)\b/i;
    const BLOCKED_EXT = /\.(ogg|oga|opus|webm)(\?|#|$)/i;
    const UNSUPPORTED = 'data:audio/x-qa-unsupported;base64,AAAAAAAA';
    const log = { refused: [] as string[], decodeRefused: 0, blobTypes: [] as string[] };
    (window as unknown as { __qaOldIphone: typeof log }).__qaOldIphone = log;

    // 1. canPlayType
    const canPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type: string): CanPlayTypeResult {
      if (BLOCKED_TYPE.test(type.trim())) return lies ? 'maybe' : '';
      return canPlayType.call(this, type);
    };

    // 2. <audio> refuses Ogg/WebM sources
    const blobType = new Map<string, string>();
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource): string => {
      const url = createObjectURL(obj);
      if (obj instanceof Blob) {
        blobType.set(url, obj.type);
        log.blobTypes.push(obj.type || '(empty)');
      }
      return url;
    };
    const refuses = (value: string): boolean => {
      if (value.startsWith('blob:')) return BLOCKED_TYPE.test(blobType.get(value) ?? '');
      if (/^https?:/i.test(value)) return BLOCKED_EXT.test(value);
      return false;
    };
    const appSrc = new WeakMap<HTMLMediaElement, string>();
    const srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')!;
    const currentSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentSrc')!;
    const setSrc = (el: HTMLMediaElement, value: string): void => {
      if (refuses(value)) {
        log.refused.push(`${blobType.get(value) ?? ''} ${value}`.trim());
        appSrc.set(el, value);
        srcDesc.set!.call(el, UNSUPPORTED);
        return;
      }
      appSrc.delete(el);
      srcDesc.set!.call(el, value);
    };
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      enumerable: srcDesc.enumerable,
      get(this: HTMLMediaElement) {
        return appSrc.get(this) ?? srcDesc.get!.call(this);
      },
      set(this: HTMLMediaElement, value: string) {
        setSrc(this, String(value));
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'currentSrc', {
      configurable: true,
      enumerable: currentSrcDesc.enumerable,
      get(this: HTMLMediaElement) {
        const real = currentSrcDesc.get!.call(this) as string;
        const app = appSrc.get(this);
        return app && real === UNSUPPORTED ? app : real;
      },
    });
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name: string, value: string): void {
      if (this instanceof HTMLMediaElement && name.toLowerCase() === 'src') {
        setSrc(this, String(value));
        return;
      }
      setAttribute.call(this, name, value);
    };
    const NativeAudio = window.Audio;
    const PatchedAudio = function (this: unknown, src?: string): HTMLAudioElement {
      const el = new NativeAudio();
      if (src !== undefined) el.src = src;
      return el;
    } as unknown as typeof Audio;
    PatchedAudio.prototype = NativeAudio.prototype;
    window.Audio = PatchedAudio;

    // 3. Web Audio cannot decode Ogg/WebM either
    const isBlockedBytes = (buf: ArrayBuffer): boolean => {
      const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      const ogg = b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53;
      const ebml = b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
      return ogg || ebml;
    };
    for (const Ctx of [window.AudioContext, (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext]) {
      if (!Ctx) continue;
      const decode = Ctx.prototype.decodeAudioData;
      Ctx.prototype.decodeAudioData = function (
        this: BaseAudioContext,
        data: ArrayBuffer,
        ok?: DecodeSuccessCallback | null,
        fail?: DecodeErrorCallback | null,
      ): Promise<AudioBuffer> {
        if (data && isBlockedBytes(data)) {
          log.decodeRefused += 1;
          const err = new DOMException('Unable to decode audio data', 'EncodingError');
          if (fail) setTimeout(() => fail(err), 0);
          return Promise.reject(err);
        }
        return decode.call(this, data, ok ?? undefined, fail ?? undefined);
      } as typeof decode;
    }
  }, { lies: !!opts.canPlayTypeLies });
}

export function oldIphoneLog(page: Page): Promise<OldIphoneLog> {
  return page.evaluate(
    () => (window as unknown as { __qaOldIphone: OldIphoneLog }).__qaOldIphone ?? { refused: [], decodeRefused: 0, blobTypes: [] },
  );
}

/** URLs that belong to the lazily loaded software decoder (Vite dev: `/node_modules/.vite/deps/ogg-opus-decoder.js`). */
export const DECODER_URL = /ogg-opus-decoder|wasm-audio-decoders|opus-ml|codec-parser/i;

/** Records every request whose URL looks like the decoder chunk, from now until the page closes. */
export function watchDecoderRequests(page: Page): string[] {
  const hits: string[] = [];
  page.on('request', (req) => {
    if (DECODER_URL.test(req.url())) hits.push(req.url());
  });
  return hits;
}
