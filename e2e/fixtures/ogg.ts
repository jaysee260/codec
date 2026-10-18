/**
 * Independent Ogg / WebM readers for the voice-format specs (docs/VOICE_FORMAT_PLAN.md AC-F1/F2, the
 * remux spec). Deliberately written from RFC 3533 / RFC 7845 / the Matroska spec and **not** shared
 * with `src/lib/audio/ogg.ts`: a bug in the remuxer must not be able to make its own check pass.
 *
 *   parseOggPages(bytes)  every page, CRC recomputed and compared, packets reassembled from lacing
 *   readOpusHead(packet)  the fields RFC 7845 section 5.1 defines
 *   opusPacketSamples(p)  samples at 48 kHz from the TOC byte (RFC 6716 section 3.1)
 *   readWebmOpus(bytes)   CodecPrivate + every SimpleBlock/Block frame of the first audio track
 */

/* ------------------------------------------------------------------ Ogg */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let j = 0; j < 8; j += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** Ogg CRC-32: polynomial 0x04C11DB7, init 0, no reflection, no final xor (RFC 3533 section 6). */
export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

export interface OggPage {
  offset: number;
  length: number;
  version: number;
  headerType: number;
  continued: boolean;
  bos: boolean;
  eos: boolean;
  granule: bigint;
  serial: number;
  sequence: number;
  crcStored: number;
  crcComputed: number;
  segments: number[];
  /** Packets that *complete* on this page (a packet continued from earlier pages is included whole). */
  completedPackets: Uint8Array[];
  /** True when the page's last segment is 255, i.e. a packet continues on the next page. */
  endsMidPacket: boolean;
}

export interface OggParse {
  pages: OggPage[];
  /** Every packet in stream order. */
  packets: Uint8Array[];
  /** Bytes after the last complete page (must be 0 for a well-formed file). */
  trailing: number;
}

/** Parses a whole Ogg stream. Throws on a missing capture pattern or a truncated page. */
export function parseOggPages(bytes: Uint8Array): OggParse {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pages: OggPage[] = [];
  const packets: Uint8Array[] = [];
  let pending: Uint8Array[] = [];
  let off = 0;
  while (off + 27 <= bytes.length) {
    const magic = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
    if (magic !== 'OggS') throw new Error(`no OggS capture pattern at byte ${off}`);
    const nseg = bytes[off + 26];
    const headerLen = 27 + nseg;
    if (off + headerLen > bytes.length) throw new Error(`truncated page header at ${off}`);
    const segments = [...bytes.subarray(off + 27, off + 27 + nseg)];
    const bodyLen = segments.reduce((a, b) => a + b, 0);
    const length = headerLen + bodyLen;
    if (off + length > bytes.length) throw new Error(`truncated page body at ${off}`);

    const pageBytes = bytes.slice(off, off + length);
    const crcStored = view.getUint32(off + 22, true);
    pageBytes[22] = pageBytes[23] = pageBytes[24] = pageBytes[25] = 0;
    const crcComputed = oggCrc(pageBytes);

    const headerType = bytes[off + 5];
    const completedPackets: Uint8Array[] = [];
    let p = off + headerLen;
    for (const seg of segments) {
      pending.push(bytes.subarray(p, p + seg));
      p += seg;
      if (seg < 255) {
        const total = pending.reduce((a, b) => a + b.length, 0);
        const packet = new Uint8Array(total);
        let o = 0;
        for (const part of pending) {
          packet.set(part, o);
          o += part.length;
        }
        completedPackets.push(packet);
        packets.push(packet);
        pending = [];
      }
    }

    pages.push({
      offset: off,
      length,
      version: bytes[off + 4],
      headerType,
      continued: (headerType & 0x01) !== 0,
      bos: (headerType & 0x02) !== 0,
      eos: (headerType & 0x04) !== 0,
      granule: view.getBigInt64(off + 6, true),
      serial: view.getUint32(off + 14, true),
      sequence: view.getUint32(off + 18, true),
      crcStored,
      crcComputed,
      segments,
      completedPackets,
      endsMidPacket: segments.length > 0 && segments[segments.length - 1] === 255,
    });
    off += length;
  }
  return { pages, packets, trailing: bytes.length - off };
}

