/**
 * WebM/Opus -> Ogg/Opus remuxer, pure TypeScript (no DOM, no WASM; runs in the browser and in Node, so
 * Playwright specs can import it). Lossless: the Opus packets are copied byte for byte into Ogg pages.
 *
 *   remuxWebmOpusToOgg(bytes: Uint8Array): Uint8Array<ArrayBuffer>   throws WebmOpusError when not Opus-in-WebM
 *   parseWebmOpus(bytes): WebmOpusStream                            { opusHead, packets, channels, preSkip, ... }
 *   writeOggOpus(stream, opts?): Uint8Array<ArrayBuffer>            Ogg pages from parsed packets
 *   isWebmBytes(bytes) / isOggBytes(bytes)                          magic-number sniffing
 *   opusPacketSamples(packet): number                               48 kHz samples from the TOC byte (RFC 6716)
 *   oggCrc32(bytes): number                                         Ogg CRC (poly 0x04c11db7, no reflection)
 *   parseOggPages(bytes): OggPage[]                                 verification helper (page headers + CRC check)
 *
 * Input: what Chromium's MediaRecorder writes (EBML header, unknown-size Segment and Clusters, SimpleBlocks
 * without lacing, A_OPUS track with an OpusHead CodecPrivate). BlockGroup/Block and Xiph/EBML/fixed lacing are
 * handled too. Output: OpusHead (BOS) page, OpusTags page, audio pages of about one second (<= 255 lacing
 * values), granule positions = cumulative 48 kHz samples including pre-skip (RFC 7845), last page flagged EOS,
 * CRC on every page. A truncated trailing block (recorder killed mid-write) is dropped rather than rejected.
 */

export type WebmOpusErrorCode =
  | 'not-webm' // no EBML magic / not a WebM or Matroska DocType
  | 'not-opus' // no A_OPUS audio track
  | 'unsupported' // valid but outside what this remuxer handles (e.g. >2 channels without CodecPrivate)
  | 'malformed' // EBML structure or Opus packet we could not make sense of
  | 'empty'; // an Opus track but no audio packets

export class WebmOpusError extends Error {
  override readonly name = 'WebmOpusError';
  readonly code: WebmOpusErrorCode;
  constructor(code: WebmOpusErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function isWebmError(e: unknown): e is WebmOpusError {
  return e instanceof WebmOpusError || (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'WebmOpusError');
}

/* ------------------------------------------------------------------------------------------------ magic */

/** EBML magic `1A 45 DF A3` (WebM / Matroska). */
export function isWebmBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

/** `OggS` capture pattern. */
export function isOggBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
}

/* ------------------------------------------------------------------------------------------------ Opus TOC */

/**
 * Number of 48 kHz PCM samples an Opus packet decodes to: frame size (from the TOC config) x frame count
 * (TOC code; code 3 reads the frame-count byte). RFC 6716 section 3. Throws WebmOpusError('malformed') on an
 * empty packet or an invalid code-3 header.
 */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length === 0) throw new WebmOpusError('malformed', 'Empty Opus packet');
  const toc = packet[0]!;
  const config = toc >> 3;
  const code = toc & 0x03;
  let frameSamples: number;
  if (config < 12) frameSamples = [480, 960, 1920, 2880][config & 3]!; // SILK NB/MB/WB 10/20/40/60 ms
  else if (config < 16) frameSamples = [480, 960][config & 1]!; // Hybrid SWB/FB 10/20 ms
  else frameSamples = [120, 240, 480, 960][config & 3]!; // CELT 2.5/5/10/20 ms
  let frames: number;
  if (code === 0) frames = 1;
  else if (code < 3) frames = 2;
  else {
    if (packet.length < 2) throw new WebmOpusError('malformed', 'Opus code-3 packet without frame count byte');
    frames = packet[1]! & 0x3f;
    if (frames === 0) throw new WebmOpusError('malformed', 'Opus code-3 packet with zero frames');
  }
  const samples = frameSamples * frames;
  if (samples > 5760) throw new WebmOpusError('malformed', `Opus packet longer than 120 ms (${samples} samples)`);
  return samples;
}

/* ------------------------------------------------------------------------------------------------ EBML */

const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  Cues: 0x1c53bb6b,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
  Void: 0xec,
  Crc32: 0xbf,
} as const;

