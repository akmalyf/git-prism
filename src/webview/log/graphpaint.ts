// Paints one row of the commit graph on a canvas (IntelliJ SimpleGraphCellPainter semantics, see PROTOCOL.md):
// half-row edge segments, arrows for long/terminal edges, dotted edges to unloaded parents, the commit node
// (HEAD drawn as a ring); lane colors are IntelliJ's DefaultColorGenerator (color id → hue, saturation/brightness of
// the Islands Dark / Light themes); hit-testing of arrows.
import { EDGE_DOWN, EDGE_TUPLE, FLAG_ARROW, FLAG_DOTTED, FLAG_TERMINAL } from '../../features/log/graph';
import type { GraphRowPrint } from '../../features/log/protocol';

/** lane width (IntelliJ PaintParameters.getElementWidth) */
export const LANE = 16;
/** PaintParameters.getCircleRadius / getLineThickness */
const RADIUS = 4;
const LINE = 1.5;
const ARROW = 4;

export function isLightTheme(): boolean {
  return /\bvscode-(light|high-contrast-light)\b/.test(document.body.className);
}

// java.awt.Color.RGBtoHSB / HSBtoRGB
function hue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const rc = (max - r) / d;
  const gc = (max - g) / d;
  const bc = (max - b) / d;
  let h = r === max ? bc - gc : g === max ? 2 + rc - bc : 4 + gc - rc;
  h /= 6;
  return h < 0 ? h + 1 : h;
}
function hsbToRgb(h: number, s: number, v: number): [number, number, number] {
  if (s === 0) {
    const x = Math.trunc(v * 255 + 0.5);
    return [x, x, x];
  }
  const hh = (h - Math.floor(h)) * 6;
  const f = hh - Math.floor(hh);
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  let rgb: [number, number, number];
  switch (Math.floor(hh)) {
    case 0: rgb = [v, t, p]; break;
    case 1: rgb = [q, v, p]; break;
    case 2: rgb = [p, v, t]; break;
    case 3: rgb = [p, q, v]; break;
    case 4: rgb = [t, p, v]; break;
    default: rgb = [v, p, q];
  }
  return rgb.map((x) => Math.trunc(x * 255 + 0.5)) as [number, number, number];
}
const rangeFix = (n: number) => Math.abs(n % 100) + 70;
const cache = new Map<string, string>();

/**
 * IntelliJ DefaultColorGenerator.calcColor: color id → hue, with the VersionControl.Log.Graph saturation/brightness
 * of the Islands themes (dark 0.6/0.6, light 0.6/0.7). Id 0 (a lineage without a ref) is JBColor.BLACK.
 */
export function laneColor(id: number, light = isLightTheme()): string {
  id |= 0;
  if (id === 0) return light ? '#000000' : '#bbbbbb';
  const key = `${light ? 'l' : 'd'}${id}`;
  let c = cache.get(key);
  if (!c) {
    const r = rangeFix((Math.imul(id, 200) + 30) | 0);
    const g = rangeFix((Math.imul(id, 130) + 50) | 0);
    const b = rangeFix((Math.imul(id, 90) + 100) | 0);
    const [R, G, B] = hsbToRgb(hue(r, g, b), 0.6, light ? 0.7 : 0.6);
    c = `#${[R, G, B].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
    cache.set(key, c);
  }
  return c;
}

/** Width in px taken by the graph of a row (text starts after it). */
export function graphPixelWidth(print: GraphRowPrint | undefined): number {
  return print ? Math.max(1, print.width) * LANE + 4 : LANE;
}

const cx = (p: number) => p * LANE + LANE / 2;

function arrowHead(ctx: CanvasRenderingContext2D, x: number, y: number, fromX: number, fromY: number): void {
  const a = Math.atan2(y - fromY, x - fromX);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - ARROW * Math.cos(a - Math.PI / 4), y - ARROW * Math.sin(a - Math.PI / 4));
  ctx.moveTo(x, y);
  ctx.lineTo(x - ARROW * Math.cos(a + Math.PI / 4), y - ARROW * Math.sin(a + Math.PI / 4));
  ctx.stroke();
}

/** Draws the row graph; the canvas must already be sized (css px × dpr) and the context scaled by dpr. */
export function paintGraph(ctx: CanvasRenderingContext2D, print: GraphRowPrint, height: number, head: boolean, light = isLightTheme()): void {
  const H = height;
  const mid = H / 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = LINE;
  const e = print.edges;
  for (let i = 0; i + EDGE_TUPLE <= e.length; i += EDGE_TUPLE) {
    const pos = e[i];
    const to = e[i + 1];
    const down = e[i + 2] === EDGE_DOWN;
    const flags = e[i + 4];
    ctx.strokeStyle = laneColor(e[i + 3], light);
    ctx.setLineDash(flags & FLAG_DOTTED ? [1.5, 3] : []);
    const x0 = cx(pos);
    if (flags & FLAG_TERMINAL) {
      const y1 = down ? H - 3 : 3;
      ctx.beginPath();
      ctx.moveTo(x0, mid);
      ctx.lineTo(x0, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      arrowHead(ctx, x0, y1, x0, mid);
      continue;
    }
    const x1 = (cx(pos) + cx(to)) / 2;
    const y1 = down ? H : 0;
    ctx.beginPath();
    ctx.moveTo(x0, mid);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    if (flags & FLAG_ARROW) {
      ctx.setLineDash([]);
      arrowHead(ctx, x1, y1, x0, mid);
    }
  }
  ctx.setLineDash([]);
  if (print.node < 0) return;
  const x = cx(print.node);
  ctx.fillStyle = ctx.strokeStyle = laneColor(print.color, light);
  if (head) {
    // ring: clear the inside so edges don't show through, then stroke
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(x, mid, RADIUS + 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, mid, RADIUS - 0.5, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(x, mid, RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The terminal arrow under (x, y) of a row: its target row, or undefined. */
export function arrowAt(print: GraphRowPrint | undefined, x: number, y: number, height: number): number | undefined {
  if (!print) return undefined;
  const e = print.edges;
  for (let i = 0; i + EDGE_TUPLE <= e.length; i += EDGE_TUPLE) {
    if (!(e[i + 4] & FLAG_TERMINAL) || e[i + 5] < 0) continue;
    const down = e[i + 2] === EDGE_DOWN;
    const inHalf = down ? y >= height / 2 - 2 : y <= height / 2 + 2;
    if (inHalf && Math.abs(x - cx(e[i])) <= LANE / 2 - 2) return e[i + 5];
  }
  return undefined;
}
