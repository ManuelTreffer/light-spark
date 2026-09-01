import { describe, it, expect } from 'vitest';
import {
  encodeCommonFrameHeader,
  decodeCommonFrameHeader,
  encodeDataFrameHeader,
  decodeDataFrameHeader,
  isSystematic,
} from './frameHeader';
import { encodeManifest, decodeManifest } from './manifest';
import { generateTransferId, transferIdsEqual, transferIdToHex, transferIdFromHex } from './transferId';
import {
  FrameType,
  FLAG_SYSTEMATIC,
  PROTOCOL_VERSION,
  MAX_FILE_NAME_BYTES,
  MAX_MIME_TYPE_BYTES,
  MAX_TRANSFER_BYTES,
  type ManifestPayload,
} from './types';
import { pickIndices } from '../core/fountain';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

describe('transferId', () => {
  it('generates TRANSFER_ID_BYTES random bytes that differ between calls', () => {
    const a = generateTransferId();
    const b = generateTransferId();
    expect(a.length).toBe(16);
    expect(b.length).toBe(16);
    expect(transferIdsEqual(a, b)).toBe(false); // astronomically unlikely to collide
  });

  it('compares by content, not identity', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    const c = new Uint8Array([1, 2, 4]);
    expect(transferIdsEqual(a, b)).toBe(true);
    expect(transferIdsEqual(a, c)).toBe(false);
    expect(transferIdsEqual(a, new Uint8Array([1, 2]))).toBe(false);
  });

  it('formats as lowercase hex', () => {
    expect(transferIdToHex(new Uint8Array([0, 15, 255, 16]))).toBe('000fff10');
  });

  it('round-trips through hex', () => {
    const id = generateTransferId();
    expect(transferIdFromHex(transferIdToHex(id))).toEqual(id);
  });

  it('rejects malformed hex instead of returning junk', () => {
    expect(transferIdFromHex('00')).toBeNull(); // too short
    expect(transferIdFromHex('0'.repeat(31))).toBeNull(); // odd length
    expect(transferIdFromHex('g'.repeat(32))).toBeNull(); // not hex
    expect(transferIdFromHex('0'.repeat(34))).toBeNull(); // too long
  });
});

describe('CommonFrameHeader — golden vector', () => {
  // Hand-computed, not round-tripped through the encoder — see docs/protocol-v2.md §2.
  //
  //   offset  bytes                                          field
  //   0       4C 53                                          magic "LS"
  //   2       02                                              protocolVersion = 2
  //   3       02                                              frameType = Data (2)
  //   4       01                                              flags = FLAG_SYSTEMATIC
  //   5       00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F  transferId (16 bytes)
  //   21      00 00 00 07                                     sequenceNumber = 7
  //   25      00 00                                            payloadLength = 0
  //
  // payloadLength is 0 deliberately: this buffer is exactly COMMON_HEADER_SIZE
  // bytes (a header with no payload attached), so it stays self-consistent
  // without needing to append a matching amount of dummy payload data.
  const golden = new Uint8Array([
    0x4c, 0x53, 0x02, 0x02, 0x01, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
    0x0e, 0x0f, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00,
  ]);
  const transferId = Uint8Array.from({ length: 16 }, (_, i) => i);

  it('is exactly 27 bytes', () => {
    expect(golden.length).toBe(27);
  });

  it('decodes to the expected logical header', () => {
    const decoded = decodeCommonFrameHeader(golden);
    expect(decoded).not.toBeNull();
    expect(decoded!.payloadOffset).toBe(27);
    expect(decoded!.header).toEqual({
      protocolVersion: 2,
      frameType: FrameType.Data,
      flags: FLAG_SYSTEMATIC,
      transferId,
      sequenceNumber: 7,
      payloadLength: 0,
    });
  });

  it('encodes to exactly the golden bytes', () => {
    const encoded = encodeCommonFrameHeader({
      protocolVersion: PROTOCOL_VERSION,
      frameType: FrameType.Data,
      flags: FLAG_SYSTEMATIC,
      transferId,
      sequenceNumber: 7,
      payloadLength: 0,
    });
    expect(hex(encoded)).toBe(hex(golden));
  });
});