/** Level-1 IDs: an unknown-size Cluster ends when one of these starts. */
const SEGMENT_CHILD_IDS = new Set<number>([
  ID.SeekHead,
  ID.Info,
  ID.Tracks,
  ID.Cluster,
  ID.Cues,
  ID.Tags,
  ID.Chapters,
  ID.Attachments,
]);

interface EbmlElement {
  id: number;
  /** Offset of the first data byte. */
  dataStart: number;
  /** Offset one past the last data byte (clamped to the buffer; `unknownSize` elements end at the parent). */
  dataEnd: number;
  unknownSize: boolean;
  /** Offset one past the whole element (= dataEnd). */
  end: number;
  /** True when the declared size runs past the buffer (live recording cut mid-element); dataEnd is clamped. */
  truncated: boolean;
}

function vintLength(first: number): number {
  if (first === 0) return 0;
  let n = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    mask >>= 1;
    n++;
  }
  return n;
}

/** EBML element ID: the length marker bits stay in the value (0x1A45DFA3, 0xA3, ...). */
function readId(bytes: Uint8Array, pos: number, limit: number): { id: number; len: number } {
  if (pos >= limit) throw new WebmOpusError('malformed', `EBML: element ID past end at ${pos}`);
  const first = bytes[pos]!;
  const len = vintLength(first);
  if (len === 0 || len > 4 || pos + len > limit) throw new WebmOpusError('malformed', `EBML: bad element ID at ${pos}`);
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + bytes[pos + i]!;
  return { id, len };
}

/** EBML data size; `unknown` when all value bits are 1 (MediaRecorder's live Segment/Cluster). */
function readSize(bytes: Uint8Array, pos: number, limit: number): { size: number; len: number; unknown: boolean } {
  if (pos >= limit) throw new WebmOpusError('malformed', `EBML: element size past end at ${pos}`);
  const first = bytes[pos]!;
  const len = vintLength(first);
  if (len === 0 || len > 8 || pos + len > limit) throw new WebmOpusError('malformed', `EBML: bad element size at ${pos}`);
  let value = first & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    const b = bytes[pos + i]!;
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { size: value, len, unknown: allOnes };
}

function readElement(bytes: Uint8Array, pos: number, limit: number): EbmlElement {
  const { id, len: idLen } = readId(bytes, pos, limit);
  const { size, len: sizeLen, unknown } = readSize(bytes, pos + idLen, limit);
  const dataStart = pos + idLen + sizeLen;
  const declaredEnd = dataStart + size;
  const dataEnd = unknown ? limit : Math.min(limit, declaredEnd);
  return { id, dataStart, dataEnd, unknownSize: unknown, end: dataEnd, truncated: !unknown && declaredEnd > limit };
}

function readUint(bytes: Uint8Array, el: EbmlElement): number {
  let v = 0;
  for (let i = el.dataStart; i < el.dataEnd; i++) v = v * 256 + bytes[i]!;
  return v;
}

function readFloat(bytes: Uint8Array, el: EbmlElement): number {
  const n = el.dataEnd - el.dataStart;
  const view = new DataView(bytes.buffer, bytes.byteOffset + el.dataStart, n);
  if (n === 4) return view.getFloat32(0);
  if (n === 8) return view.getFloat64(0);
  return 0;
}

function readAscii(bytes: Uint8Array, el: EbmlElement): string {
  let s = '';
  for (let i = el.dataStart; i < el.dataEnd; i++) {
    const c = bytes[i]!;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Iterate the direct children of a master element's data range. Stops cleanly at a truncated trailing child. */
function* children(bytes: Uint8Array, start: number, end: number): Generator<EbmlElement> {
  let pos = start;
  while (pos < end) {
    let el: EbmlElement;
    try {
      el = readElement(bytes, pos, end);
    } catch {
      return; // truncated element header at the tail of a live recording
    }
    yield el;
    if (el.unknownSize) return; // only valid for the last child (Segment/Cluster), caller handles it
    pos = el.end;
  }
}

/* ------------------------------------------------------------------------------------------------ Opus head */

export interface OpusHeadInfo {
  version: number;
  channels: number;
  preSkip: number;
  inputSampleRate: number;
  outputGain: number;
  mappingFamily: number;
}

/** Parse an `OpusHead` identification header (RFC 7845 section 5.1); null when it is not one. */
export function parseOpusHead(head: Uint8Array): OpusHeadInfo | null {
  if (head.length < 19 || readAscii(head, { id: 0, dataStart: 0, dataEnd: 8, unknownSize: false, end: 8, truncated: false }) !== 'OpusHead') return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return {
    version: head[8]!,
    channels: head[9]!,
    preSkip: v.getUint16(10, true),
    inputSampleRate: v.getUint32(12, true),
    outputGain: v.getInt16(16, true),
    mappingFamily: head[18]!,
  };
}

/** Build an `OpusHead` for mapping family 0 (mono/stereo). */
export function buildOpusHead(opts: { channels: number; preSkip?: number; inputSampleRate?: number; outputGain?: number }): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(19));
  putAscii(out, 0, 'OpusHead');
  out[8] = 1;
  out[9] = opts.channels;
  const v = new DataView(out.buffer);
  v.setUint16(10, opts.preSkip ?? 0, true);
  v.setUint32(12, opts.inputSampleRate ?? 48000, true);
  v.setInt16(16, opts.outputGain ?? 0, true);
  out[18] = 0;
  return out;
}

