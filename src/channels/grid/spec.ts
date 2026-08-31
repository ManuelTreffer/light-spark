/**
 * Layout of one Spark Grid frame, in cell units.
 *
 *   +--------------------------------------+
 *   |  ■                                ■  |   margin: pure black, with a white
 *   |     +--------------------------+     |   square marker at each corner
 *   |     | calibration row          |     |
 *   |     | data                     |     |
 *   |     | ...                      |     |
 *   |     | calibration row          |     |
 *   |     +--------------------------+     |
 *   |  ■                                ■  |
 *   +--------------------------------------+
 *
 * The markers give the receiver four known points, which pin down a homography and
 * therefore the centre of every single cell. The calibration rows carry all palette
 * colours in a known order, so the receiver measures what each colour *actually*
 * looks like through this particular screen, camera, and lighting — rather than
 * assuming a nominal RGB value that white balance will have moved anyway.
 */

export interface GridPalette {
  id: 'full' | 'safe';
  label: string;
  hint: string;
  colours: string[];
  bitsPerCell: number;
}

export const GRID_PALETTES: Record<GridPalette['id'], GridPalette> = {
  safe: {
    id: 'safe',
    label: '4 Farben',
    hint: '2 Bit/Zelle – robuster bei schlechtem Licht',
    colours: ['#000000', '#ff0000', '#00ff00', '#ffffff'],
    bitsPerCell: 2,
  },
  full: {
    id: 'full',
    label: '8 Farben',
    hint: '3 Bit/Zelle – 50 % mehr Tempo',
    colours: ['#000000', '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ffffff'],
    bitsPerCell: 3,
  },
};

/** Black band around the data area; the markers live in it, clear of any data. */
export const MARGIN_CELLS = 6;
/** Side length of the white corner squares, in cells. */
export const MARKER_CELLS = 4;
/** Reserved as CRC-32 over the rest of the frame body. */
export const FRAME_CRC_BYTES = 4;

export interface GridSpec {
  /** Data area is `cells` x `cells`. */
  cells: number;
  palette: GridPalette;
}

export interface GridGeometry {
  /** Full frame width/height in cells, margin included. */
  totalCells: number;
  /** Marker centres in cell coordinates, ordered TL, TR, BR, BL. */
  markerCentres: { x: number; y: number }[];
  /** Rows of the data area used for colour calibration (first and last). */
  calibrationRows: number[];
  dataRows: number[];
  cellCount: number;
  capacityBytes: number;
  bodyBytes: number;
}

export function geometryFor(spec: GridSpec): GridGeometry {
  const total = spec.cells + MARGIN_CELLS * 2;
  const near = MARGIN_CELLS / 2;
  const far = total - MARGIN_CELLS / 2;

  const dataRows: number[] = [];
  for (let row = 1; row < spec.cells - 1; row++) dataRows.push(row);

  const cellCount = dataRows.length * spec.cells;
  const capacityBytes = Math.floor((cellCount * spec.palette.bitsPerCell) / 8);

  return {
    totalCells: total,
    markerCentres: [
      { x: near, y: near },
      { x: far, y: near },
      { x: far, y: far },
      { x: near, y: far },
    ],
    calibrationRows: [0, spec.cells - 1],
    dataRows,
    cellCount,
    capacityBytes,
    bodyBytes: capacityBytes - FRAME_CRC_BYTES,
  };
}

/** Colour index shown by a calibration cell, cycling the palette across the row. */
export function calibrationColour(column: number, palette: GridPalette): number {
  return column % palette.colours.length;
}

export interface GridPreset {
  id: 'safe' | 'normal' | 'turbo';
  label: string;
  hint: string;
  cells: number;
  paletteId: GridPalette['id'];
  fps: number;
}

export const GRID_PRESETS: GridPreset[] = [
  { id: 'safe', label: 'Sicher', hint: '28 × 28 Zellen, 4 Farben', cells: 28, paletteId: 'safe', fps: 8 },
  { id: 'normal', label: 'Normal', hint: '40 × 40 Zellen, 8 Farben', cells: 40, paletteId: 'full', fps: 10 },
  { id: 'turbo', label: 'Turbo', hint: '56 × 56 Zellen, 8 Farben', cells: 56, paletteId: 'full', fps: 12 },
];

export function specFor(preset: GridPreset): GridSpec {
  return { cells: preset.cells, palette: GRID_PALETTES[preset.paletteId] };
}
