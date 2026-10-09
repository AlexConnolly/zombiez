import { DIRS, cellCenter, floorHeight, floorIndex, isWalkTile, stairExits, tile, windowOpening, type Cell, type Dir, type MapDef, type V3 } from './map';
import { SolidIndex, box, type Box } from './physics';

const SLAB = 0.2;

/** Static geometry and navigation derived from a map. Not part of the serialisable game state. */
export class World {
  readonly staticBody: SolidIndex;
  readonly staticRay: SolidIndex;
  dynamic = new SolidIndex([]);
  /** For each nav node: [neighbour, cost] pairs. */
  edges: [number, number][][] = [];
  readonly offsets: number[] = [];
  readonly nodeCount: number;
  readonly stairBoxes: Box[] = [];
  /** Visible static geometry, tagged for the renderer. */
  readonly renderBoxes: { box: Box; kind: 'wall' | 'floor' | 'roof' | 'stair' | 'rail'; fi: number }[] = [];
  /** For each stair cell: the cells it may be entered from (below the bottom step, and beside it). */
  private stairCell = new Map<number, { fi: number; bottom: Set<number>; up: Dir }>();
  private blocked = new Set<number>();

  constructor(readonly map: MapDef) {
    let n = 0;
    for (const f of map.floors) {
      this.offsets.push(n);
      n += f.tiles.length * (f.tiles[0]?.length ?? 0);
    }
    this.nodeCount = n;

    const body: Box[] = [];
    const ray: Box[] = [];
    const both = (b: Box) => (body.push(b), ray.push(b));

    for (const s of map.stairs) {
      const fi = floorIndex(map, s.floor);
      const [dx, dz] = DIRS[s.up];
      const prog = (c: Cell) => c[0] * dx + c[1] * dz;
      const lo = Math.min(...s.cells.map(prog));
      const len = Math.max(...s.cells.map(prog)) - lo + 1;
      const Y = map.floors[fi].y;
      const rise = map.floors[fi + 1].y - Y;
      const per = Math.ceil(rise / 0.25 / len);
      // The bottom cell is one flat step, so it can be stepped onto from the side as well as from below.
      const steps = per * len - per + 1;
      const bottom = new Set<number>();
      for (const c of s.cells) {
        if (prog(c) !== lo) continue;
        bottom.add(this.node(fi, c[0] - dx, c[1] - dz));
        for (const [sx, sz] of [[dz, dx], [-dz, -dx]]) if (!s.cells.some((o) => o[0] === c[0] + sx && o[1] === c[1] + sz)) bottom.add(this.node(fi, c[0] + sx, c[1] + sz));
      }
      for (const c of s.cells) {
        this.stairCell.set(this.node(fi, c[0], c[1]), { fi, bottom: prog(c) === lo ? bottom : new Set(), up: s.up });
        for (let j = 0; j < per; j++) {
          const k = Math.max(0, (prog(c) - lo) * per + j - (per - 1));
          const top = Y + (rise * (k + 1)) / steps;
          // Sub-step j covers the slice [j/per, (j+1)/per] of the cell, counted from its low side.
          const a = j / per;
          const b = (j + 1) / per;
          const [x, z] = c;
          const bx =
            s.up === 'n' ? box(x, Y - SLAB, z + 1 - b, x + 1, top, z + 1 - a) :
            s.up === 's' ? box(x, Y - SLAB, z + a, x + 1, top, z + b) :
            s.up === 'e' ? box(x + a, Y - SLAB, z, x + b, top, z + 1) :
            box(x + 1 - b, Y - SLAB, z, x + 1 - a, top, z + 1);
          both(bx);
          this.stairBoxes.push(bx);
          this.renderBoxes.push({ box: bx, kind: 'stair', fi });
        }
      }
    }

    // Railings: each 'R' hole gets a rail on every side that faces floor, except where its stairs come out.
    const exits = new Set<number>();
    for (const s of map.stairs) for (const [x, z] of stairExits(map, s)) exits.add(this.node(floorIndex(map, s.floor) + 1, x, z));
    map.floors.forEach((f, fi) =>
      f.tiles.forEach((row, z) =>
        [...row].forEach((t, x) => {
          if (t !== 'R') return;
          const Y = f.y;
          for (const d of ['n', 's', 'e', 'w'] as Dir[]) {
            const [dx, dz] = DIRS[d];
            const nt = tile(map, fi, x + dx, z + dz);
            const n = this.node(fi, x + dx, z + dz);
            if (!isWalkTile(nt) || exits.has(n)) continue;
            const st = this.stairCell.get(n);
            if (st && (DIRS[st.up][0] === 0) === (dx === 0)) continue;
            // Beside a flight on this floor the rail is a full-height banister; elsewhere waist high. It sits just inside the neighbour cell.
            const h = st ? floorHeight(map, fi) : 1;
            const T = 0.08;
            const cx = x + 0.5 + dx * 0.5, cz = z + 0.5 + dz * 0.5;
            const bx = dx ? box(cx + (dx > 0 ? 0 : -T), Y, z, cx + (dx > 0 ? T : 0), Y + h, z + 1) : box(x, Y, cz + (dz > 0 ? 0 : -T), x + 1, Y + h, cz + (dz > 0 ? T : 0));
            body.push(bx);
            this.renderBoxes.push({ box: bx, kind: 'rail', fi });
          }
        }),
      ),
    );

    const skylights = new Set(map.windows.filter((w) => w.facing === 'up').flatMap((w) => w.cells.map(([x, z]) => this.node(floorIndex(map, w.floor), x, z))));
    map.floors.forEach((f, fi) => {
      const Y = f.y;
      const H = floorHeight(map, fi);
      const above = map.floors[fi + 1];
      f.tiles.forEach((row, z) =>
        [...row].forEach((t, x) => {
          const vis = (b: Box, kind: 'wall' | 'floor' | 'roof') => (both(b), this.renderBoxes.push({ box: b, kind, fi }));
          if (t === '#') vis(box(x, Y - SLAB, z, x + 1, Y + H, z + 1), 'wall');
          if (t === 'W') {
            const [lo, hi] = windowOpening(map, map.windows.find((w) => w.floor === f.id && w.cells.some((c) => c[0] === x && c[1] === z))!);
            body.push(box(x, Y - SLAB, z, x + 1, Y + H, z + 1));
            for (const b of [box(x, Y - SLAB, z, x + 1, Y + lo, z + 1), box(x, Y + hi, z, x + 1, Y + H, z + 1)]) {
              ray.push(b);
              this.renderBoxes.push({ box: b, kind: 'wall', fi });
            }
          }
          if (t === '.' || t === 'D') vis(box(x, Y - SLAB, z, x + 1, Y, z + 1), 'floor');
          const holeOverStairs = (t === ' ' || t === 'R') && tile(map, fi - 1, x, z) === 'S';
          const interior = t !== ' ' || holeOverStairs;
          if (interior && t !== 'S' && !skylights.has(this.node(fi, x, z)) && (!above || tile(map, fi + 1, x, z) === ' '))
            vis(box(x, Y + H - SLAB, z, x + 1, Y + H, z + 1), 'roof');
        }),
      );
    });

    for (const p of map.perks) {
      const fi = floorIndex(map, p.floor);
      const [x, z] = p.cell;
      const Y = map.floors[fi].y;
      both(box(x + 0.15, Y, z + 0.15, x + 0.85, Y + 2, z + 0.85));
      this.blocked.add(this.node(fi, x, z));
    }
    for (const p of map.boxSpots) this.blocked.add(this.node(floorIndex(map, p.floor), p.cell[0], p.cell[1]));

    this.staticBody = new SolidIndex(body);
    this.staticRay = new SolidIndex(ray);
  }