const VENDOR = 'codec-webm-remux';

/** Build an `OpusTags` comment header (RFC 7845 section 5.2) with a vendor string and `KEY=value` comments. */
export function buildOpusTags(comments: string[] = []): Uint8Array<ArrayBuffer> {
  const items = comments.map((c) => utf8(c));
  const vendor = utf8(VENDOR);
  let size = 8 + 4 + vendor.length + 4;
  for (const it of items) size += 4 + it.length;
  const out = new Uint8Array(new ArrayBuffer(size));
  const v = new DataView(out.buffer);
  putAscii(out, 0, 'OpusTags');
  let p = 8;
  v.setUint32(p, vendor.length, true);
  p += 4;
  out.set(vendor, p);
  p += vendor.length;
  v.setUint32(p, items.length, true);
  p += 4;
  for (const it of items) {
    v.setUint32(p, it.length, true);
    p += 4;
    out.set(it, p);
    p += it.length;
  }
  return out;
}

function putAscii(out: Uint8Array, at: number, s: string): void {
  for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i) & 0xff;
}

function utf8(s: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

/* ------------------------------------------------------------------------------------------------ WebM parse */

export interface WebmOpusStream {
  /** The 19+ byte OpusHead that will become the BOS page (from CodecPrivate, or synthesized). */
  opusHead: Uint8Array;
  /** True when CodecPrivate was missing/invalid and `opusHead` was built from the Audio element. */
  synthesizedHead: boolean;
  channels: number;
  preSkip: number;
  inputSampleRate: number;
  /** Opus packets in stream order (views into the input buffer). */
  packets: Uint8Array[];
  /** Block timestamps in ms (cluster Timecode + block offset, scaled), parallel to `packets`. */
  timestampsMs: number[];
  /** Sum of `opusPacketSamples()` over `packets` (48 kHz). */
  totalSamples: number;
  /** Matroska track number the packets came from. */
  trackNumber: number;
}

interface TrackInfo {
  number: number;
  type: number;
  codecId: string;
  codecPrivate?: Uint8Array;
  codecDelayNs?: number;
  channels?: number;
  samplingFrequency?: number;
}

function parseTrackEntry(bytes: Uint8Array, entry: EbmlElement): TrackInfo {
  const t: TrackInfo = { number: 0, type: 0, codecId: '' };
  for (const el of children(bytes, entry.dataStart, entry.dataEnd)) {
    switch (el.id) {
      case ID.TrackNumber:
        t.number = readUint(bytes, el);
        break;
      case ID.TrackType:
        t.type = readUint(bytes, el);
        break;
      case ID.CodecID:
        t.codecId = readAscii(bytes, el);
        break;
      case ID.CodecPrivate:
        t.codecPrivate = bytes.subarray(el.dataStart, el.dataEnd);
        break;
      case ID.CodecDelay:
        t.codecDelayNs = readUint(bytes, el);
        break;
      case ID.Audio:
        for (const a of children(bytes, el.dataStart, el.dataEnd)) {
          if (a.id === ID.Channels) t.channels = readUint(bytes, a);
          else if (a.id === ID.SamplingFrequency) t.samplingFrequency = readFloat(bytes, a);
        }
        break;
      default:
        break;
    }
  }
  return t;
}

/**
 * A Matroska (Simple)Block: track vint, int16 relative timecode, flags, optional lacing, frame data.
 * Returns the frames (laced blocks carry several packets) or null when the block is for another track.
 */
function parseBlock(bytes: Uint8Array, el: EbmlElement, wantTrack: number): { frames: Uint8Array[]; timecode: number } | null {
  const start = el.dataStart;
  const end = el.dataEnd;
  if (end - start < 4) throw new WebmOpusError('malformed', `Block too short at ${start}`);
  const tn = readSize(bytes, start, end);
  if (tn.unknown) throw new WebmOpusError('malformed', `Block with unknown track number at ${start}`);
  let p = start + tn.len;
  if (p + 3 > end) throw new WebmOpusError('malformed', `Block header truncated at ${start}`);
  const timecode = ((bytes[p]! << 8) | bytes[p + 1]!) << 16 >> 16; // int16
  const flags = bytes[p + 2]!;
  p += 3;
  if (tn.size !== wantTrack) return null;
  const lacing = (flags >> 1) & 0x03;
  if (lacing === 0) return { frames: [bytes.subarray(p, end)], timecode };

  // Laced block: frame count byte, then sizes for all frames but the last.
  if (p >= end) throw new WebmOpusError('malformed', `Laced block without frame count at ${start}`);
  const count = bytes[p]! + 1;
  p++;
  const sizes: number[] = [];
  if (lacing === 1) {
    // Xiph: sum of bytes until one is < 255
    for (let i = 0; i < count - 1; i++) {
      let size = 0;
      let b: number;
      do {
        if (p >= end) throw new WebmOpusError('malformed', `Xiph lacing truncated at ${start}`);
        b = bytes[p++]!;
        size += b;
      } while (b === 255);
      sizes.push(size);
    }
  } else if (lacing === 3) {
    // EBML: first size is a vint, the rest signed vint deltas
    const first = readSize(bytes, p, end);
    p += first.len;
    sizes.push(first.size);
    for (let i = 1; i < count - 1; i++) {
      const d = readSize(bytes, p, end);
      p += d.len;
      const bias = Math.pow(2, 7 * d.len - 1) - 1;
      sizes.push(sizes[i - 1]! + (d.size - bias));
    }
  } else {
    // Fixed: equal sizes
    const total = end - p;
    if (total % count !== 0) throw new WebmOpusError('malformed', `Fixed lacing with uneven frames at ${start}`);
    for (let i = 0; i < count - 1; i++) sizes.push(total / count);
  }
  const frames: Uint8Array[] = [];
  for (const size of sizes) {
    if (size < 0 || p + size > end) throw new WebmOpusError('malformed', `Laced frame overruns block at ${start}`);
    frames.push(bytes.subarray(p, p + size));
    p += size;
  }
  frames.push(bytes.subarray(p, end));
  return { frames, timecode };
}

/** Parse Chromium-style WebM into the Opus track's packets. Throws WebmOpusError when it is not Opus-in-WebM. */
export function parseWebmOpus(bytes: Uint8Array): WebmOpusStream {
  if (!isWebmBytes(bytes)) throw new WebmOpusError('not-webm', 'Not an EBML/WebM stream');
  const limit = bytes.length;

  // EBML header
  const header = readElement(bytes, 0, limit);
  if (header.id !== ID.EBML) throw new WebmOpusError('not-webm', 'Not an EBML/WebM stream');
  for (const el of children(bytes, header.dataStart, header.dataEnd)) {
    if (el.id === ID.DocType) {
      const doc = readAscii(bytes, el);
      if (doc !== 'webm' && doc !== 'matroska') throw new WebmOpusError('not-webm', `EBML DocType is ${JSON.stringify(doc)}, not webm`);
    }
  }

  // Segment (usually unknown size)
  let segment: EbmlElement | undefined;
  for (const el of children(bytes, header.end, limit)) {
    if (el.id === ID.Segment) {
      segment = el;
      break;
    }
  }
  if (!segment) throw new WebmOpusError('malformed', 'No Segment element');

  let timecodeScale = 1_000_000; // ns per tick
  const tracks: TrackInfo[] = [];
  const clusters: EbmlElement[] = [];

  // Walk level 1. Unknown-size clusters are delimited by the next level-1 element.
  let pos = segment.dataStart;
  const segEnd = segment.dataEnd;
  while (pos < segEnd) {
    let el: EbmlElement;
    try {
      el = readElement(bytes, pos, segEnd);
    } catch {
      break; // truncated tail
    }
    if (el.unknownSize && el.id === ID.Cluster) {
      // Find the end: scan the cluster's children until a level-1 ID shows up.
      let p = el.dataStart;
      while (p < segEnd) {
        let child: EbmlElement;
        try {
          child = readElement(bytes, p, segEnd);
        } catch {
          p = segEnd;
          break;
        }
        if (SEGMENT_CHILD_IDS.has(child.id)) break;
        if (child.unknownSize) {
          p = segEnd;
          break;
        }
        p = child.end;
      }
      el = { ...el, dataEnd: p, end: p };
    } else if (el.unknownSize) {
      el = { ...el, dataEnd: segEnd, end: segEnd };
    }
    switch (el.id) {
      case ID.Info:
        for (const c of children(bytes, el.dataStart, el.dataEnd)) if (c.id === ID.TimecodeScale) timecodeScale = readUint(bytes, c) || timecodeScale;
        break;
      case ID.Tracks:
        for (const c of children(bytes, el.dataStart, el.dataEnd)) if (c.id === ID.TrackEntry) tracks.push(parseTrackEntry(bytes, c));
        break;
      case ID.Cluster:
        clusters.push(el);
        break;
      default:
        break;
    }
    if (el.end <= pos) break;
    pos = el.end;
  }

  if (tracks.length === 0) throw new WebmOpusError('malformed', 'WebM has no Tracks element (header missing?)');
  const track = tracks.find((t) => t.codecId === 'A_OPUS');
  if (!track) {
    const ids = tracks.map((t) => t.codecId || '?').join(', ');
    throw new WebmOpusError('not-opus', `WebM has no Opus audio track (codecs: ${ids})`);
  }
  if (track.type !== 0 && track.type !== 2) throw new WebmOpusError('not-opus', `A_OPUS track has TrackType ${track.type}, not audio`);

  // OpusHead: CodecPrivate, else synthesized from the Audio element.
  let opusHead: Uint8Array;
  let synthesizedHead = false;
  let info = track.codecPrivate ? parseOpusHead(track.codecPrivate) : null;
  if (info && track.codecPrivate) {
    opusHead = track.codecPrivate;
  } else {
    const channels = track.channels ?? 1;
    if (channels < 1 || channels > 2) throw new WebmOpusError('unsupported', `Cannot synthesize OpusHead for ${channels} channels without CodecPrivate`);
    const preSkip = track.codecDelayNs ? Math.round((track.codecDelayNs * 48000) / 1e9) : 0;
    const rate = track.samplingFrequency && track.samplingFrequency > 0 ? Math.round(track.samplingFrequency) : 48000;
    opusHead = buildOpusHead({ channels, preSkip, inputSampleRate: rate });
    info = parseOpusHead(opusHead)!;
    synthesizedHead = true;
  }

  // Packets
  const packets: Uint8Array[] = [];
  const timestampsMs: number[] = [];
  const msPerTick = timecodeScale / 1e6;
  let totalSamples = 0;
  for (const cluster of clusters) {
    let clusterTime = 0;
    for (const el of children(bytes, cluster.dataStart, cluster.dataEnd)) {
      let block: { frames: Uint8Array[]; timecode: number } | null = null;
      if (el.id === ID.Timecode) {
        clusterTime = readUint(bytes, el);
        continue;
      } else if (el.id === ID.SimpleBlock) {
        if (el.truncated) break; // trailing block cut mid-write: drop it
        block = parseBlock(bytes, el, track.number);
      } else if (el.id === ID.BlockGroup) {
        if (el.truncated) break;
        for (const c of children(bytes, el.dataStart, el.dataEnd)) {
          if (c.id === ID.Block && !c.truncated) block = parseBlock(bytes, c, track.number);
        }
      }
      if (!block) continue;
      for (const frame of block.frames) {
        if (frame.length === 0) continue;
        totalSamples += opusPacketSamples(frame);
        packets.push(frame);
        timestampsMs.push((clusterTime + block.timecode) * msPerTick);
      }
    }
  }
  if (packets.length === 0) throw new WebmOpusError('empty', 'Opus track has no audio packets');

  return {
    opusHead,
    synthesizedHead,
    channels: info.channels,
    preSkip: info.preSkip,
    inputSampleRate: info.inputSampleRate,
    packets,
    timestampsMs,
    totalSamples,
    trackNumber: track.number,
  };
}

/* ------------------------------------------------------------------------------------------------ Ogg write */

let crcTable: Uint32Array | undefined;

/** Ogg page CRC-32: polynomial 0x04c11db7, no bit reflection, init 0, no final XOR. */
export function oggCrc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let j = 0; j < 8; j++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
      crcTable[i] = r >>> 0;
    }
  }
  let crc = 0;
  for (let i = start; i < end; i++) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ bytes[i]!) & 0xff]!) >>> 0;
  return crc >>> 0;
}

