/**
 * Wire format for one fountain drop, shared by the QR and grid channels.
 *
 *   offset  size  field
 *   0       1     magic (0xA7)
 *   1       2     streamId    — changes when the sender starts a new transfer
 *   3       4     totalBytes  — length of the envelope being sent
 *   7       2     chunkSize
 *   9       4     seed        — the drop's chunk selection
 *   13      N     payload
 *
 * Every field the receiver needs to spin up a decoder rides in each packet, so it
 * can join a transfer already in progress — there is no "first frame" to miss.
 */

export const PACKET_MAGIC = 0xa7;
export const PACKET_HEADER_SIZE = 13;

/**
 * Upper bounds on what a single packet header may claim. `totalBytes` and
 * `chunkSize` ride in every packet unauthenticated — anything the camera picks up
 * gets to set them — so without a cap, one crafted frame could make the fountain
 * decoder try to allocate a chunk array with billions of entries and crash the tab.
 * 16 MiB is comfortably above the app's own Spark Grid ceiling (8 MB, see
 * `channels/types.ts`), so no legitimate transfer is affected.
 */
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_CHUNK_COUNT = 200_000;

export interface Packet {
  streamId: number;
  totalBytes: number;
  chunkSize: number;
  seed: number;
  payload: Uint8Array;
}

export function encodePacket(p: Packet): Uint8Array {
  const out = new Uint8Array(PACKET_HEADER_SIZE + p.payload.length);
  const view = new DataView(out.buffer);
  out[0] = PACKET_MAGIC;
  view.setUint16(1, p.streamId, false);
  view.setUint32(3, p.totalBytes, false);
  view.setUint16(7, p.chunkSize, false);
  view.setUint32(9, p.seed, false);
  out.set(p.payload, PACKET_HEADER_SIZE);
  return out;
}

/** Returns null for anything that is not a plausible packet — misreads are routine here. */
export function decodePacket(bytes: Uint8Array): Packet | null {
  if (bytes.length <= PACKET_HEADER_SIZE || bytes[0] !== PACKET_MAGIC) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkSize = view.getUint16(7, false);
  const totalBytes = view.getUint32(3, false);
  if (chunkSize === 0 || totalBytes === 0) return null;
  if (totalBytes > MAX_TOTAL_BYTES || Math.ceil(totalBytes / chunkSize) > MAX_CHUNK_COUNT) return null;
  if (bytes.length < PACKET_HEADER_SIZE + chunkSize) return null;

  return {
    streamId: view.getUint16(1, false),
    totalBytes,
    chunkSize,
    seed: view.getUint32(9, false),
    payload: bytes.subarray(PACKET_HEADER_SIZE, PACKET_HEADER_SIZE + chunkSize),
  };
}
