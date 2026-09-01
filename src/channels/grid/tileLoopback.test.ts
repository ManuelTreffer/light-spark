import { describe, it, expect } from 'vitest';
import { renderGrid } from './render';
import { detectGrid, guideBoxFor } from './detect';
import { geometryFor, specFor, GRID_PRESETS, type GridSpec } from './spec';
import { computeHomography, project } from './homography';
import { tileLayoutFor, encodeTileIntoCells, decodeTileFromCells, type TilePayload } from './tiles';
import { FrameFragmentAssembler, wrapFrameForFragmentation } from './fragmentAssembler';
import { mulberry32 } from '../../core/rng';

/**
 * End-to-end loopback for Spark Grid *tiling* (Milestone 5) — renders a real
 * tiled frame, puts it through a simulated camera (perspective, occlusion),
 * and reads it back through the same `renderGrid`/`detectGrid` vision
 * pipeline the monolithic grid already uses unmodified (see tiles.ts's doc
 * comment: tiling is purely a different interpretation of the same flat
 * `cells` array, not a vision-layer change). This exercises Milestone 8.5's
 * acceptance criteria directly: occlusion of one tile must not destroy the
 * others, and rotation/perspective capture must keep working.
 *
 * `fakeCanvas`/`simulateCamera` are intentionally duplicated from
 * `loopback.test.ts` rather than imported from it (a test file importing
 * from another test file is an unusual dependency to introduce, and these
 * ~90 lines are simple enough that keeping each loopback suite
 * self-contained was judged better than a shared test-utils module for two
 * call sites — revisit if a third one shows up).
 */

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
  skew?: number;
  blur?: number;
  noise?: number;
  exposure?: number;
  whiteBalance?: [number, number, number];
  seed?: number;
}

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

/** Blacks out a rectangular fraction of the image — simulating a finger, a
 * glare spot, or any other physical partial occlusion of the screen. */
function occludeCentre(image: ImageData, fraction: number): ImageData {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data);
  const x0 = Math.floor(width * (0.5 - fraction / 2));
  const x1 = Math.floor(width * (0.5 + fraction / 2));
  const y0 = Math.floor(height * (0.5 - fraction / 2));
  const y1 = Math.floor(height * (0.5 + fraction / 2));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 255;
    }
  }
  return { data: out, width, height } as ImageData;
}