export interface OggWriteOptions {
  /** Bitstream serial number (random when omitted). */
  serial?: number;
  /** Start a new audio page once this many 48 kHz samples have been queued on it. Default 48000 (1 s). */
  samplesPerPage?: number;
  /** Extra `KEY=value` comments for OpusTags. */
  comments?: string[];
}

class OggPageWriter {
  private readonly pages: Uint8Array[] = [];
  private seq = 0;
  private total = 0;
  // Current page under construction
  private lacing: number[] = [];
  private chunks: Uint8Array[] = [];
  private dataLen = 0;
  private continued = false;
  private granule = -1n;
  private pendingSamples = 0;
  private completedOnPage = 0;

  private readonly serial: number;

  constructor(serial: number) {
    this.serial = serial;
  }

  /** Queue a whole packet; `granuleAfter` is the stream granule once this packet is complete. */
  addPacket(packet: Uint8Array, granuleAfter: bigint, flags: { bos?: boolean; eos?: boolean } = {}): void {
    let offset = 0;
    let remaining = packet.length;
    // A packet of exactly n*255 bytes ends with a 0 lacing value.
    for (;;) {
      if (this.lacing.length === 255) this.flush(false, false);
      const take = Math.min(255, remaining);
      this.lacing.push(take);
      if (take > 0) {
        this.chunks.push(packet.subarray(offset, offset + take));
        this.dataLen += take;
      }
      offset += take;
      remaining -= take;
      if (take < 255) break;
      if (remaining === 0) {
        // exactly a multiple of 255: terminating zero lacing value
        if (this.lacing.length === 255) this.flush(false, false);
        this.lacing.push(0);
        break;
      }
    }
    this.granule = granuleAfter;
    this.completedOnPage++;
    if (flags.bos || flags.eos) this.flush(!!flags.bos, !!flags.eos);
  }