describe('CommonFrameHeader — rejects', () => {
  const validHeader = () =>
    encodeCommonFrameHeader({
      protocolVersion: PROTOCOL_VERSION,
      frameType: FrameType.Manifest,
      flags: 0,
      transferId: new Uint8Array(16),
      sequenceNumber: 1,
      payloadLength: 5,
    });

  it('too short a buffer', () => {
    expect(decodeCommonFrameHeader(new Uint8Array(26))).toBeNull();
    expect(decodeCommonFrameHeader(new Uint8Array(0))).toBeNull();
  });

  it('wrong magic', () => {
    const bytes = validHeader();
    bytes[0] = 0x00;
    expect(decodeCommonFrameHeader(bytes)).toBeNull();
  });

  it('unknown protocol version — never guess at a layout', () => {
    const bytes = validHeader();
    bytes[2] = 99;
    expect(decodeCommonFrameHeader(bytes)).toBeNull();
  });

  it('unknown frame type', () => {
    const bytes = validHeader();
    bytes[3] = 0; // 0 is not a defined FrameType
    expect(decodeCommonFrameHeader(bytes)).toBeNull();
    bytes[3] = 7; // one past the last defined type
    expect(decodeCommonFrameHeader(bytes)).toBeNull();
  });

  it('declared payloadLength exceeding the actual buffer — rejected before any read of the payload', () => {
    const bytes = validHeader(); // declares payloadLength = 5 but carries 0 payload bytes
    expect(decodeCommonFrameHeader(bytes)).toBeNull();
    const withRealPayload = new Uint8Array([...bytes, 1, 2, 3, 4, 5]);
    expect(decodeCommonFrameHeader(withRealPayload)).not.toBeNull();
  });

  it('reserved flag bits are preserved, not rejected', () => {
    const bytes = encodeCommonFrameHeader({
      protocolVersion: PROTOCOL_VERSION,
      frameType: FrameType.Manifest,
      flags: 0b1111_1110, // every bit except SYSTEMATIC set
      transferId: new Uint8Array(16),
      sequenceNumber: 0,
      payloadLength: 0,
    });
    const decoded = decodeCommonFrameHeader(bytes);
    expect(decoded).not.toBeNull();
    expect(decoded!.header.flags).toBe(0b1111_1110);
  });

  it('encoder rejects a malformed transferId or an out-of-range payloadLength', () => {
    expect(() =>
      encodeCommonFrameHeader({
        protocolVersion: PROTOCOL_VERSION,
        frameType: FrameType.Data,
        flags: 0,
        transferId: new Uint8Array(15), // wrong length
        sequenceNumber: 0,
        payloadLength: 0,
      }),
    ).toThrow();
    expect(() =>
      encodeCommonFrameHeader({
        protocolVersion: PROTOCOL_VERSION,
        frameType: FrameType.Data,
        flags: 0,
        transferId: new Uint8Array(16),
        sequenceNumber: 0,
        payloadLength: 0x10000, // exceeds uint16
      }),
    ).toThrow();
  });
});

describe('DataFrameHeader — golden vectors', () => {
  it('a combinatorial (non-systematic) drop', () => {
    // offset 0: 00 00 00 03  blockIndex = 3
    // offset 4: 00 64        blockSourceChunkCount = 100
    // offset 6: 00 00 00 96  dropletSeed = 150 (>= 100, so not systematic)
    // offset 10: 03           dropletDegree = 3
    const golden = new Uint8Array([0x00, 0x00, 0x00, 0x03, 0x00, 0x64, 0x00, 0x00, 0x00, 0x96, 0x03]);
    expect(golden.length).toBe(11);

    const decoded = decodeDataFrameHeader(golden);
    expect(decoded).toEqual({ blockIndex: 3, blockSourceChunkCount: 100, dropletSeed: 150, dropletDegree: 3 });
    expect(isSystematic(150, 100)).toBe(false);

    expect(hex(encodeDataFrameHeader(decoded!))).toBe(hex(golden));
  });

  it('a systematic drop (dropletSeed < blockSourceChunkCount)', () => {
    // offset 0: 00 00 00 00  blockIndex = 0
    // offset 4: 00 0A        blockSourceChunkCount = 10
    // offset 6: 00 00 00 04  dropletSeed = 4 (< 10, systematic)
    // offset 10: 01           dropletDegree = 1 (forced by the systematic convention)
    const golden = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x04, 0x01]);
    expect(golden.length).toBe(11);

    const decoded = decodeDataFrameHeader(golden);
    expect(decoded).toEqual({ blockIndex: 0, blockSourceChunkCount: 10, dropletSeed: 4, dropletDegree: 1 });
    expect(isSystematic(4, 10)).toBe(true);

    expect(hex(encodeDataFrameHeader(decoded!))).toBe(hex(golden));
  });

  it("agrees with core/fountain.ts's pickIndices on what 'systematic' means", () => {
    // The v2 wire convention only saves a field because it matches v1's existing
    // rule exactly — this test is the tie between them, see ADR 0003.
    for (const [seed, k] of [
      [0, 10],
      [4, 10],
      [9, 10],
      [10, 10],
      [15, 10],
    ]) {
      const systematic = isSystematic(seed, k);
      const indices = pickIndices(seed, k);
      if (systematic) {
        expect(indices).toEqual([seed]);
      } else {
        expect(indices).not.toEqual([seed]);
      }
    }
  });
});