function randomBytes(n: number, seed: number): Uint8Array {
  const rand = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

/** Renders one full tiled frame (every tile of `layout` populated with a
 * fragment of `frameBytes`) onto a fresh canvas of `size`×`size`. */
function renderTiledFrame(spec: GridSpec, layout: ReturnType<typeof tileLayoutFor>, frameBytes: Uint8Array, tileSequence: number, size: number) {
  const geometry = geometryFor(spec);
  const fullCells = new Uint8Array(geometry.dataRows.length * spec.cells);

  const wrapped = wrapFrameForFragmentation(frameBytes);
  const perTile = Math.ceil(wrapped.length / layout.tileCount);
  let offset = 0;
  const tiles: TilePayload[] = [];
  for (let i = 0; i < layout.tileCount; i++) {
    const length = Math.min(perTile, wrapped.length - offset);
    const tile: TilePayload = {
      tileIndex: i,
      tileSequence,
      tileCount: layout.tileCount,
      fragmentOffset: offset,
      fragmentLength: length,
      fragment: wrapped.subarray(offset, offset + length),
    };
    tiles.push(tile);
    encodeTileIntoCells(fullCells, spec, layout, tile);
    offset += length;
  }

  const { ctx, image } = fakeCanvas(size, size);
  renderGrid(ctx, size, size, fullCells, spec);
  return { image, tiles };
}

const normalSpec = specFor(GRID_PRESETS.find((p) => p.id === 'normal')!);

describe('Tiled Spark Grid — full render/camera/detect loopback', () => {
  it('reads every tile back correctly with a clean, front-on capture', () => {
    const layout = tileLayoutFor(normalSpec, 3, 3);
    const frameBytes = randomBytes(400, 1);
    const { image } = renderTiledFrame(normalSpec, layout, frameBytes, 5, 900);

    const filmed = simulateCamera(image, { blur: 1, noise: 4, seed: 2 });
    const detection = detectGrid(filmed, normalSpec, guideBoxFor(900, 900));
    expect(detection.cells).not.toBeNull();

    const assembler = new FrameFragmentAssembler();
    let result: Uint8Array | null = null;
    let decodedCount = 0;
    for (let i = 0; i < layout.tileCount; i++) {
      const tile = decodeTileFromCells(detection.cells!, normalSpec, layout, i);
      if (!tile) continue;
      decodedCount++;
      const r = assembler.ingestTile(tile);
      if (r) result = r;
    }

    expect(decodedCount).toBe(layout.tileCount);
    expect(result).toEqual(frameBytes);
  });

  it('survives a frame filmed at an angle (perspective) — same guarantee the monolithic grid already has', () => {
    const layout = tileLayoutFor(normalSpec, 3, 3);
    const frameBytes = randomBytes(400, 3);
    const { image } = renderTiledFrame(normalSpec, layout, frameBytes, 6, 900);

    const filmed = simulateCamera(image, { skew: 0.05, blur: 1, noise: 3, seed: 4 });
    const detection = detectGrid(filmed, normalSpec, guideBoxFor(900, 900));
    expect(detection.cells).not.toBeNull();

    const assembler = new FrameFragmentAssembler();
    let result: Uint8Array | null = null;
    for (let i = 0; i < layout.tileCount; i++) {
      const tile = decodeTileFromCells(detection.cells!, normalSpec, layout, i);
      if (!tile) continue;
      const r = assembler.ingestTile(tile);
      if (r) result = r;
    }
    expect(result).toEqual(frameBytes);
  });

  it('partial occlusion costs only the covered tile(s) — the rest still decode, and a later unoccluded pass completes the frame', () => {
    const layout = tileLayoutFor(normalSpec, 3, 3);
    const frameBytes = randomBytes(400, 7);
    const { image, tiles } = renderTiledFrame(normalSpec, layout, frameBytes, 9, 900);

    const filmed = simulateCamera(image, { blur: 1, noise: 3, seed: 8 });
    // 15% of the *canvas* lands comfortably inside just the centre tile's own
    // band once the margin is accounted for (data area ≈ 77% of the canvas;
    // a 3x3 tiling's centre tile spans the middle third of that) — sized
    // deliberately to avoid bleeding into neighbouring tiles.
    const occluded = occludeCentre(filmed, 0.15);
    const detection = detectGrid(occluded, normalSpec, guideBoxFor(900, 900));
    expect(detection.cells).not.toBeNull();

    let decodedCount = 0;
    let anyFailed = false;
    const assembler = new FrameFragmentAssembler();
    let result: Uint8Array | null = null;
    for (let i = 0; i < layout.tileCount; i++) {
      const tile = decodeTileFromCells(detection.cells!, normalSpec, layout, i);
      if (tile) {
        decodedCount++;
        const r = assembler.ingestTile(tile);
        if (r) result = r;
      } else {
        anyFailed = true;
      }
    }

    // The occlusion had a real, isolated effect: at least one tile was lost...
    expect(anyFailed).toBe(true);
    // ...but nowhere near all of them — most of a 3x3 grid survives a
    // centre-only occlusion. The old monolithic format would have lost 100%
    // of this frame to the same occlusion (one CRC over everything).
    expect(decodedCount).toBeGreaterThanOrEqual(layout.tileCount - 2);
    // The frame isn't complete from this one occluded pass...
    expect(result).toBeNull();

    // ...but the sender repeats every tile cyclically (SenderSession's own
    // convention, matching Grid's already-repeating design) — feeding the
    // *original*, un-occluded tiles for exactly the ones that failed
    // recovers the frame without needing to redo the tiles that already
    // succeeded.
    for (let i = 0; i < layout.tileCount; i++) {
      const decoded = decodeTileFromCells(detection.cells!, normalSpec, layout, i);
      if (decoded) continue; // already delivered above
      const r = assembler.ingestTile(tiles[i]); // the sender's original, unoccluded tile
      if (r) result = r;
    }
    expect(result).toEqual(frameBytes);
  });
});