  /** Account samples queued on the current page (for the 1-second page policy). */
  addSamples(n: number): void {
    this.pendingSamples += n;
  }

  get queuedSamples(): number {
    return this.pendingSamples;
  }

  get hasQueued(): boolean {
    return this.lacing.length > 0;
  }

  flush(bos: boolean, eos: boolean): void {
    if (this.lacing.length === 0 && !eos) return;
    const headerLen = 27 + this.lacing.length;
    const page = new Uint8Array(new ArrayBuffer(headerLen + this.dataLen));
    const v = new DataView(page.buffer);
    putAscii(page, 0, 'OggS');
    page[4] = 0;
    page[5] = (this.continued ? 0x01 : 0) | (bos ? 0x02 : 0) | (eos ? 0x04 : 0);
    // Granule: -1 when no packet completes on this page.
    const g = this.completedOnPage > 0 ? this.granule : -1n;
    v.setBigInt64(6, g, true);
    v.setUint32(14, this.serial, true);
    v.setUint32(18, this.seq++, true);
    v.setUint32(22, 0, true);
    page[26] = this.lacing.length;
    for (let i = 0; i < this.lacing.length; i++) page[27 + i] = this.lacing[i]!;
    let p = headerLen;
    for (const c of this.chunks) {
      page.set(c, p);
      p += c.length;
    }
    v.setUint32(22, oggCrc32(page), true);
    this.pages.push(page);
    this.total += page.length;

    // The page ended mid-packet when the last lacing value is 255.
    this.continued = this.lacing[this.lacing.length - 1] === 255;
    this.lacing = [];
    this.chunks = [];
    this.dataLen = 0;
    this.pendingSamples = 0;
    this.completedOnPage = 0;
  }

