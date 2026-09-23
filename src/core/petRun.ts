import type { WindowBox } from './tauri';

export type Side = 'top' | 'right' | 'bottom' | 'left';
export type Heading = 'right' | 'left' | 'down' | 'up';

export interface RailCursor {
  hwnd: number;
  side: Side;
  t: number;
}

export interface PetPlace {
  x: number;
  y: number;
  heading: Heading;
}

const NEXT: Record<Side, Side> = {
  top: 'right',
  right: 'bottom',
  bottom: 'left',
  left: 'top',
};

const HEADING: Record<Side, Heading> = {
  top: 'right',
  right: 'down',
  bottom: 'left',
  left: 'up',
};

const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];
const JOIN_GAP = 48;

function rail(win: WindowBox, side: Side) {
  const right = win.x + win.w;
  const bottom = win.y + win.h;
  if (side === 'top') return { ax: win.x, ay: win.y, bx: right, by: win.y };
  if (side === 'right') return { ax: right, ay: win.y, bx: right, by: bottom };
  if (side === 'bottom') return { ax: right, ay: bottom, bx: win.x, by: bottom };
  return { ax: win.x, ay: bottom, bx: win.x, by: win.y };
}

function sideLength(win: WindowBox, side: Side) {
  return side === 'top' || side === 'bottom' ? win.w : win.h;
}

function direction(side: Side): [number, number] {
  if (side === 'top') return [1, 0];
  if (side === 'right') return [0, 1];
  if (side === 'bottom') return [-1, 0];
  return [0, -1];
}

export function placeOnRail(win: WindowBox, side: Side, t: number, pw: number, ph: number): PetPlace {
  const seg = rail(win, side);
  const u = Math.min(1, Math.max(0, t));
  const px = seg.ax + (seg.bx - seg.ax) * u;
  const py = seg.ay + (seg.by - seg.ay) * u;
  const heading = HEADING[side];
  if (side === 'top') return { x: px - pw / 2, y: py - ph * 0.46, heading };
  if (side === 'bottom') return { x: px - pw / 2, y: py - ph * 0.64, heading };
  if (side === 'right') return { x: px - pw * 0.42, y: py - ph * 0.5, heading };
  return { x: px - pw * 0.58, y: py - ph * 0.5, heading };
}

function continuation(windows: WindowBox[], hwnd: number, side: Side, ex: number, ey: number): WindowBox | null {
  const [dx, dy] = direction(side);
  let best: WindowBox | null = null;
  let bestD = JOIN_GAP;
  for (const win of windows) {
    if (win.hwnd === hwnd) continue;
    const seg = rail(win, side);
    const gap = Math.hypot(seg.ax - ex, seg.ay - ey);
    const forward = (seg.bx - ex) * dx + (seg.by - ey) * dy;
    if (gap <= bestD && forward > 36) {
      bestD = gap;
      best = win;
    }
  }
  return best;
}

export function advanceRail(windows: WindowBox[], cursor: RailCursor, pixels: number): RailCursor {
  const win = windows.find((item) => item.hwnd === cursor.hwnd);
  if (!win) return cursor;
  const len = Math.max(48, sideLength(win, cursor.side));
  const t = cursor.t + pixels / len;
  if (t < 1) return { ...cursor, t };
  const end = rail(win, cursor.side);
  const next = continuation(windows, cursor.hwnd, cursor.side, end.bx, end.by);
  if (next) return { hwnd: next.hwnd, side: cursor.side, t: 0 };
  return { hwnd: cursor.hwnd, side: NEXT[cursor.side], t: 0 };
}

export function nearestRail(windows: WindowBox[], x: number, y: number, pw: number, ph: number): RailCursor | null {
  let best: RailCursor | null = null;
  let bestD = 260;
  for (const win of windows) {
    for (const side of SIDES) {
      const len = Math.max(48, sideLength(win, side));
      const steps = Math.max(2, Math.ceil(len / 48));
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const spot = placeOnRail(win, side, t, pw, ph);
        const dist = Math.hypot(spot.x - x, spot.y - y);
        if (dist < bestD) {
          bestD = dist;
          best = { hwnd: win.hwnd, side, t };
        }
      }
    }
  }
  return best;
}

export function headingFromMove(dx: number, dy: number, fallback: Heading): Heading {
  if (Math.abs(dx) > Math.abs(dy) + 6) return dx >= 0 ? 'right' : 'left';
  if (Math.abs(dy) > 6) return dy >= 0 ? 'down' : 'up';
  return fallback;
}
