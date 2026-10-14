import { describe, expect, it } from 'vitest';
import campsite from '../maps/campsite.json';
import { NO_INPUT, Sim, TICK, type Command, type GameEvent } from './game';
import { floorIndex, isWalkTile, placedPos, validateMap, windowGeom, type MapDef } from './map';
import { World } from './world';

const map = campsite as MapDef;

function quiet(ids = ['p1']) {
  const sim = new Sim(map, 1, ids);
  sim.state.phaseT = 1e9;
  for (const d of map.doors) { sim.state.doors[d.id] = true; sim.state.zones[d.opens] = true; }
  sim.world.update(sim.state.doors, sim.state.box.spot);
  for (const p of sim.state.players) p.points = 1e5;
  return sim;
}

function run(sim: Sim, seconds: number, cmds: Record<string, Partial<Command>> = {}): GameEvent[] {
  const evs: GameEvent[] = [];
  for (let i = 0; i < Math.round(seconds / TICK); i++)
    evs.push(...sim.step(Object.fromEntries(sim.state.players.map((p) => [p.id, { ...NO_INPUT, ...cmds[p.id] }]))));
  return evs;
}

const press = (sim: Sim, id = 'p1') => [...run(sim, TICK), ...run(sim, TICK * 2, { [id]: { use: true } })];

function reach(w: World, from: number) {
  const seen = new Set([from]);
  const q = [from];
  while (q.length) for (const [n] of w.edges[q.shift()!]) if (!seen.has(n)) { seen.add(n); q.push(n); }
  return seen;
}

/** A hunting zombie parked at a spot. */
function zombieAt(sim: Sim, x: number, z: number, y = 0) {
  const zb = sim.spawnZombie('gate');
  zb.state = 'hunt';
  zb.pos = { x, y, z };
  return zb;
}

describe('Camp Morrow map', () => {
  it('passes the validator', () => {
    expect(validateMap(map)).toEqual([]);
  });

  it('with every gate open, every walkable cell, the tower top included, is reachable from the start', () => {
    const sim = quiet();
    const w = sim.world;
    const machines = new Set([...map.perks, ...map.boxSpots].map((m) => w.node(floorIndex(map, m.floor), m.cell[0], m.cell[1])));
    const start = w.nodeAt(placedPos(map, map.playerSpawns[0]));
    const seen = reach(w, start);
    const missing: string[] = [];
    map.floors.forEach((f, fi) => f.tiles.forEach((r, z) => [...r].forEach((t, x) => {
      if (isWalkTile(t) && !machines.has(w.node(fi, x, z)) && !seen.has(w.node(fi, x, z))) missing.push(`${f.id} ${x},${z}`);
    })));
    expect(missing).toEqual([]);
  });

  it('with the gates shut, the start zone is fenced in', () => {
    const sim = new Sim(map, 1);
    const w = sim.world;
    const seen = reach(w, w.nodeAt(placedPos(map, map.playerSpawns[0])));
    expect([...seen].every((n) => { const c = w.nodeCell(n); return c.x > 15 && c.x < 35 && c.z > 10; })).toBe(true);
  });

  it('every zone has at least one barricade', () => {
    const zones = [map.startZone, ...map.doors.map((d) => d.opens)];
    for (const z of zones) expect(map.windows.some((w) => w.zone === z), z).toBe(true);
  });

  it('fences stop players but not bullets', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    p.pos = { x: 13.5, y: 0, z: 30.5 };
    run(sim, 1.5, { p1: { fwd: 1, yaw: -Math.PI / 2 } });
    expect(p.pos.x).toBeLessThan(15);
    const z = zombieAt(sim, 18.5, 30.5);
    z.hp = 1;
    run(sim, 0.2, { p1: { fire: true, yaw: -Math.PI / 2, pitch: -0.02 } });
    expect(sim.state.zombies).not.toContain(z);
  });

  it('a zombie from each barricade, the lake and the tower door included, gets in and reaches a player', () => {
    for (const win of map.windows) {
      const sim = quiet();
      const p = sim.state.players[0];
      p.pos = { ...windowGeom(map, win).inside };
      p.hp = 1e9;
      const zb = sim.spawnZombie(win.id);
      let hurt = false;
      for (let t = 0; t < 120 / TICK && !hurt; t++) hurt = sim.step({ p1: NO_INPUT }).some((e) => e.type === 'hurt');
      expect(hurt, win.id).toBe(true);
      expect(sim.state.zombies).toContain(zb);
    }
  });

  it('zombies through the tower door climb the stairs to a player on the platform', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    p.pos = { x: 47.5, y: 3.5, z: 4.5 };
    p.hp = 1e9;
    sim.state.windows.tower.boards = 0;
    sim.spawnZombie('tower');
    let hurt = false;
    for (let t = 0; t < 90 / TICK && !hurt; t++) hurt = sim.step({ p1: NO_INPUT }).some((e) => e.type === 'hurt');
    expect(hurt).toBe(true);
    expect(sim.state.zombies[0].pos.y).toBeGreaterThan(3);
  });

  it('nothing at the top of the tower sells ammo', () => {
    const tower = floorIndex(map, 'tower');
    expect(map.wallBuys.some((w) => floorIndex(map, w.floor) === tower)).toBe(false);
    expect(map.boxSpots.some((b) => floorIndex(map, b.floor) === tower)).toBe(false);
  });
});