  finish(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(new ArrayBuffer(this.total));
    let p = 0;
    for (const page of this.pages) {
      out.set(page, p);
      p += page.length;
    }
    return out;
  }
}

/** Write an Ogg/Opus file (RFC 7845) from parsed packets. */
export function writeOggOpus(stream: Pick<WebmOpusStream, 'opusHead' | 'packets'>, opts: OggWriteOptions = {}): Uint8Array<ArrayBuffer> {
  const serial = (opts.serial ?? Math.floor(Math.random() * 0x100000000)) >>> 0;
  const perPage = Math.max(1, opts.samplesPerPage ?? 48000);
  const w = new OggPageWriter(serial);
  w.addPacket(stream.opusHead, 0n, { bos: true });
  w.addPacket(buildOpusTags(opts.comments ?? []), 0n, { eos: false });
  w.flush(false, false); // OpusTags must end its page before audio starts (RFC 7845 section 3)

  let granule = 0n;
  const n = stream.packets.length;
  for (let i = 0; i < n; i++) {
    const packet = stream.packets[i]!;
    const samples = opusPacketSamples(packet);
    granule += BigInt(samples);
    const last = i === n - 1;
    w.addPacket(packet, granule, { eos: last });
    w.addSamples(samples);
    if (!last && w.queuedSamples >= perPage) w.flush(false, false);
  }
  if (n === 0) w.flush(false, true);
  return w.finish();
}

