export type V3 = { x: number; y: number; z: number };
export type Dir = 'n' | 's' | 'e' | 'w';
export type Cell = [number, number];

export const DIRS: Record<Dir, Cell> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

export interface FloorDef {
  id: string;
  y: number;
  tiles: string[];
  /** Wall height on this floor; defaults to the map's wallHeight. */
  height?: number;
  wallColor?: string;
  floorColor?: string;
}
export interface Placed { floor: string; cell: Cell }

export interface MapDef {
  id: string;
  name: string;
  version: 1;
  cellSize: number;
  wallHeight: number;
  startZone: string;
  floors: FloorDef[];
  playerSpawns: Placed[];
  windows: {
    id: string;
    floor: string;
    cells: Cell[];
    facing: Dir;
    zone: string;
    /** Barricade size; defaults to 6. */
    boards?: number;
    /** Opening height above the floor, [bottom, top]. */
    opening?: [number, number];
  }[];
  /** needs: zones that must be open before this door can be bought. */
  doors: { id: string; floor: string; cells: Cell[]; cost: number; opens: string; needs?: string[] }[];
  stairs: { floor: string; cells: Cell[]; up: Dir }[];
  wallBuys: (Placed & { weapon: string; facing: Dir })[];
  boxSpots: (Placed & { zone: string })[];
  perks: (Placed & { perk: string })[];
  power?: Placed & { facing: Dir };
  lamps: Placed[];
}

export type WindowDef = MapDef['windows'][number];

export const floorIndex = (map: MapDef, id: string) => map.floors.findIndex((f) => f.id === id);

export function tile(map: MapDef, fi: number, x: number, z: number): string {
  return map.floors[fi]?.tiles[z]?.[x] ?? ' ';
}

export const floorHeight = (map: MapDef, fi: number) => map.floors[fi].height ?? map.wallHeight;

export function cellCenter(map: MapDef, fi: number, x: number, z: number): V3 {
  const s = map.cellSize;
  return { x: (x + 0.5) * s, y: map.floors[fi].y, z: (z + 0.5) * s };
}

export function placedPos(map: MapDef, p: Placed): V3 {
  return cellCenter(map, floorIndex(map, p.floor), p.cell[0], p.cell[1]);
}

/** Opening height above the floor: cellar windows sit at the top of the wall, at ground level outside. */
export function windowOpening(map: MapDef, w: WindowDef): [number, number] {
  if (w.opening) return w.opening;
  return map.floors[floorIndex(map, w.floor)].y < 0 ? [2.0, 2.8] : [0.9, 2.3];
}

export function windowGeom(map: MapDef, w: WindowDef) {
  const fi = floorIndex(map, w.floor);
  const [dx, dz] = DIRS[w.facing];
  const cs = w.cells.map(([x, z]) => cellCenter(map, fi, x, z));
  const c = { x: cs.reduce((a, p) => a + p.x, 0) / cs.length, y: map.floors[fi].y, z: cs.reduce((a, p) => a + p.z, 0) / cs.length };
  const outY = Math.max(0, c.y);
  const s = map.cellSize;
  return {
    center: c,
    outside: { x: c.x + dx * 0.9 * s, y: outY, z: c.z + dz * 0.9 * s },
    inside: { x: c.x - dx * s, y: c.y, z: c.z - dz * s },
    spawn: { x: c.x + dx * 7 * s, y: 0, z: c.z + dz * 7 * s },
  };
}

const WALKABLE = new Set(['.', 'D', 'S']);
/** Tiles that leave a hole for the stairs below. 'R' is a hole edged with a railing. */
const HOLE = new Set([' ', 'R']);
export const isWalkTile = (t: string) => WALKABLE.has(t);

