import { computeHomography, project, type Homography, type Point } from './homography';
import { calibrationColour, geometryFor, MARGIN_CELLS, MARKER_CELLS, type GridSpec } from './spec';

export interface GuideBox {
  x: number;
  y: number;
  size: number;
}

/** The alignment square drawn over the viewfinder — the user matches the beam to it. */
export function guideBoxFor(width: number, height: number): GuideBox {
  const size = Math.min(width, height) * 0.86;
  return { x: (width - size) / 2, y: (height - size) / 2, size };
}

export interface Detection {
  cells: Uint8Array | null;
  markers: Point[] | null;
  /** 0..1 — how cleanly the calibration colours separated. Drives the alignment hint. */
  quality: number;
  reason: 'ok' | 'no-markers' | 'bad-geometry' | 'washed-out';
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Turns one camera frame into cell colour indices.
 *
 * Rather than hunting the whole image, this leans on the on-screen guide box: the
 * four white markers can only be near its corners, so each search is a small window.
 * The markers then pin a homography, which is what makes a hand-held, slightly
 * angled shot readable at all.
 */
export function detectGrid(imageData: ImageData, spec: GridSpec, guide: GuideBox): Detection {
  const geometry = geometryFor(spec);

  // Where a marker centre sits as a fraction of the frame's full extent. The guide
  // box marks where the beam's outer edge should be, so this converts directly into
  // a search position — a hard-coded percentage would drift with grid density.
  const markerInset = geometry.markerCentres[0].x / geometry.totalCells;
  const expectedMarkerSide = (guide.size * MARKER_CELLS) / geometry.totalCells;

  const markers = findMarkers(imageData, guide, markerInset, expectedMarkerSide);
  if (!markers) return { cells: null, markers: null, quality: 0, reason: 'no-markers' };

  const homography = computeHomography(geometry.markerCentres, markers);
  if (!homography) return { cells: null, markers, quality: 0, reason: 'bad-geometry' };

  const cellPx = estimateCellSize(homography, geometry.totalCells);
  const radius = Math.max(0, Math.floor(cellPx * 0.28));

  const sample = (col: number, row: number) =>
    samplePatch(imageData, project(homography, MARGIN_CELLS + col + 0.5, MARGIN_CELLS + row + 0.5), radius);

  // Learn what each palette colour looks like right now, from the calibration rows.
  const paletteSize = spec.palette.colours.length;
  const sums: Rgb[] = Array.from({ length: paletteSize }, () => ({ r: 0, g: 0, b: 0 }));
  const counts = new Array(paletteSize).fill(0);

  for (const row of geometry.calibrationRows) {
    for (let col = 0; col < spec.cells; col++) {
      const index = calibrationColour(col, spec.palette);
      const rgb = sample(col, row);
      sums[index].r += rgb.r;
      sums[index].g += rgb.g;
      sums[index].b += rgb.b;
      counts[index]++;
    }
  }

  const references: Rgb[] = sums.map((sum, i) => ({
    r: sum.r / Math.max(1, counts[i]),
    g: sum.g / Math.max(1, counts[i]),
    b: sum.b / Math.max(1, counts[i]),
  }));

  const quality = separationQuality(references);
  // Colours that landed on top of each other mean the frame is blurred, glared, or
  // the markers were misdetected — reading data off it would only produce noise.
  if (quality < 0.18) return { cells: null, markers, quality, reason: 'washed-out' };

  const cells = new Uint8Array(geometry.cellCount);
  let index = 0;
  for (const row of geometry.dataRows) {
    for (let col = 0; col < spec.cells; col++) {
      cells[index++] = nearest(sample(col, row), references);
    }
  }

  return { cells, markers, quality, reason: 'ok' };
}

/** Mean colour of a small square, kept tight so neighbouring cells don't bleed in. */
function samplePatch(image: ImageData, point: Point, radius: number): Rgb {
  const cx = Math.round(point.x);
  const cy = Math.round(point.y);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;

  for (let y = cy - radius; y <= cy + radius; y++) {
    if (y < 0 || y >= image.height) continue;
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || x >= image.width) continue;
      const i = (y * image.width + x) * 4;
      r += image.data[i];
      g += image.data[i + 1];
      b += image.data[i + 2];
      n++;
    }
  }
  return n === 0 ? { r: 0, g: 0, b: 0 } : { r: r / n, g: g / n, b: b / n };
}

function distance(a: Rgb, b: Rgb): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