  node(fi: number, x: number, z: number): number {
    const f = this.map.floors[fi];
    const w = f.tiles[0].length;
    if (x < 0 || z < 0 || x >= w || z >= f.tiles.length) return -1;
    return this.offsets[fi] + z * w + x;
  }

  nodeCell(n: number): { fi: number; x: number; z: number } {
    let fi = this.offsets.length - 1;
    while (this.offsets[fi] > n) fi--;
    const w = this.map.floors[fi].tiles[0].length;
    const i = n - this.offsets[fi];
    return { fi, x: i % w, z: Math.floor(i / w) };
  }

  nodePos(n: number): V3 {
    const { fi, x, z } = this.nodeCell(n);
    return cellCenter(this.map, fi, x, z);
  }

  /** Rebuilds the parts that change: closed doors, the mystery box, and the walkable graph. */
  update(openDoors: Record<string, boolean>, boxSpot: number) {
    const map = this.map;
    const dyn: Box[] = [];
    const closed = new Set<number>();
    for (const d of map.doors) {
      if (openDoors[d.id]) continue;
      const fi = floorIndex(map, d.floor);
      const Y = map.floors[fi].y;
      for (const [x, z] of d.cells) {
        dyn.push(box(x, Y, z, x + 1, Y + floorHeight(map, fi), z + 1));
        closed.add(this.node(fi, x, z));
      }
    }
    const spot = map.boxSpots[boxSpot];
    if (spot) {
      const fi = floorIndex(map, spot.floor);
      const [x, z] = spot.cell;
      const Y = map.floors[fi].y;
      dyn.push(box(x + 0.05, Y, z + 0.2, x + 0.95, Y + 0.9, z + 0.8));
    }
    this.dynamic = new SolidIndex(dyn);
    this.flows.clear();

    const walk = (n: number) => {
      if (n < 0 || closed.has(n) || this.blocked.has(n)) return false;
      const { fi, x, z } = this.nodeCell(n);
      const t = tile(map, fi, x, z);
      return t === '.' || t === 'S' || t === 'D';
    };
    const link = (a: number, b: number) => {
      const sa = this.stairCell.get(a);
      const sb = this.stairCell.get(b);
      if (sa && sb) return true;
      if (sa) return sa.bottom.has(b);
      if (sb) return sb.bottom.has(a);
      return true;
    };
    this.edges = Array.from({ length: this.nodeCount }, () => []);
    map.floors.forEach((f, fi) =>
      f.tiles.forEach((row, z) =>
        [...row].forEach((_, x) => {
          const a = this.node(fi, x, z);
          if (!walk(a)) return;
          for (let dz = -1; dz <= 1; dz++)
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dz) continue;
              const b = this.node(fi, x + dx, z + dz);
              if (!walk(b) || !link(a, b)) continue;
              if (dx && dz && (!walk(this.node(fi, x + dx, z)) || !walk(this.node(fi, x, z + dz)))) continue;
              this.edges[a].push([b, dx && dz ? Math.SQRT2 : 1]);
            }
        }),
      ),
    );
    for (const s of map.stairs) {
      const fi = floorIndex(map, s.floor);
      const [dx, dz] = DIRS[s.up];
      const exits = stairExits(map, s);
      for (const [x, z] of exits) {
        const a = this.node(fi, x - dx, z - dz);
        const b = this.node(fi + 1, x, z);
        if (walk(a) && walk(b)) {
          this.edges[a].push([b, 1]);
          this.edges[b].push([a, 1]);
        }
      }
    }
  }

  /** Nav node under a position, or -1. */
  nodeAt(p: V3): number {
    const fl = this.map.floors;
    let fi = fl.length - 1;
    while (fi > 0 && fl[fi].y > p.y + 0.6) fi--;
    const x = Math.floor(p.x / this.map.cellSize);
    const z = Math.floor(p.z / this.map.cellSize);
    for (; fi >= 0; fi--) {
      const n = this.node(fi, x, z);
      if (n >= 0 && this.edges[n]?.length) return n;
    }
    return -1;
  }

  private flows = new Map<number, Float64Array>();

  /** Path cost from every node to the target node (Dijkstra). Unreachable = Infinity. Cached until the doors change. */
  flow(target: number): Float64Array {
    const hit = this.flows.get(target);
    if (hit) return hit;
    const d = new Float64Array(this.nodeCount).fill(Infinity);
    if (target >= 0) {
      d[target] = 0;
      // Binary heap of [cost, node]; stale entries are skipped when popped.
      const heap: [number, number][] = [[0, target]];
      const less = (i: number, j: number) => heap[i][0] < heap[j][0];
      const swap = (i: number, j: number) => { [heap[i], heap[j]] = [heap[j], heap[i]]; };
      while (heap.length) {
        const [du, u] = heap[0];
        const end = heap.pop()!;
        if (heap.length) {
          heap[0] = end;
          for (let i = 0; ;) {
            const l = 2 * i + 1, r = l + 1;
            let m = i;
            if (l < heap.length && less(l, m)) m = l;
            if (r < heap.length && less(r, m)) m = r;
            if (m === i) break;
            swap(i, m);
            i = m;
          }
        }
        if (du > d[u]) continue;
        for (const [v, c] of this.edges[u]) {
          if (du + c >= d[v]) continue;
          d[v] = du + c;
          heap.push([d[v], v]);
          for (let i = heap.length - 1; i > 0;) {
            const parent = (i - 1) >> 1;
            if (!less(i, parent)) break;
            swap(i, parent);
            i = parent;
          }
        }
      }
    }
    if (this.flows.size > 64) this.flows.clear();
    this.flows.set(target, d);
    return d;
  }

  body(): SolidIndex[] { return [this.staticBody, this.dynamic]; }
  ray(): SolidIndex[] { return [this.staticRay, this.dynamic]; }
}
