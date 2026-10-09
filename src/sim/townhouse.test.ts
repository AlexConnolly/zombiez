import { describe, expect, it } from 'vitest';
import townhouse from '../maps/townhouse.json';
import { NO_INPUT, Sim, TICK, type Command } from './game';
import { floorIndex, isWalkTile, validateMap, type MapDef } from './map';
import { World } from './world';

const map = townhouse as MapDef;

function quiet(seed = 1, ids = ['p1']) {
  const sim = new Sim(map, seed, ids);
  sim.state.phaseT = 1e9;
  return sim;
}

function openAll(sim: Sim, except: string[] = []) {
  for (const d of map.doors) if (!except.includes(d.id)) sim.state.doors[d.id] = true;
  for (const d of map.doors) if (!except.includes(d.id)) sim.state.zones[d.opens] = true;
  sim.world.update(sim.state.doors, sim.state.box.spot);
}

/** Nav nodes reachable from a node, by breadth-first search over the walk graph. */
function reach(w: World, from: number) {
  const seen = new Set([from]);
  const q = [from];
  while (q.length) for (const [n] of w.edges[q.shift()!]) if (!seen.has(n)) { seen.add(n); q.push(n); }
  return seen;
}

const node = (w: World, floor: string, x: number, z: number) => w.node(floorIndex(map, floor), x, z);
const start = (w: World) => node(w, map.playerSpawns[0].floor, ...(map.playerSpawns[0].cell as [number, number]));

/** Every nav node that should be walkable: floor, door and stair tiles with no machine on them. */
function walkable(w: World) {
  const out: number[] = [];
  map.floors.forEach((f, fi) => f.tiles.forEach((r, z) => [...r].forEach((t, x) => {
    const n = w.node(fi, x, z);
    if (isWalkTile(t) && w.edges[n].length) out.push(n);
  })));
  return out;
}

/** Steers the player through a list of points (x, z), one after another. */
function walk(sim: Sim, pts: [number, number][], maxSeconds = 60) {
  const p = sim.state.players[0];
  let i = 0;
  for (let t = 0; t < maxSeconds / TICK && i < pts.length; t++) {
    const [x, z] = pts[i];
    const dx = x - p.pos.x, dz = z - p.pos.z;
    if (Math.hypot(dx, dz) < 0.3) { i++; continue; }
    const c: Command = { ...NO_INPUT, fwd: 1, yaw: Math.atan2(-dx, -dz) };
    sim.step({ p1: c });
  }
  return i === pts.length;
}

describe('townhouse map', () => {
  it('passes the validator', () => {
    expect(validateMap(map)).toEqual([]);
  });

  it('rejects a railing that is not over stairs', () => {
    const bad: MapDef = JSON.parse(JSON.stringify(map));
    bad.floors[4].tiles[5] = ' #R........# ';
    expect(validateMap(bad).some((e) => e.includes('railing'))).toBe(true);
  });

  it('with every door open, every walkable cell on all 5 floors is reachable from the start', () => {
    const sim = quiet();
    openAll(sim);
    const w = sim.world;
    const r = reach(w, start(w));
    const missing = walkable(w).filter((n) => !r.has(n)).map((n) => w.nodeCell(n));
    expect(missing).toEqual([]);
    expect(new Set([...r].map((n) => w.nodeCell(n).fi)).size).toBe(5);
  });

  it('from every walkable cell a stair is under 18 m away by path', () => {
    const sim = quiet();
    openAll(sim);
    const w = sim.world;
    const stairs = walkable(w).filter((n) => { const c = w.nodeCell(n); return map.floors[c.fi].tiles[c.z][c.x] === 'S'; });
    const best = new Float64Array(w.nodeCount).fill(Infinity);
    for (const s of stairs) w.flow(s).forEach((d, i) => (best[i] = Math.min(best[i], d)));
    const far = walkable(w).filter((n) => !(best[n] < 18)).map((n) => w.nodeCell(n));
    expect(far).toEqual([]);
  });

  it('the servants\' stair makes a loop: the basement and 1st floor can each be reached two ways', () => {
    for (const shut of ['basement', 'first']) {
      const sim = quiet();
      openAll(sim, [shut]);
      const w = sim.world;
      const floor = shut === 'basement' ? 'basement' : 'first';
      const r = reach(w, start(w));
      expect([...r].some((n) => w.nodeCell(n).fi === floorIndex(map, floor))).toBe(true);
    }
    const sim = quiet();
    openAll(sim, ['servants']);
    const r = reach(sim.world, start(sim.world));
    // Closed, the servants' stair top is only reachable from the 1st floor and its bottom from the basement.
    expect(r.has(node(sim.world, 'ground', 10, 17))).toBe(true);
  });

  it('the servants\' door can only be bought once the basement and 1st floor are open', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    p.points = 1e5;
    p.pos = { x: 9.5, y: 0, z: 19.5 };
    expect(sim.interaction('p1')?.kind).toBe('info');
    sim.state.zones.B = true;
    sim.state.zones.C = true;
    expect(sim.interaction('p1')).toMatchObject({ kind: 'door', id: 'servants', cost: 1500 });
  });

  it('a player walks from the basement to the attic using only the stairs', () => {
    const sim = quiet();
    openAll(sim);
    const p = sim.state.players[0];
    p.pos = { x: 6.5, y: -3, z: 15.5 };
    const ok = walk(sim, [
      [3.5, 15], [3.5, 7.2], // basement flight, up north into the hall
      [5.5, 6.5], [8.5, 10], [8.5, 12.5], [5.5, 18.5], [5.5, 19.5], [3.5, 19.5], [3.5, 13.3], // round the hole, side onto the ground flight, up to the 1st
      [5.5, 13.5], [5.5, 6.5], [3.5, 6.5], [3.5, 13.3], // round the flight, up the 1st flight to the 2nd
      [5.5, 13.5], [5.5, 19.5], [3.5, 19.5], [3.5, 12.5], // into the back bedroom, up to the attic
    ]);
    expect(ok).toBe(true);
    expect(p.pos.y).toBeCloseTo(9, 1);
  });

  it('closed doors stop the walk at the top of each flight', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    openAll(sim, ['first']);
    p.pos = { x: 5.5, y: 0, z: 19.5 };
    walk(sim, [[3.5, 19.5], [3.5, 12.5]], 6);
    expect(p.pos.z).toBeGreaterThan(13.6);
  });

  it('railings keep players out of the stairwell', () => {
    const sim = quiet();
    openAll(sim);
    const p = sim.state.players[0];
    p.pos = { x: 6.5, y: 0, z: 9.5 };
    walk(sim, [[2.5, 9.5]], 3);
    expect(p.pos.y).toBeCloseTo(0, 3);
    expect(p.pos.x).toBeGreaterThan(5.2);
  });
});
