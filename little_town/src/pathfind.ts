// Tile-grid weighted A* + Bresenham polyline rasterizer.
// onPath cells get a (default 0.3) cost discount so paths are
// preferred but not mandatory — NPCs deviate around blockers.

export class CostGrid {
  cells: Uint8Array;        // 0 walkable, 1 blocked
  onPath: Uint8Array;       // 0 / 1 — preferred path cells (rasterized polylines)
  cols: number; rows: number;

  constructor(cols: number, rows: number) {
    this.cols = cols; this.rows = rows;
    this.cells = new Uint8Array(cols * rows);
    this.onPath = new Uint8Array(cols * rows);
  }

  block(x: number, y: number) {
    if (x >= 0 && y >= 0 && x < this.cols && y < this.rows) this.cells[y * this.cols + x] = 1;
  }

  // Rasterize a line segment in tile space (Bresenham), widening to a
  // 3x3 stamp around each cell so NPCs walking just off-spine still
  // benefit from the path discount.
  rasterizeSegment(x0: number, y0: number, x1: number, y1: number) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    const stamp = (cx: number, cy: number) => {
      for (let dyy = -1; dyy <= 1; dyy++)
        for (let dxx = -1; dxx <= 1; dxx++) {
          const nx = cx + dxx, ny = cy + dyy;
          if (nx >= 0 && ny >= 0 && nx < this.cols && ny < this.rows) this.onPath[ny * this.cols + nx] = 1;
        }
    };
    // tslint:disable-next-line:no-constant-condition
    while (true) {
      stamp(x, y);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 <  dx) { err += dx; y += sy; }
    }
  }

  // Weighted A* with 8-direction movement. Diagonals require both
  // adjacent cardinals walkable (no clipping corners). Returns the
  // tile sequence [{x,y}, …] from start to goal, or null on failure.
  // costOn (default 1) and costOff (default 12) multiply the per-step
  // distance — 12× makes NPCs aggressively prefer drawn paths; they
  // will only deviate for short detours around blockers or to peel
  // off toward a goal. Heuristic is octile, kept admissible because
  // min-step cost is 1.
  findPath(sx: number, sy: number, gx: number, gy: number, costOn = 1.0, costOff = 12.0): { x: number; y: number }[] | null {
    if (sx < 0 || sy < 0 || sx >= this.cols || sy >= this.rows) return null;
    if (gx < 0 || gy < 0 || gx >= this.cols || gy >= this.rows) return null;
    if (this.cells[sy * this.cols + sx] || this.cells[gy * this.cols + gx]) return null;
    if (sx === gx && sy === gy) return [{ x: sx, y: sy }];

    const cols = this.cols, N = cols * this.rows;
    const came = new Int32Array(N).fill(-1);
    const gScore = new Float32Array(N).fill(Infinity);
    const closed = new Uint8Array(N);
    const startIdx = sy * cols + sx;
    const goalIdx  = gy * cols + gx;
    gScore[startIdx] = 0;

    const heap = new MinHeap<[number, number]>((a, b) => a[1] - b[1]);
    heap.push([startIdx, octile(sx, sy, gx, gy)]);

    const DIRS: [number, number, number][] = [
      [ 1,  0, 1], [-1, 0, 1], [0,  1, 1], [0, -1, 1],
      [ 1,  1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, -1, Math.SQRT2],
    ];

    while (heap.size > 0) {
      const [idx] = heap.pop()!;
      if (closed[idx]) continue;
      closed[idx] = 1;
      if (idx === goalIdx) {
        const out: { x: number; y: number }[] = [];
        let i = idx;
        while (i !== -1) { out.push({ x: i % cols, y: (i / cols) | 0 }); i = came[i]; }
        return out.reverse();
      }
      const cx = idx % cols, cy = (idx / cols) | 0;
      for (const [dx, dy, base] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= this.rows) continue;
        const nIdx = ny * cols + nx;
        if (this.cells[nIdx]) continue;
        if (dx && dy) {
          // No corner-cutting through solid neighbours.
          if (this.cells[cy * cols + nx] || this.cells[ny * cols + cx]) continue;
        }
        const stepMult = this.onPath[nIdx] ? costOn : costOff;
        const tentative = gScore[idx] + base * stepMult;
        if (tentative < gScore[nIdx]) {
          gScore[nIdx] = tentative;
          came[nIdx] = idx;
          heap.push([nIdx, tentative + octile(nx, ny, gx, gy)]);
        }
      }
    }
    return null;
  }
}

function octile(x0: number, y0: number, x1: number, y1: number) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

class MinHeap<T> {
  private a: T[] = [];
  private cmp: (x: T, y: T) => number;
  constructor(cmp: (x: T, y: T) => number) { this.cmp = cmp; }
  get size() { return this.a.length; }
  push(v: T) {
    this.a.push(v);
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(this.a[i], this.a[p]) < 0) { [this.a[i], this.a[p]] = [this.a[p], this.a[i]]; i = p; }
      else break;
    }
  }
  pop(): T | undefined {
    if (!this.a.length) return undefined;
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length) {
      this.a[0] = last;
      let i = 0;
      const n = this.a.length;
      // tslint:disable-next-line:no-constant-condition
      while (true) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let s = i;
        if (l < n && this.cmp(this.a[l], this.a[s]) < 0) s = l;
        if (r < n && this.cmp(this.a[r], this.a[s]) < 0) s = r;
        if (s === i) break;
        [this.a[s], this.a[i]] = [this.a[i], this.a[s]];
        i = s;
      }
    }
    return top;
  }
}
