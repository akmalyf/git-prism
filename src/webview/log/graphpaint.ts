// Paints one row of the commit graph on a canvas (IntelliJ SimpleGraphCellPainter semantics, see PROTOCOL.md):
// half-row edge segments, arrows for long/terminal edges, dotted edges to unloaded parents, the commit node
// (HEAD drawn as a ring) in a JetBrains-like lane palette for dark and light themes; hit-testing of arrows.
import { EDGE_DOWN, EDGE_TUPLE, FLAG_ARROW, FLAG_DOTTED, FLAG_TERMINAL } from '../../features/log/graph';
import type { GraphRowPrint } from '../../features/log/protocol';

/** lane width (IntelliJ WIDTH_NODE 15 at 22 px rows, scaled to 24 px) */
export const LANE = 16;
const RADIUS = 4.25;
const LINE = 1.6;
const ARROW = 4;

const DARK = ['#548af7', '#5fad65', '#d6845a', '#a571e6', '#2fa3b0', '#d6ae58', '#e06c75', '#e55b9c', '#8fb365', '#8e97e8', '#c9a26d', '#56b6c2'];
const LIGHT = ['#3574f0', '#3b8547', '#b5592b', '#834df0', '#16808f', '#9e7614', '#c94f4f', '#c23d84', '#5e8a33', '#5160d6', '#8f6a37', '#1e8a99'];

export function isLightTheme(): boolean {
  return /\bvscode-(light|high-contrast-light)\b/.test(document.body.className);
}

export function laneColor(id: number, light = isLightTheme()): string {
  const p = light ? LIGHT : DARK;
  return p[((id % p.length) + p.length) % p.length];
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