/** Returns a list of problems. Empty list = valid map. */
export function validateMap(map: MapDef): string[] {
  const errs: string[] = [];
  const fid = new Set(map.floors.map((f) => f.id));
  const checkFloor = (id: string, what: string) => !fid.has(id) && errs.push(`${what}: unknown floor ${id}`);
  for (const f of map.floors) {
    const w = f.tiles[0]?.length ?? 0;
    f.tiles.forEach((r, z) => r.length !== w && errs.push(`floor ${f.id}: row ${z} has length ${r.length}, expected ${w}`));
  }
  const at = (floor: string, [x, z]: Cell) => tile(map, floorIndex(map, floor), x, z);
  const zones = new Set([map.startZone, ...map.doors.map((d) => d.opens)]);

  for (const w of map.windows) {
    checkFloor(w.floor, `window ${w.id}`);
    if (!zones.has(w.zone)) errs.push(`window ${w.id}: zone ${w.zone} is never opened`);
    for (const c of w.cells) {
      if (at(w.floor, c) !== 'W') errs.push(`window ${w.id}: cell ${c} is not a W tile`);
      const [dx, dz] = DIRS[w.facing];
      if (!isWalkTile(at(w.floor, [c[0] - dx, c[1] - dz]))) errs.push(`window ${w.id}: no walkable cell inside ${c}`);
      if (at(w.floor, [c[0] + dx, c[1] + dz]) !== ' ') errs.push(`window ${w.id}: outside of ${c} is not open`);
    }
  }
  map.floors.forEach((f, fi) =>
    f.tiles.forEach((r, z) => [...r].forEach((t, x) => t === 'R' && tile(map, fi - 1, x, z) !== 'S' && errs.push(`floor ${f.id}: railing ${[x, z]} is not over stairs`))),
  );
  for (const d of map.doors) {
    checkFloor(d.floor, `door ${d.id}`);
    for (const n of d.needs ?? []) if (!zones.has(n)) errs.push(`door ${d.id}: needs zone ${n} that is never opened`);
    for (const c of d.cells) if (at(d.floor, c) !== 'D') errs.push(`door ${d.id}: cell ${c} is not a D tile`);
  }
  for (const s of map.stairs) {
    const fi = floorIndex(map, s.floor);
    if (fi < 0 || fi + 1 >= map.floors.length) { errs.push(`stairs on ${s.floor}: no floor above`); continue; }
    const above = map.floors[fi + 1].id;
    for (const c of s.cells) {
      if (at(s.floor, c) !== 'S') errs.push(`stairs on ${s.floor}: cell ${c} is not an S tile`);
      if (!HOLE.has(at(above, c))) errs.push(`stairs on ${s.floor}: cell ${c} is not open on ${above}`);
    }
    for (const c of stairExits(map, s)) if (!isWalkTile(at(above, c))) errs.push(`stairs on ${s.floor}: exit ${c} on ${above} is not walkable`);
  }
  const placed: [string, Placed][] = [
    ...map.playerSpawns.map((p) => ['player spawn', p] as [string, Placed]),
    ...map.wallBuys.map((p) => [`wall buy ${p.weapon}`, p] as [string, Placed]),
    ...map.boxSpots.map((p) => ['box spot', p] as [string, Placed]),
    ...map.perks.map((p) => [`perk ${p.perk}`, p] as [string, Placed]),
    ...(map.power ? [['power', map.power] as [string, Placed]] : []),
  ];
  for (const [what, p] of placed) {
    checkFloor(p.floor, what);
    if (at(p.floor, p.cell) !== '.') errs.push(`${what}: cell ${p.cell} on ${p.floor} is not floor`);
  }
  for (const b of map.boxSpots) if (!zones.has(b.zone)) errs.push(`box spot ${b.cell}: zone ${b.zone} is never opened`);
  if (!map.playerSpawns.length) errs.push('no player spawns');
  return errs;
}

/** The cells on the floor above that the top step of the stairs leads to. */
export function stairExits(map: MapDef, s: MapDef['stairs'][number]): Cell[] {
  const [dx, dz] = DIRS[s.up];
  const prog = (c: Cell) => c[0] * dx + c[1] * dz;
  const top = Math.max(...s.cells.map(prog));
  return s.cells.filter((c) => prog(c) === top).map(([x, z]) => [x + dx, z + dz]);
}
