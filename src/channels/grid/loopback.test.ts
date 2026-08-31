import { describe, it, expect } from 'vitest';
import { renderGrid } from './render';
import { detectGrid, guideBoxFor } from './detect';
import { encodeGridCells, decodeGridCells } from './codec';
import { geometryFor, specFor, GRID_PRESETS, MARGIN_CELLS, type GridSpec } from './spec';
import { computeHomography, project } from './homography';
import { encodePacket, decodePacket, PACKET_HEADER_SIZE } from '../../core/packet';
import { mulberry32 } from '../../core/rng';

/**
 * End-to-end loopback for the Spark Grid: render a real frame, put it through a
 * simulated camera (perspective, blur, noise, exposure), and read it back.
 *
 * This is the part of the app with the most that can silently go wrong — marker
 * detection, the homography, and colour classification all have to agree — so it is
 * worth exercising here rather than only against a phone pointed at a screen.
 */

/** Just enough of CanvasRenderingContext2D for renderGrid, backed by a raw RGBA buffer. */
function fakeCanvas(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;

  let fill = { r: 0, g: 0, b: 0 };

  const ctx = {
    set fillStyle(value: string) {
      fill = {
        r: parseInt(value.slice(1, 3), 16),
        g: parseInt(value.slice(3, 5), 16),
        b: parseInt(value.slice(5, 7), 16),
      };
    },
    fillRect(x: number, y: number, w: number, h: number) {
      const x0 = Math.max(0, Math.round(x));
      const y0 = Math.max(0, Math.round(y));
      const x1 = Math.min(width, Math.round(x + w));
      const y1 = Math.min(height, Math.round(y + h));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const i = (py * width + px) * 4;
          data[i] = fill.r;
          data[i + 1] = fill.g;
          data[i + 2] = fill.b;
        }
      }
    },
  } as unknown as CanvasRenderingContext2D;

  return { ctx, image: { data, width, height } as ImageData };
}

interface CameraOptions {
  /** How far each corner is pulled, as a fraction of the frame — simulates filming at an angle. */
  skew?: number;
  /** Box blur radius in pixels. */
  blur?: number;
  /** Peak +/- noise per channel. */
  noise?: number;
  /** Multiplies every channel: a dim room or a bright one. */
  exposure?: number;
  /** Per-channel gain, for a camera with an off white balance. */
  whiteBalance?: [number, number, number];
  seed?: number;
}

/**
 * Warps and degrades a rendered frame the way a hand-held camera would.
 *
 * Inverse mapping: for every output pixel, find where it came from in the source, so
 * the result has no holes.
 */
function simulateCamera(source: ImageData, options: CameraOptions = {}): ImageData {
  const { skew = 0, blur = 0, noise = 0, exposure = 1, whiteBalance = [1, 1, 1], seed = 1 } = options;
  const { width, height } = source;
  const rand = mulberry32(seed);

  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  // Push the top edge in and the bottom out: a screen filmed from slightly below.
  const warped = [
    { x: skew * width, y: skew * height * 0.6 },
    { x: width - skew * width * 0.5, y: -skew * height * 0.2 },
    { x: width + skew * width * 0.3, y: height - skew * height * 0.4 },
    { x: -skew * width * 0.2, y: height + skew * height * 0.1 },
  ];
  const inverse = computeHomography(warped, corners)!;

  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = skew === 0 ? { x, y } : project(inverse, x, y);
      const sx = Math.round(from.x);
      const sy = Math.round(from.y);
      const i = (y * width + x) * 4;
      out[i + 3] = 255;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;

      const j = (sy * width + sx) * 4;
      for (let c = 0; c < 3; c++) {
        const value = source.data[j + c] * exposure * whiteBalance[c] + (rand() - 0.5) * 2 * noise;
        out[i + c] = value;
      }
    }
  }

  if (blur <= 0) return { data: out, width, height } as ImageData;

  // Separable box blur, standing in for defocus and the camera's own smoothing.
  const blurred = new Uint8ClampedArray(out.length);
  const pass = (src: Uint8ClampedArray, dst: Uint8ClampedArray, horizontal: boolean) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          let n = 0;
          for (let k = -blur; k <= blur; k++) {
            const px = horizontal ? x + k : x;
            const py = horizontal ? y : y + k;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            sum += src[(py * width + px) * 4 + c];
            n++;
          }
          dst[(y * width + x) * 4 + c] = sum / n;
        }
        dst[(y * width + x) * 4 + 3] = 255;
      }
    }
  };
  const scratch = new Uint8ClampedArray(out.length);
  pass(out, scratch, true);
  pass(scratch, blurred, false);
  return { data: blurred, width, height } as ImageData;
}

function samplePacket(spec: GridSpec, seed: number) {
  const geometry = geometryFor(spec);
  const chunkSize = geometry.bodyBytes - PACKET_HEADER_SIZE;
  const rand = mulberry32(seed);
  const payload = new Uint8Array(chunkSize);
  for (let i = 0; i < chunkSize; i++) payload[i] = Math.floor(rand() * 256);
  return encodePacket({ streamId: 99, totalBytes: 123456, chunkSize, seed: 0xabcdef01, payload });
}

/** Renders a frame, runs it through the simulated camera, and reads it back. */
function roundTrip(spec: GridSpec, size: number, camera: CameraOptions) {
  const packet = samplePacket(spec, spec.cells);
  const { ctx, image } = fakeCanvas(size, size);
  renderGrid(ctx, size, size, encodeGridCells(packet, spec), spec);

  const filmed = simulateCamera(image, camera);
  const detection = detectGrid(filmed, spec, guideBoxFor(size, size));
  const body = detection.cells ? decodeGridCells(detection.cells, spec) : null;
  return { packet, detection, body };
}