describe('Camp Morrow machines', () => {
  it('feeding the fire kills every zombie in the ring after 1 s; the rest are spared; players inside take 50', () => {
    const sim = quiet();
    const trap = map.traps!.find((t) => t.kind === 'fire')!;
    const p = sim.state.players[0];
    p.pos = placedPos(map, trap);
    const inside = [zombieAt(sim, 21.5, 23.5), zombieAt(sim, 20.5, 31.5)];
    const outside = zombieAt(sim, 8.5, 35.5);
    for (const z of [...inside, outside]) z.hp = 1e9;
    const evs = press(sim);
    expect(sim.interaction('p1')).toMatchObject({ kind: 'info' });
    expect(evs).toContainEqual({ type: 'trap', id: trap.id, fire: false });
    expect(p.points).toBe(1e5 - 1000);
    const fire = run(sim, 1.1);
    expect(fire).toContainEqual({ type: 'trap', id: trap.id, fire: true });
    expect(sim.state.zombies).toEqual([outside]);
    expect(p.hp).toBe(50);
  });

  it('the Vespers bell stops every zombie for 4 s, then they come on', () => {
    const sim = quiet();
    const bell = map.traps!.find((t) => t.kind === 'bell')!;
    const p = sim.state.players[0];
    p.pos = placedPos(map, bell);
    const z = zombieAt(sim, 25.5, 30.5);
    expect(sim.interaction('p1')).toMatchObject({ kind: 'trap', label: 'Ring the bell', cost: 750 });
    press(sim);
    run(sim, 0.3);
    const at = { ...z.pos };
    run(sim, 3.5);
    expect(z.pos).toEqual(at);
    run(sim, 1);
    expect(Math.hypot(z.pos.x - at.x, z.pos.z - at.z)).toBeGreaterThan(0.5);
    expect(sim.interaction('p1')?.kind).toBe('info');
  });

  it('a crossbow bolt goes through 3 zombies in a line, not 4', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    p.pos = { x: 25.5, y: 0, z: 40.5 };
    p.weapons = [{ id: 'crossbow', mag: 1, reserve: 10 }];
    const line = [36.5, 34.5, 32.5, 30.5].map((z) => zombieAt(sim, 25.5, z));
    for (const z of line) z.hp = 1;
    run(sim, TICK * 2, { p1: { fire: true, yaw: 0, pitch: -0.02 } });
    expect(sim.state.zombies).toEqual([line[3]]);
  });

  it('the crossbow is a wall buy in the Leader\'s cabin', () => {
    const sim = quiet();
    const wb = map.wallBuys.find((w) => w.weapon === 'crossbow')!;
    sim.state.players[0].pos = placedPos(map, wb);
    expect(sim.interaction('p1')).toMatchObject({ kind: 'wall', weapon: 'crossbow', cost: 1500 });
  });
});

describe('the Morning (Dawn)', () => {
  const sec = map.secret!;

  function collect(sim: Sim, pid: string, spot: number) {
    sim.player(pid)!.pos = placedPos(map, sec.spots[spot]);
    press(sim, pid);
  }

  it('the team brings 3 sun medallions to the altar; then anyone can call Dawn once, which kills every zombie and ends the round', () => {
    const sim = quiet(['p1', 'p2']);
    sim.state.phase = 'active';
    sim.state.round = 7;
    sim.state.toSpawn = 10;
    const [a, b, c] = sim.state.secret.spots;
    collect(sim, 'p1', a);
    collect(sim, 'p1', b);
    collect(sim, 'p2', c);
    expect(sim.state.secret.carried).toEqual({ p1: 2, p2: 1 });
    const altar = placedPos(map, sec.drop);
    sim.player('p1')!.pos = altar;
    expect(sim.interaction('p1')?.label).toBe('Put 2 sun medallions on the altar');
    press(sim, 'p1');
    expect(sim.interaction('p1')).toMatchObject({ kind: 'info', label: 'An altar: 2 of 3 sun medallions' });
    sim.player('p2')!.pos = { ...altar, x: altar.x + 0.5 };
    press(sim, 'p2');
    expect(sim.state.secret.placed).toBe(3);
    expect(sim.interaction('p1')).toMatchObject({ kind: 'dawn' });

    for (const [x, z] of [[25.5, 30.5], [8.5, 35.5], [40.5, 20.5]]) zombieAt(sim, x, z).hp = 1e9;
    const evs = press(sim, 'p2');
    expect(evs).toContainEqual({ type: 'dawn', pid: 'p2' });
    expect(sim.state.zombies).toEqual([]);
    expect(sim.state.toSpawn).toBe(0);
    expect(evs).toContainEqual({ type: 'roundEnd', round: 7 });
    expect(sim.interaction('p1')).toMatchObject({ kind: 'info', label: 'The altar is cold' });
  });

  it('Dawn is not offered before all 3 are on the altar', () => {
    const sim = quiet();
    sim.state.players[0].pos = placedPos(map, sec.drop);
    expect(sim.interaction('p1')).toMatchObject({ kind: 'info', label: 'An altar: 0 of 3 sun medallions' });
  });
});