describe('DataFrameHeader — rejects', () => {
  it('too short a buffer', () => {
    expect(decodeDataFrameHeader(new Uint8Array(10))).toBeNull();
  });

  it('zero blockSourceChunkCount', () => {
    const bytes = new Uint8Array(11); // all zero: blockSourceChunkCount = 0
    expect(decodeDataFrameHeader(bytes)).toBeNull();
  });

  it('zero dropletDegree, or a degree above the chunk count', () => {
    const withZeroDegree = encodeDataFrameHeader({ blockIndex: 0, blockSourceChunkCount: 10, dropletSeed: 20, dropletDegree: 1 });
    withZeroDegree[10] = 0;
    expect(decodeDataFrameHeader(withZeroDegree)).toBeNull();

    expect(() => encodeDataFrameHeader({ blockIndex: 0, blockSourceChunkCount: 10, dropletSeed: 20, dropletDegree: 11 })).not.toThrow();
    // encodeDataFrameHeader doesn't know the chunk-count vs degree relationship is
    // suspicious on its own (11 <= MAX_DROPLET_DEGREE) — decodeDataFrameHeader is
    // the one that catches "degree bigger than the block has chunks":
    const bytes = encodeDataFrameHeader({ blockIndex: 0, blockSourceChunkCount: 10, dropletSeed: 20, dropletDegree: 11 });
    expect(decodeDataFrameHeader(bytes)).toBeNull();
  });

  it('a systematic seed claiming a degree other than 1', () => {
    const bytes = encodeDataFrameHeader({ blockIndex: 0, blockSourceChunkCount: 10, dropletSeed: 4, dropletDegree: 1 });
    bytes[10] = 2; // corrupt the degree byte after encoding a valid systematic header
    expect(decodeDataFrameHeader(bytes)).toBeNull();
  });

  it('encoder rejects an out-of-range blockSourceChunkCount or dropletDegree', () => {
    expect(() => encodeDataFrameHeader({ blockIndex: 0, blockSourceChunkCount: 0, dropletSeed: 0, dropletDegree: 1 })).toThrow();
    expect(() => encodeDataFrameHeader({ blockIndex: 0, blockSourceChunkCount: 10, dropletSeed: 0, dropletDegree: 0 })).toThrow();
  });
});

const MINIMAL_MANIFEST: ManifestPayload = {
  fileName: '',
  mimeType: '',
  originalSize: 0,
  encodedSize: 0,
  blockSize: 1,
  blockCount: 1,
  sourceChunkSize: 1,
  compression: 'none',
  fileHashAlgorithm: 'sha256',
  fileHash: new Uint8Array(32),
};

describe('Manifest — golden vector (minimal)', () => {
  // Hand-computed. Every multi-byte size field is 0 or 1, and name/mime/createdAt
  // are all absent, which keeps this fully hand-checkable — see docs/protocol-v2.md §4.
  //
  //   offset  bytes          field
  //   0       00             fileNameLength = 0
  //   1       00             mimeTypeLength = 0
  //   2       00 00 00 00    originalSize = 0
  //   6       00 00 00 00    encodedSize = 0
  //   10      00 00 00 01    blockSize = 1
  //   14      00 01          blockCount = 1  (= max(1, ceil(0/1)))
  //   16      00 01          sourceChunkSize = 1
  //   18      00             compression = none (0)
  //   19      01             fileHashAlgorithm = sha256 (1)
  //   20      <32 zero bytes> fileHash
  //   52      00             createdAtPresent = 0
  const golden = new Uint8Array([
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x01, ...new Array(32).fill(0), 0x00,
  ]);

  it('is exactly 53 bytes', () => {
    expect(golden.length).toBe(53);
  });

  it('decodes to the minimal manifest', () => {
    expect(decodeManifest(golden)).toEqual(MINIMAL_MANIFEST);
  });

  it('encodes to exactly the golden bytes', () => {
    expect(hex(encodeManifest(MINIMAL_MANIFEST))).toBe(hex(golden));
  });
});

