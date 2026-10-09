import type { V3 } from './map';

export interface Box { min: V3; max: V3 }

export const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box => ({
  min: { x: x0, y: y0, z: z0 },
  max: { x: x1, y: y1, z: z1 },
});

const key = (x: number, z: number) => (x + 512) * 1024 + (z + 512);

/** Boxes bucketed by the 1 m columns they cover, so collision only checks nearby boxes. */
export class SolidIndex {
  private cols = new Map<number, Box[]>();
  constructor(readonly boxes: Box[]) {
    for (const b of boxes)
      for (let x = Math.floor(b.min.x); x < Math.ceil(b.max.x); x++)
        for (let z = Math.floor(b.min.z); z < Math.ceil(b.max.z); z++) {
          const k = key(x, z);
          const list = this.cols.get(k);
          if (list) list.push(b);
          else this.cols.set(k, [b]);
        }
  }

  near(x0: number, z0: number, x1: number, z1: number): Box[] {
    const out = new Set<Box>();
    for (let x = Math.floor(x0); x <= Math.floor(x1); x++)
      for (let z = Math.floor(z0); z <= Math.floor(z1); z++) this.cols.get(key(x, z))?.forEach((b) => out.add(b));
    return [...out];
  }
}

const EPS = 1e-4;

export interface Body { pos: V3; vy: number; onGround: boolean }

function hits(solids: SolidIndex[], p: V3, hw: number, h: number): Box[] {
  const out: Box[] = [];
  for (const s of solids)
    for (const b of s.near(p.x - hw, p.z - hw, p.x + hw, p.z + hw))
      if (
        p.x + hw > b.min.x + EPS && p.x - hw < b.max.x - EPS &&
        p.z + hw > b.min.z + EPS && p.z - hw < b.max.z - EPS &&
        p.y + h > b.min.y + EPS && p.y < b.max.y - EPS
      ) out.push(b);
  return out;
}

export const STEP = 0.35;
export const GRAVITY = 20;

/** Moves a body (feet at pos, square footprint 2*hw, height h) by dx/dz, steps up small ledges, applies gravity. */
export function moveBody(body: Body, dx: number, dz: number, dt: number, hw: number, h: number, solids: SolidIndex[]) {
  const p = body.pos;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / 0.2));
  for (let i = 0; i < n; i++) {
    for (const axis of ['x', 'z'] as const) {
      const d = (axis === 'x' ? dx : dz) / n;
      if (!d) continue;
      p[axis] += d;
      const blocked = hits(solids, p, hw, h);
      if (!blocked.length) continue;
      const top = Math.max(...blocked.map((b) => b.max.y));
      if (body.onGround && top - p.y <= STEP) {
        const y = p.y;
        p.y = top + EPS;
        if (!hits(solids, p, hw, h).length) continue;
        p.y = y;
      }
      p[axis] -= d;
    }
  }
  body.vy -= GRAVITY * dt;
  p.y += body.vy * dt;
  const under = hits(solids, p, hw, h);
  body.onGround = false;
  if (under.length) {
    if (body.vy <= 0) {
      p.y = Math.max(...under.map((b) => b.max.y));
      body.onGround = true;
    } else {
      p.y = Math.min(...under.map((b) => b.min.y)) - h;
    }
    body.vy = 0;
  }
}

/** Distance along the ray to the box, or Infinity. dir need not be normalised; result is in units of dir. */
export function rayBox(o: V3, d: V3, b: Box): number {
  let t0 = 0;
  let t1 = Infinity;
  for (const a of ['x', 'y', 'z'] as const) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < b.min[a] || o[a] > b.max[a]) return Infinity;
      continue;
    }
    let ta = (b.min[a] - o[a]) / d[a];
    let tb = (b.max[a] - o[a]) / d[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/** Nearest hit along the ray, walking the 1 m grid columns it crosses and stopping once nothing nearer can follow. */
export function rayWorld(o: V3, d: V3, maxT: number, solids: SolidIndex[]): number {
  let best = maxT;
  let x = Math.floor(o.x);
  let z = Math.floor(o.z);
  const sx = Math.sign(d.x), sz = Math.sign(d.z);
  let tx = sx ? ((sx > 0 ? x + 1 : x) - o.x) / d.x : Infinity;
  let tz = sz ? ((sz > 0 ? z + 1 : z) - o.z) / d.z : Infinity;
  const dx = sx ? 1 / Math.abs(d.x) : Infinity;
  const dz = sz ? 1 / Math.abs(d.z) : Infinity;
  const seen = new Set<Box>();
  for (let t = 0; t <= best;) {
    for (const s of solids)
      for (const b of s.near(x + 0.5, z + 0.5, x + 0.5, z + 0.5)) {
        if (seen.has(b)) continue;
        seen.add(b);
        best = Math.min(best, rayBox(o, d, b));
      }
    if (tx < tz) { t = tx; tx += dx; x += sx; } else { t = tz; tz += dz; z += sz; }
    if (!Number.isFinite(t)) break;
  }
  return best;
}

export function pointInBox(p: V3, b: Box): boolean {
  return p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y && p.z > b.min.z && p.z < b.max.z;
}

export const dist2 = (a: V3, b: V3) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