export interface OpusHead {
  version: number;
  channels: number;
  preSkip: number;
  inputSampleRate: number;
  outputGain: number;
  mappingFamily: number;
}

export function readOpusHead(packet: Uint8Array): OpusHead {
  const ascii = String.fromCharCode(...packet.subarray(0, 8));
  if (ascii !== 'OpusHead') throw new Error(`not an OpusHead packet: ${JSON.stringify(ascii)}`);
  const v = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  return {
    version: packet[8],
    channels: packet[9],
    preSkip: v.getUint16(10, true),
    inputSampleRate: v.getUint32(12, true),
    outputGain: v.getInt16(16, true),
    mappingFamily: packet[18],
  };
}

/** Samples (at 48 kHz) in one Opus packet, from its TOC byte and frame-count code (RFC 6716 3.1). */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length < 1) throw new Error('empty Opus packet');
  const toc = packet[0];
  const config = toc >> 3;
  let frameSamples: number;
  if (config < 12) frameSamples = [480, 960, 1920, 2880][config & 3]; // SILK 10/20/40/60 ms
  else if (config < 16) frameSamples = [480, 960][config & 1]; // Hybrid 10/20 ms
  else frameSamples = [120, 240, 480, 960][config & 3]; // CELT 2.5/5/10/20 ms
  const code = toc & 3;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else {
    if (packet.length < 2) throw new Error('code-3 Opus packet without a frame count byte');
    frames = packet[1] & 0x3f;
  }
  return frames * frameSamples;
}

/* ------------------------------------------------------------------ WebM (Matroska subset) */

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Cluster: 0x1f43b675,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
} as const;

/** Masters we step *into* rather than over (so unknown-size Segment/Cluster need no special case). */
const DESCEND = new Set<number>([ID.Segment, ID.Cluster, ID.Tracks, ID.TrackEntry, ID.BlockGroup]);

function readVint(bytes: Uint8Array, off: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } {
  const first = bytes[off];
  if (first === undefined) throw new Error(`vint past end at ${off}`);
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8) throw new Error(`invalid vint at ${off}`);
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i += 1) {
    const b = bytes[off + i];
    if (b === undefined) throw new Error(`vint past end at ${off}`);
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

export interface WebmOpus {
  codecId: string;
  codecPrivate: Uint8Array | null;
  frames: Uint8Array[];
}

/** CodecPrivate and every frame of a single-track, unlaced WebM/Opus file (what MediaRecorder writes). */
export function readWebmOpus(bytes: Uint8Array): WebmOpus {
  if (readVint(bytes, 0, true).value !== ID.EBML) throw new Error('not an EBML file');
  let codecId = '';
  let codecPrivate: Uint8Array | null = null;
  const frames: Uint8Array[] = [];
  let off = 0;
  while (off < bytes.length) {
    let id: { value: number; length: number };
    let size: { value: number; length: number; unknown: boolean };
    try {
      id = readVint(bytes, off, true);
      size = readVint(bytes, off + id.length, false);
    } catch {
      break; // a truncated tail
    }
    const dataStart = off + id.length + size.length;
    if (DESCEND.has(id.value)) {
      off = dataStart;
      continue;
    }
    const dataEnd = size.unknown ? bytes.length : dataStart + size.value;
    if (dataEnd > bytes.length) break; // truncated element
    const data = bytes.subarray(dataStart, dataEnd);
    if (id.value === ID.CodecID) codecId = new TextDecoder().decode(data);
    if (id.value === ID.CodecPrivate) codecPrivate = data.slice();
    if (id.value === ID.SimpleBlock || id.value === ID.Block) {
      const track = readVint(data, 0, false);
      const flags = data[track.length + 2];
      if ((flags & 0x06) !== 0) throw new Error('laced blocks are not expected from MediaRecorder');
      frames.push(data.slice(track.length + 3));
    }
    off = dataEnd;
  }
  return { codecId, codecPrivate, frames };
}