describe('Manifest — round-trips with real content', () => {
  it('a realistic file with a name, mime type, compression, and a timestamp', () => {
    const manifest: ManifestPayload = {
      fileName: 'urlaubsfoto.jpg',
      mimeType: 'image/jpeg',
      originalSize: 4_200_000,
      encodedSize: 4_150_000,
      blockSize: 1024 * 1024,
      blockCount: 4, // ceil(4_150_000 / 1_048_576) = 4
      sourceChunkSize: 553,
      compression: 'deflate',
      fileHashAlgorithm: 'sha256',
      fileHash: Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1),
      createdAt: 1_700_000_000,
    };
    const encoded = encodeManifest(manifest);
    expect(decodeManifest(encoded)).toEqual(manifest);
  });

  it('names at exactly the byte caps', () => {
    const manifest: ManifestPayload = {
      ...MINIMAL_MANIFEST,
      fileName: 'x'.repeat(MAX_FILE_NAME_BYTES),
      mimeType: 'y'.repeat(MAX_MIME_TYPE_BYTES),
    };
    expect(decodeManifest(encodeManifest(manifest))).toEqual(manifest);
  });

  it('multi-byte UTF-8 file names round-trip by byte length, not character count', () => {
    // "spärkü.txt" — the umlauts are 2 bytes each in UTF-8.
    const manifest: ManifestPayload = { ...MINIMAL_MANIFEST, fileName: 'spärkü.txt' };
    expect(decodeManifest(encodeManifest(manifest))).toEqual(manifest);
  });
});

describe('Manifest — encoder rejects', () => {
  it('a fileName or mimeType over the byte cap', () => {
    expect(() => encodeManifest({ ...MINIMAL_MANIFEST, fileName: 'x'.repeat(MAX_FILE_NAME_BYTES + 1) })).toThrow();
    expect(() => encodeManifest({ ...MINIMAL_MANIFEST, mimeType: 'y'.repeat(MAX_MIME_TYPE_BYTES + 1) })).toThrow();
  });

  it('a size beyond MAX_TRANSFER_BYTES', () => {
    expect(() => encodeManifest({ ...MINIMAL_MANIFEST, originalSize: MAX_TRANSFER_BYTES + 1 })).toThrow();
    expect(() => encodeManifest({ ...MINIMAL_MANIFEST, encodedSize: MAX_TRANSFER_BYTES + 1 })).toThrow();
  });

  it('a zero or negative blockSize', () => {
    expect(() => encodeManifest({ ...MINIMAL_MANIFEST, blockSize: 0 })).toThrow();
  });

  it('a fileHash of the wrong length', () => {
    expect(() => encodeManifest({ ...MINIMAL_MANIFEST, fileHash: new Uint8Array(31) })).toThrow();
    expect(() => encodeManifest({ ...MINIMAL_MANIFEST, fileHash: new Uint8Array(33) })).toThrow();
  });
});

describe('Manifest — decoder rejects', () => {
  it('a truncated buffer at every stage', () => {
    const full = encodeManifest({
      ...MINIMAL_MANIFEST,
      fileName: 'a.txt',
      mimeType: 'text/plain',
      createdAt: 1,
    });
    for (let cut = 0; cut < full.length; cut++) {
      expect(decodeManifest(full.subarray(0, cut)), `cut at ${cut}`).toBeNull();
    }
    // The uncut buffer, for contrast, must decode fine.
    expect(decodeManifest(full)).not.toBeNull();
  });

  it('a nameLength or mimeLength byte claiming more than the cap', () => {
    const bytes = encodeManifest(MINIMAL_MANIFEST);
    bytes[0] = MAX_FILE_NAME_BYTES + 1;
    expect(decodeManifest(bytes)).toBeNull();
  });

  it('a blockCount inconsistent with encodedSize/blockSize', () => {
    const bytes = encodeManifest({ ...MINIMAL_MANIFEST, encodedSize: 10, blockSize: 5, blockCount: 2 });
    // Corrupt the blockCount field (offset 14, since name/mime are both empty here).
    const view = new DataView(bytes.buffer);
    view.setUint16(14, 3, false); // claims 3 blocks; 10/5 implies exactly 2
    expect(decodeManifest(bytes)).toBeNull();
  });

  it('an invalid compression code', () => {
    const bytes = encodeManifest(MINIMAL_MANIFEST);
    bytes[18] = 2; // only 0 (none) and 1 (deflate) are defined
    expect(decodeManifest(bytes)).toBeNull();
  });

  it('a reserved (0) or unknown fileHashAlgorithm code', () => {
    const bytes = encodeManifest(MINIMAL_MANIFEST);
    bytes[19] = 0; // reserved/invalid — a v2 manifest always declares a real algorithm
    expect(decodeManifest(bytes)).toBeNull();
    bytes[19] = 2; // undefined
    expect(decodeManifest(bytes)).toBeNull();
  });

  it('a createdAtPresent byte that is neither 0 nor 1', () => {
    const bytes = encodeManifest(MINIMAL_MANIFEST);
    bytes[52] = 5;
    expect(decodeManifest(bytes)).toBeNull();
  });
});