describe('spark grid loopback', () => {
  it('reads back a perfectly captured frame at every preset', () => {
    for (const preset of GRID_PRESETS) {
      const spec = specFor(preset);
      const { packet, detection, body } = roundTrip(spec, 1100, {});

      expect(detection.reason, preset.id).toBe('ok');
      expect(body, `${preset.id} failed CRC`).not.toBeNull();
      expect(Array.from(body!.subarray(0, packet.length)), preset.id).toEqual(Array.from(packet));

      const decoded = decodePacket(body!)!;
      expect(decoded.seed, preset.id).toBe(0xabcdef01);
    }
  });

  it('survives a frame filmed at an angle', () => {
    const spec = specFor(GRID_PRESETS[1]);
    const { packet, detection, body } = roundTrip(spec, 1100, { skew: 0.05 });
    expect(detection.reason).toBe('ok');
    expect(body).not.toBeNull();
    expect(Array.from(body!.subarray(0, packet.length))).toEqual(Array.from(packet));
  });

  it('survives blur, sensor noise, dim light and a warm white balance together', () => {
    const spec = specFor(GRID_PRESETS[1]);
    const { packet, body } = roundTrip(spec, 1100, {
      skew: 0.03,
      blur: 2,
      noise: 14,
      exposure: 0.62,
      whiteBalance: [1.12, 1.0, 0.78],
    });
    expect(body, 'CRC rejected a frame that should still have been readable').not.toBeNull();
    expect(Array.from(body!.subarray(0, packet.length))).toEqual(Array.from(packet));
  });

  it('keeps the safe preset readable where turbo gives up', () => {
    // Heavy blur smears turbo's small cells into each other; the safe preset has
    // larger cells and only four well-separated colours, and should still get through.
    const harsh = { blur: 5, noise: 18, exposure: 0.55 };
    expect(roundTrip(specFor(GRID_PRESETS[0]), 900, harsh).body).not.toBeNull();
  });

  it('reports missing markers instead of inventing data when nothing is aimed at it', () => {
    const spec = specFor(GRID_PRESETS[1]);
    const { image } = fakeCanvas(800, 800); // all black, no beam in shot
    const detection = detectGrid(image, spec, guideBoxFor(800, 800));
    expect(detection.cells).toBeNull();
    expect(detection.reason).toBe('no-markers');
  });

  it('gives up on a frame lost to glare instead of reading it', () => {
    const spec = specFor(GRID_PRESETS[1]);
    const size = 900;
    const { ctx, image } = fakeCanvas(size, size);
    renderGrid(ctx, size, size, encodeGridCells(samplePacket(spec, 3), spec), spec);

    // Everything crushed towards white — a reflection straight off the screen.
    for (let i = 0; i < image.data.length; i += 4) {
      for (let c = 0; c < 3; c++) image.data[i + c] = 205 + image.data[i + c] * 0.16;
    }

    expect(detectGrid(image, spec, guideBoxFor(size, size)).cells).toBeNull();
  });

  it('refuses a frame whose colours collapsed, even with the markers still visible', () => {
    const spec = specFor(GRID_PRESETS[1]);
    const size = 900;
    const geometry = geometryFor(spec);
    const { ctx, image } = fakeCanvas(size, size);
    renderGrid(ctx, size, size, encodeGridCells(samplePacket(spec, 3), spec), spec);

    // Desaturate only the data area: the markers stay findable, so detection gets
    // all the way to classification and has to reject it on colour separation alone.
    const cell = size / geometry.totalCells;
    const from = Math.round(MARGIN_CELLS * cell);
    const to = Math.round((geometry.totalCells - MARGIN_CELLS) * cell);
    for (let y = from; y < to; y++) {
      for (let x = from; x < to; x++) {
        const i = (y * size + x) * 4;
        for (let c = 0; c < 3; c++) image.data[i + c] = 128 + (image.data[i + c] - 128) * 0.08;
      }
    }

    const detection = detectGrid(image, spec, guideBoxFor(size, size));
    expect(detection.markers).not.toBeNull();
    expect(detection.cells).toBeNull();
    expect(detection.reason).toBe('washed-out');
  });

  it('never hands a corrupted frame to the fountain decoder', () => {
    // The guarantee the whole design leans on: a bad read must be *detected*, since
    // a silently wrong drop would poison reassembly beyond repair.
    const spec = specFor(GRID_PRESETS[2]);
    let readable = 0;
    let corrupt = 0;

    for (let seed = 0; seed < 6; seed++) {
      const packet = samplePacket(spec, seed);
      const { ctx, image } = fakeCanvas(1000, 1000);
      renderGrid(ctx, 1000, 1000, encodeGridCells(packet, spec), spec);

      const filmed = simulateCamera(image, { blur: 3, noise: 30, exposure: 0.5, seed: seed + 1 });
      const detection = detectGrid(filmed, spec, guideBoxFor(1000, 1000));
      if (!detection.cells) continue;

      const body = decodeGridCells(detection.cells, spec);
      if (!body) continue;
      readable++;
      if (!Array.from(body.subarray(0, packet.length)).every((byte, i) => byte === packet[i])) corrupt++;
    }

    expect(corrupt, 'a frame passed CRC but held wrong bytes').toBe(0);
    expect(readable).toBeGreaterThan(0);
  });
});