function nearest(colour: Rgb, references: Rgb[]): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < references.length; i++) {
    const d = distance(colour, references[i]);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

/** Smallest gap between any two calibrated colours, normalised against the RGB diagonal. */
function separationQuality(references: Rgb[]): number {
  let smallest = Infinity;
  for (let i = 0; i < references.length; i++) {
    for (let j = i + 1; j < references.length; j++) {
      smallest = Math.min(smallest, Math.sqrt(distance(references[i], references[j])));
    }
  }
  return Math.min(1, smallest / 441.7);
}

function estimateCellSize(h: Homography, totalCells: number): number {
  const a = project(h, totalCells / 2, totalCells / 2);
  const b = project(h, totalCells / 2 + 1, totalCells / 2);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Finds the four white corner squares, in TL, TR, BR, BL order.
 *
 * Each is searched for inside its own window near the corresponding guide corner:
 * threshold to the brightest pixels, take the largest connected blob, and use its
 * centroid. The blob is a solid 4x4-cell square sitting alone in a black margin, so
 * it comfortably outweighs any stray bright speck.
 */
function findMarkers(image: ImageData, guide: GuideBox, markerInset: number, expectedSide: number): Point[] | null {
  const inset = guide.size * markerInset;
  // Wide enough to absorb a sloppy alignment, tight enough to stay inside the black
  // margin band rather than reaching into coloured data cells.
  const window = guide.size * 0.26;

  const targets: Point[] = [
    { x: guide.x + inset, y: guide.y + inset },
    { x: guide.x + guide.size - inset, y: guide.y + inset },
    { x: guide.x + guide.size - inset, y: guide.y + guide.size - inset },
    { x: guide.x + inset, y: guide.y + guide.size - inset },
  ];

  const markers: Point[] = [];
  for (const target of targets) {
    const found = whiteBlobCentre(image, target, window, expectedSide);
    if (!found) return null;
    markers.push(found);
  }

  // Reject a "detection" where corners collapsed together — that is a misread, and a
  // homography built from it would silently produce garbage cells.
  const span = Math.hypot(markers[2].x - markers[0].x, markers[2].y - markers[0].y);
  if (span < guide.size * 0.4) return null;

  return markers;
}

/**
 * Centroid of the white marker square inside one search window.
 *
 * "Whiteness" is the *smallest* of the three channels, not brightness. White is the
 * only palette colour with all three channels high, whereas yellow and cyan are as
 * bright as it — under a luminance threshold those light up too, and at high grid
 * densities a connected clump of them can outweigh the real marker.
 *
 * The blob is then held to the marker's expected area, which rejects both stray
 * specks and any run of white data cells that happened to merge.
 */
function whiteBlobCentre(image: ImageData, centre: Point, window: number, expectedSide: number): Point | null {
  const half = Math.round(window / 2);
  const x0 = Math.max(0, Math.round(centre.x) - half);
  const y0 = Math.max(0, Math.round(centre.y) - half);
  const x1 = Math.min(image.width, Math.round(centre.x) + half);
  const y1 = Math.min(image.height, Math.round(centre.y) + half);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 4 || h < 4) return null;

  const whiteness = new Float32Array(w * h);
  let peak = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * image.width + (x0 + x)) * 4;
      const value = Math.min(image.data[i], image.data[i + 1], image.data[i + 2]);
      whiteness[y * w + x] = value;
      if (value > peak) peak = value;
    }
  }
  if (peak < 60) return null; // nothing white enough to be a marker

  const threshold = peak * 0.6;
  const expectedArea = expectedSide * expectedSide;
  const minArea = Math.max(9, expectedArea * 0.25);
  const maxArea = expectedArea * 4;

  const visited = new Uint8Array(w * h);
  let best: { size: number; sumX: number; sumY: number } | null = null;
  const stack: number[] = [];

  for (let start = 0; start < whiteness.length; start++) {
    if (visited[start] || whiteness[start] < threshold) continue;

    let size = 0;
    let sumX = 0;
    let sumY = 0;
    stack.push(start);
    visited[start] = 1;

    while (stack.length > 0) {
      const p = stack.pop()!;
      const px = p % w;
      const py = (p - px) / w;
      size++;
      sumX += px;
      sumY += py;

      if (px > 0 && !visited[p - 1] && whiteness[p - 1] >= threshold) (visited[p - 1] = 1), stack.push(p - 1);
      if (px < w - 1 && !visited[p + 1] && whiteness[p + 1] >= threshold) (visited[p + 1] = 1), stack.push(p + 1);
      if (py > 0 && !visited[p - w] && whiteness[p - w] >= threshold) (visited[p - w] = 1), stack.push(p - w);
      if (py < h - 1 && !visited[p + w] && whiteness[p + w] >= threshold) (visited[p + w] = 1), stack.push(p + w);
    }

    if (size < minArea || size > maxArea) continue;
    if (!best || size > best.size) best = { size, sumX, sumY };
  }

  if (!best) return null;
  return { x: x0 + best.sumX / best.size, y: y0 + best.sumY / best.size };
}
