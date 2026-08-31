export interface Point {
  x: number;
  y: number;
}

/**
 * 3x3 projective transform, stored row-major with h[8] pinned to 1.
 * Maps grid coordinates to camera-image coordinates, which is what lets the
 * receiver read a grid that is filmed at an angle rather than dead-on.
 */
export type Homography = Float64Array;

/**
 * Solves for the transform taking the four `from` points to the four `to` points.
 *
 * Each correspondence contributes two rows to an 8x8 system; Gaussian elimination
 * with partial pivoting does the rest. Returns null for degenerate inputs — three
 * markers in a line, or two detections that collapsed onto the same spot.
 */
export function computeHomography(from: Point[], to: Point[]): Homography | null {
  if (from.length !== 4 || to.length !== 4) return null;

  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }

  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];

    const lead = a[col][col];
    for (let k = col; k <= 8; k++) a[col][k] /= lead;

    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (factor === 0) continue;
      for (let k = col; k <= 8; k++) a[row][k] -= factor * a[col][k];
    }
  }

  const h = new Float64Array(9);
  for (let i = 0; i < 8; i++) h[i] = a[i][8];
  h[8] = 1;
  return h;
}

export function project(h: Homography, x: number, y: number): Point {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}
