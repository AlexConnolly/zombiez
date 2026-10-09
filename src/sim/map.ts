export type V3 = { x: number; y: number; z: number };
export type Dir = 'n' | 's' | 'e' | 'w';
/** Windows may also face up: a skylight, entered by dropping from the roof. */
export type Facing = Dir | 'up';
export type P3 = [number, number, number];
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
    facing: Facing;
    zone: string;
    /** Where zombies for this window appear; one is picked at random. */
    spawns?: P3[];
    /** Points walked from the spawn, ending outside the window. A leg that rises or drops more than it travels is climbed at 1 m/s. */
    approach?: P3[];
    /** Barricade size; defaults to 6. */
    boards?: number;
    /** Opening height above the floor, [bottom, top]. */
    opening?: [number, number];
  }[];
  /** needs: zones that must be open before this door can be bought. */
  doors: { id: string; floor: string; cells: Cell[]; cost: number; opens: string; needs?: string[] }[];
  /** slide: players at the top can slide down the banister. */
  stairs: { floor: string; cells: Cell[]; up: Dir; slide?: boolean }[];
  wallBuys: (Placed & { weapon: string; facing: Dir })[];
  boxSpots: (Placed & { zone: string })[];
  perks: (Placed & { perk: string })[];
  power?: Placed & { facing: Dir };
  lamps: Placed[];
  /** Render only: the outside ground as boxes, replacing the flat plane. */
  ground?: { min: P3; max: P3; color: string }[];
  /** Render only: street furniture, neighbours and so on. size is [w, h, d]; rot turns about y. */
  props?: { kind: string; pos: P3; size?: P3; rot?: number; color?: string }[];
  /** Render only: a mansard roof over the top floor, from the eaves up to a flat top at the ridge. */
  roof?: { eaves: number; ridge: number };
  ambience?: 'country' | 'city';
  /** Bought machines that, after a delay, kill every zombie inside box and hurt players there. */
  traps?: (Placed & { id: string; cost: number; box: { min: P3; max: P3 }; delay: number; cooldown: number; playerDamage: number })[];
  /** Paid links between two spots, e.g. a dumbwaiter: using one end refills the ammo of players at the other. */
  links?: { a: Placed; b: Placed; cost: number }[];
  /** Items hidden in count of the spots (picked by the seed). Bring them all to drop and every player may take one box weapon there once. */
  secret?: { spots: (Placed & { name: string })[]; count: number; drop: Placed };
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

export const maxBoards = (w: WindowDef) => w.boards ?? 6;
export const facingDir = (f: Facing): Cell => (f === 'up' ? [0, 0] : DIRS[f]);
export const v3 = ([x, y, z]: P3): V3 => ({ x, y, z });

export function windowGeom(map: MapDef, w: WindowDef) {
  const fi = floorIndex(map, w.floor);
  const [dx, dz] = facingDir(w.facing);
  const cs = w.cells.map(([x, z]) => cellCenter(map, fi, x, z));
  const c = { x: cs.reduce((a, p) => a + p.x, 0) / cs.length, y: map.floors[fi].y, z: cs.reduce((a, p) => a + p.z, 0) / cs.length };
  const s = map.cellSize;
  const plain = w.facing === 'up'
    ? { x: c.x, y: c.y + floorHeight(map, fi) + 0.3, z: c.z }
    : { x: c.x + dx * 0.9 * s, y: Math.max(0, c.y), z: c.z + dz * 0.9 * s };
  const path = w.approach?.map(v3) ?? [plain];
  return {
    center: c,
    /** Where a zombie stands to tear the boards. */
    outside: path[path.length - 1],
    /** The same spot worked out from the window alone; an approach path must end near it. */
    plain,
    path,
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
    const g = windowGeom(map, w);
    const o = g.outside, q = g.plain;
    const top = g.center.y + floorHeight(map, floorIndex(map, w.floor));
    const yOk = w.facing === 'up' ? o.y >= top && o.y < top + 1 : o.y > g.center.y - 0.5 && o.y <= top;
    if (Math.hypot(o.x - q.x, o.z - q.z) > 1 || !yOk) errs.push(`window ${w.id}: approach path ends away from the window`);
    if (w.facing === 'up') {
      const fi = floorIndex(map, w.floor);
      for (const c of w.cells) {
        if (at(w.floor, c) !== '.') errs.push(`window ${w.id}: skylight cell ${c} has no room below`);
        if (tile(map, fi + 1, c[0], c[1]) !== ' ') errs.push(`window ${w.id}: skylight cell ${c} is covered by the floor above`);
      }
      continue;
    }
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
    ...(map.traps ?? []).map((t) => [`trap ${t.id}`, t] as [string, Placed]),
    ...(map.links ?? []).flatMap((l) => [['link', l.a], ['link', l.b]] as [string, Placed][]),
    ...(map.secret ? [...map.secret.spots.map((p) => [`secret ${p.name}`, p] as [string, Placed]), ['secret drop', map.secret.drop] as [string, Placed]] : []),
  ];
  for (const [what, p] of placed) {
    checkFloor(p.floor, what);
    if (at(p.floor, p.cell) !== '.') errs.push(`${what}: cell ${p.cell} on ${p.floor} is not floor`);
  }
  if (map.secret && map.secret.count > map.secret.spots.length) errs.push('secret: more items than hiding spots');
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
