import { calibrationColour, geometryFor, MARGIN_CELLS, MARKER_CELLS, type GridSpec } from './spec';

/** Paints one Spark Grid frame: black margin, four white markers, calibration rows, data. */
export function renderGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cells: Uint8Array,
  spec: GridSpec,
): void {
  const geometry = geometryFor(spec);

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);

  const cellSize = Math.min(width, height) / geometry.totalCells;
  const originX = (width - cellSize * geometry.totalCells) / 2;
  const originY = (height - cellSize * geometry.totalCells) / 2;

  const box = (cx: number, cy: number, w: number, h: number) => {
    // Round outward so neighbouring cells never leave a seam of background showing.
    const x = Math.round(originX + cx * cellSize);
    const y = Math.round(originY + cy * cellSize);
    ctx.fillRect(x, y, Math.ceil(cellSize * w) + 1, Math.ceil(cellSize * h) + 1);
  };

  ctx.fillStyle = '#ffffff';
  for (const centre of geometry.markerCentres) {
    box(centre.x - MARKER_CELLS / 2, centre.y - MARKER_CELLS / 2, MARKER_CELLS, MARKER_CELLS);
  }

  const palette = spec.palette.colours;

  for (const row of geometry.calibrationRows) {
    for (let col = 0; col < spec.cells; col++) {
      ctx.fillStyle = palette[calibrationColour(col, spec.palette)];
      box(MARGIN_CELLS + col, MARGIN_CELLS + row, 1, 1);
    }
  }

  let index = 0;
  for (const row of geometry.dataRows) {
    for (let col = 0; col < spec.cells; col++) {
      ctx.fillStyle = palette[cells[index++] ?? 0];
      box(MARGIN_CELLS + col, MARGIN_CELLS + row, 1, 1);
    }
  }
}
