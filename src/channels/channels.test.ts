import { describe, it, expect } from 'vitest';
import { BeaconBeamSource, BEACON_PRESETS } from './beacon/sender';
import {
  BeaconStreamDecoder,
  BEACON_PALETTE,
  classifyBeaconColour,
  encodeBeaconFrame,
  stepsToColours,
  DELIMITER_STEP,
} from './beacon/codec';
import { encodeGridCells, decodeGridCells } from './grid/codec';
import { geometryFor, GRID_PRESETS, specFor, calibrationColour, GRID_PALETTES } from './grid/spec';
import { computeHomography, project } from './grid/homography';
import { encodePacket, decodePacket, PACKET_HEADER_SIZE } from '../core/packet';
import { mulberry32 } from '../core/rng';
import { recommendChannel } from './types';

function randomBytes(n: number, seed = 1): Uint8Array {
  const rand = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

/** Feeds colours the way the receiver does: one push per visible change. */
function playBeacon(colours: number[], decoder: BeaconStreamDecoder): Uint8Array | null {
  let result: Uint8Array | null = null;
  for (const colour of colours) {
    const found = decoder.push(colour);
    if (found) result = found;
  }
  return result;
}

describe('beacon codec', () => {
  it('never repeats a colour, so every symbol boundary is visible', () => {
    const colours = stepsToColours(encodeBeaconFrame(new TextEncoder().encode('Light Spark ist cool')), 3);
    for (let i = 1; i < colours.length; i++) {
      expect(colours[i], `position ${i}`).not.toBe(colours[i - 1]);
      expect(colours[i]).toBeGreaterThanOrEqual(0);
      expect(colours[i]).toBeLessThan(8);
    }
  });

  it('round-trips a message', () => {
    const text = 'https://example.org/geheim?token=abc123';
    const colours = stepsToColours(encodeBeaconFrame(new TextEncoder().encode(text)));
    const decoded = playBeacon(colours, new BeaconStreamDecoder());
    expect(decoded).not.toBeNull();
    expect(new TextDecoder().decode(decoded!)).toBe(text);
  });

  it('picks the message up mid-stream, which is how a receiver actually joins', () => {
    const text = 'WLAN: Sonnenblume42';
    const steps = encodeBeaconFrame(new TextEncoder().encode(text));
    const looping = stepsToColours(steps, 3);

    // Start watching 40% of the way into the first pass — the receiver must survive
    // to the next delimiter and decode the following pass.
    const decoded = playBeacon(looping.slice(Math.floor(steps.length * 0.4)), new BeaconStreamDecoder());
    expect(new TextDecoder().decode(decoded!)).toBe(text);
  });

  it('rejects a frame whose bytes got mangled', () => {
    const broken = stepsToColours(encodeBeaconFrame(new TextEncoder().encode('12345678')));
    broken[10] = (broken[10] + 1) % 8; // shifts two steps, so two symbols change
    expect(playBeacon(broken, new BeaconStreamDecoder())).toBeNull();
  });

  it('recovers on the next pass after a spurious symbol', () => {
    const text = 'Wiederholung heilt';
    const steps = encodeBeaconFrame(new TextEncoder().encode(text));
    const colours = stepsToColours(steps, 3);
    // A blended camera frame slipping through as an extra symbol mid-message.
    colours.splice(12, 0, (colours[12] + 3) % 8);
    expect(new TextDecoder().decode(playBeacon(colours, new BeaconStreamDecoder())!)).toBe(text);
  });

  it('handles an empty message and the maximum length', () => {
    expect(playBeacon(stepsToColours(encodeBeaconFrame(new Uint8Array(0))), new BeaconStreamDecoder())!.length).toBe(0);
    const big = randomBytes(255, 3);
    const decoded = playBeacon(stepsToColours(encodeBeaconFrame(big)), new BeaconStreamDecoder());
    expect(Array.from(decoded!)).toEqual(Array.from(big));
  });

  it('reserves the delimiter step so data can never counterfeit it', () => {
    const steps = encodeBeaconFrame(randomBytes(60, 12));
    expect(steps[0]).toBe(DELIMITER_STEP);
    expect(steps.slice(1).filter((step) => step >= DELIMITER_STEP)).toHaveLength(0);
  });

  it('emits exactly one delimiter per pass, including across the loop seam', () => {
    const steps = encodeBeaconFrame(new TextEncoder().encode('Naht'));
    const colours = stepsToColours(steps, 4);
    let delimiters = 0;
    for (let i = 1; i < colours.length; i++) {
      if ((colours[i] - colours[i - 1] + 8) % 8 === DELIMITER_STEP) delimiters++;
    }
    expect(delimiters).toBe(4);
  });
});

describe('beacon sender', () => {
  /** Reads back the palette colour the sender painted, by its fill. */
  function displayedColours(payload: Uint8Array, frames: number): number[] {
    const source = new BeaconBeamSource(payload, BEACON_PRESETS[1]);
    const seen: number[] = [];
    let fill = '';

    const ctx = {
      set fillStyle(value: string) {
        fill = value;
      },
      fillRect() {
        // The grey surround is painted first and is not a palette colour, so only
        // the colour field itself registers here.
        const index = (BEACON_PALETTE as readonly string[]).indexOf(fill);
        if (index >= 0) seen.push(index);
      },
    } as unknown as CanvasRenderingContext2D;

    for (let i = 0; i < frames; i++) source.renderFrame(ctx, 400, 400);
    return seen;
  }

  it('paints exactly the colour sequence the decoder expects', () => {
    const payload = new TextEncoder().encode('Naht-Test');
    const steps = encodeBeaconFrame(payload);
    const expected = stepsToColours(steps, 2);
    expect(displayedColours(payload, expected.length)).toEqual(expected);
  });

  it('shows the opening delimiter in its very first transition', () => {
    // Regression: stepping before painting swallowed the starting colour, hiding the
    // first delimiter and costing a receiver a whole extra pass before it could sync.
    const payload = new TextEncoder().encode('sync');
    const shown = displayedColours(payload, 3);
    expect((shown[1] - shown[0] + 8) % 8).toBe(DELIMITER_STEP);
  });

  it('is decodable from the first frame onwards', () => {
    const payload = new TextEncoder().encode('Sofort lesbar');
    const steps = encodeBeaconFrame(payload);
    const decoded = playBeacon(displayedColours(payload, steps.length + 1), new BeaconStreamDecoder());
    expect(new TextDecoder().decode(decoded!)).toBe('Sofort lesbar');
  });
});

describe('beacon colour classification', () => {
  const cases: [string, number, number, number, number][] = [
    ['black', 4, 6, 3, 0],
    ['red', 230, 20, 15, 1],
    ['yellow', 240, 220, 25, 2],
    ['green', 20, 210, 30, 3],
    ['cyan', 25, 215, 225, 4],
    ['blue', 18, 22, 235, 5],
    ['magenta', 225, 20, 215, 6],
    ['white', 240, 245, 235, 7],
  ];

  it('reads every palette colour back, even off-nominal', () => {
    for (const [name, r, g, b, expected] of cases) {
      expect(classifyBeaconColour(r, g, b, 245).index, name).toBe(expected);
    }
  });

  it('survives a warm white balance and a dim exposure', () => {
    // Camera tinted warm (blue pulled down) and everything at half brightness.
    for (const [name, r, g, b, expected] of cases) {
      const tinted = classifyBeaconColour(r * 0.5, g * 0.46, b * 0.38, 122);
      expect(tinted.index, `${name} tinted`).toBe(expected);
    }
  });

  it('flags a colour sitting on a decision boundary as not confident', () => {
    // Green at roughly the 55% cut: the classifier cannot tell red from yellow here,
    // so it must decline rather than guess. (A clean 50/50 red-green blend is a
    // different matter — that genuinely *is* yellow, and only the receiver's
    // multi-frame debounce can tell it apart from a real yellow symbol.)
    expect(classifyBeaconColour(220, 124, 12, 245).confident).toBe(false);
    expect(classifyBeaconColour(220, 20, 12, 245).confident).toBe(true);
  });
});

describe('grid codec', () => {
  it('round-trips a full packet at every preset', () => {
    for (const preset of GRID_PRESETS) {
      const spec = specFor(preset);
      const geometry = geometryFor(spec);
      const chunkSize = geometry.bodyBytes - PACKET_HEADER_SIZE;

      const packet = encodePacket({
        streamId: 7,
        totalBytes: 50000,
        chunkSize,
        seed: 0x1234abcd,
        payload: randomBytes(chunkSize, preset.cells),
      });

      const cells = encodeGridCells(packet, spec);
      expect(cells.length, preset.id).toBe(geometry.cellCount);
      for (const cell of cells) expect(cell).toBeLessThan(spec.palette.colours.length);

      const body = decodeGridCells(cells, spec)!;
      expect(body, preset.id).not.toBeNull();

      const decoded = decodePacket(body)!;
      expect(decoded, preset.id).not.toBeNull();
      expect(decoded.seed).toBe(0x1234abcd);
      expect(Array.from(decoded.payload)).toEqual(Array.from(packet.subarray(PACKET_HEADER_SIZE)));
    }
  });

  it('rejects a frame with misread cells instead of passing on poison', () => {
    const spec = specFor(GRID_PRESETS[1]);
    const geometry = geometryFor(spec);
    const packet = encodePacket({
      streamId: 1,
      totalBytes: 1000,
      chunkSize: geometry.bodyBytes - PACKET_HEADER_SIZE,
      seed: 5,
      payload: randomBytes(geometry.bodyBytes - PACKET_HEADER_SIZE, 2),
    });

    const cells = encodeGridCells(packet, spec);
    cells[500] = (cells[500] + 1) % spec.palette.colours.length;
    expect(decodeGridCells(cells, spec)).toBeNull();
  });

  it('gives the turbo preset a worthwhile payload advantage over safe', () => {
    const safe = geometryFor(specFor(GRID_PRESETS[0])).bodyBytes;
    const turbo = geometryFor(specFor(GRID_PRESETS[2])).bodyBytes;
    expect(turbo).toBeGreaterThan(safe * 3);
  });

  it('spreads every palette colour across the calibration row', () => {
    for (const palette of Object.values(GRID_PALETTES)) {
      const seen = new Set<number>();
      for (let col = 0; col < 40; col++) seen.add(calibrationColour(col, palette));
      expect(seen.size).toBe(palette.colours.length);
    }
  });
});

describe('homography', () => {
  it('recovers an exact mapping from four correspondences', () => {
    const from = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    // A trapezoid: what filming a screen from below actually looks like.
    const to = [
      { x: 120, y: 100 },
      { x: 520, y: 130 },
      { x: 480, y: 560 },
      { x: 150, y: 520 },
    ];

    const h = computeHomography(from, to)!;
    expect(h).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      const p = project(h, from[i].x, from[i].y);
      expect(p.x).toBeCloseTo(to[i].x, 6);
      expect(p.y).toBeCloseTo(to[i].y, 6);
    }
  });

  it('interpolates interior points sensibly', () => {
    const from = [
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 8, y: 8 },
      { x: 0, y: 8 },
    ];
    const to = [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 80, y: 80 },
      { x: 0, y: 80 },
    ];
    const centre = project(computeHomography(from, to)!, 4, 4);
    expect(centre.x).toBeCloseTo(40, 6);
    expect(centre.y).toBeCloseTo(40, 6);
  });

  it('returns null for degenerate corners rather than a bogus transform', () => {
    const collapsed = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
    const square = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    expect(computeHomography(collapsed, square)).toBeNull();
  });
});

describe('channel recommendation', () => {
  it('scales from beacon to grid with payload size', () => {
    expect(recommendChannel(40)).toBe('beacon');
    expect(recommendChannel(5_000)).toBe('qr');
    expect(recommendChannel(400_000)).toBe('grid');
  });
});