/**
 * Chromium MediaRecorder WebM/Opus -> Ogg/Opus, losslessly. Throws WebmOpusError for anything that is not
 * Opus-in-WebM (callers fall back to sending the original blob).
 */
export function remuxWebmOpusToOgg(bytes: Uint8Array, opts: OggWriteOptions = {}): Uint8Array<ArrayBuffer> {
  return writeOggOpus(parseWebmOpus(bytes), opts);
}

/* ------------------------------------------------------------------------------------------------ Ogg read (verification) */

export interface OggPage {
  offset: number;
  length: number;
  version: number;
  continued: boolean;
  bos: boolean;
  eos: boolean;
  granule: bigint;
  serial: number;
  sequence: number;
  crc: number;
  /** True when the stored CRC matches the computed one. */
  crcOk: boolean;
  segments: number;
  lacing: number[];
  /** Page body (all segments concatenated). */
  body: Uint8Array;
  /** Packets that complete on this page (a packet continued from the previous page is included from its start on this page only). */
  completedPackets: number;
}

/** Split an Ogg stream into pages, verifying each CRC. Throws WebmOpusError('malformed') on a broken page header. */
export function parseOggPages(bytes: Uint8Array): OggPage[] {
  const pages: OggPage[] = [];
  let pos = 0;
  while (pos + 27 <= bytes.length) {
    if (!isOggBytes(bytes.subarray(pos, pos + 4))) throw new WebmOpusError('malformed', `No OggS capture pattern at ${pos}`);
    const v = new DataView(bytes.buffer, bytes.byteOffset + pos, Math.min(27, bytes.length - pos));
    const flags = bytes[pos + 5]!;
    const segments = bytes[pos + 26]!;
    const headerLen = 27 + segments;
    if (pos + headerLen > bytes.length) throw new WebmOpusError('malformed', `Ogg page header truncated at ${pos}`);
    const lacing: number[] = [];
    let bodyLen = 0;
    let completed = 0;
    for (let i = 0; i < segments; i++) {
      const l = bytes[pos + 27 + i]!;
      lacing.push(l);
      bodyLen += l;
      if (l < 255) completed++;
    }
    const length = headerLen + bodyLen;
    if (pos + length > bytes.length) throw new WebmOpusError('malformed', `Ogg page body truncated at ${pos}`);
    const stored = v.getUint32(22, true);
    const copy = bytes.slice(pos, pos + length);
    copy[22] = copy[23] = copy[24] = copy[25] = 0;
    const computed = oggCrc32(copy);
    pages.push({
      offset: pos,
      length,
      version: bytes[pos + 4]!,
      continued: (flags & 0x01) !== 0,
      bos: (flags & 0x02) !== 0,
      eos: (flags & 0x04) !== 0,
      granule: v.getBigInt64(6, true),
      serial: v.getUint32(14, true),
      sequence: v.getUint32(18, true),
      crc: stored,
      crcOk: stored === computed,
      segments,
      lacing,
      body: bytes.subarray(pos + headerLen, pos + length),
      completedPackets: completed,
    });
    pos += length;
  }
  return pages;
}
