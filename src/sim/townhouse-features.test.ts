import { describe, expect, it } from 'vitest';
import townhouse from '../maps/townhouse.json';
import { NO_INPUT, Sim, TICK, zombieHp, type Command, type GameEvent } from './game';
import { placedPos, windowGeom, type MapDef } from './map';

const map = townhouse as MapDef;

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

/** A hunting zombie parked at a spot, frozen there by giving it nobody to chase. */
function zombieAt(sim: Sim, x: number, y: number, z: number) {
  const zb = sim.spawnZombie('frontDoor');
  zb.state = 'hunt';
  zb.pos = { x, y, z };
  return zb;
}

describe('gas cooker trap', () => {
  const trap = map.traps![0];

  it('1 s after lighting, every zombie in the basement dies; the rest of the house is spared', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    p.pos = placedPos(map, trap);
    const down = [zombieAt(sim, 6.5, -3, 16.5), zombieAt(sim, 3.5, -3, 4.5)];
    const up = zombieAt(sim, 7.5, 0, 15.5);
    const evs = press(sim);
    expect(evs).toContainEqual({ type: 'trap', id: 'gas', fire: false });
    expect(p.points).toBe(1e5 - 1000);
    p.pos = { x: 6.5, y: 0, z: 4.5 };
    for (const z of [...down, up]) z.hp = 1e9;
    run(sim, 0.8);
    expect(sim.state.zombies).toHaveLength(3);
    const fire = run(sim, 0.3);
    expect(fire).toContainEqual({ type: 'trap', id: 'gas', fire: true });
    expect(sim.state.zombies).toEqual([up]);
  });

  it('players still in the basement take 50 damage', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    p.pos = placedPos(map, trap);
    press(sim);
    run(sim, 1.1);
    expect(p.hp).toBe(50);
  });

  it('cools down for 60 s', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    p.pos = placedPos(map, trap);
    press(sim);
    run(sim, 30);
    expect(sim.interaction('p1')?.kind).toBe('info');
    press(sim);
    expect(p.points).toBe(1e5 - 1000);
    run(sim, 30);
    expect(sim.interaction('p1')).toMatchObject({ kind: 'trap', cost: 1000 });
  });
});

describe('banister slide', () => {
  it('at the top of a flight, Use slides the player to the bottom in 0.6 s', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    p.pos = { x: 3.5, y: 3, z: 13.5 };
    expect(sim.interaction('p1')).toMatchObject({ kind: 'slide' });
    press(sim);
    expect(p.slide).not.toBeNull();
    run(sim, 0.6);
    expect(p.slide).toBeNull();
    expect(p.pos.z).toBeCloseTo(19.5, 1);
    expect(p.pos.y).toBeLessThan(0.6);
    run(sim, 0.5);
    expect(p.pos.y).toBeLessThan(0.4);
    expect(p.pos.y).toBeGreaterThan(0);
  });

  it('no slide while the door at the top is shut', () => {
    const sim = quiet();
    sim.state.doors.first = false;
    sim.world.update(sim.state.doors, sim.state.box.spot);
    sim.state.players[0].pos = { x: 3.5, y: 3, z: 12.5 };
    expect(sim.interaction('p1')?.kind).not.toBe('slide');
  });
});

describe('front door', () => {
  it('has 8 boards: 12 s to tear down, and rebuilds to 8', () => {
    const sim = quiet();
    const w = map.windows.find((x) => x.id === 'frontDoor')!;
    expect(sim.state.windows.frontDoor.boards).toBe(8);
    const z = sim.spawnZombie('frontDoor');
    z.pos = { ...windowGeom(map, w).outside };
    z.leg = windowGeom(map, w).path.length - 1;
    run(sim, 11.9);
    expect(sim.state.windows.frontDoor.boards).toBe(1);
    run(sim, 0.2);
    expect(sim.state.windows.frontDoor.boards).toBe(0);
    sim.state.zombies = [];
    sim.state.players[0].pos = { ...windowGeom(map, w).inside };
    run(sim, 8, { p1: { use: true } });
    expect(sim.state.windows.frontDoor.boards).toBe(8);
  });
});

describe('dumbwaiter', () => {
  const link = map.links![0];

  it('250 refills the ammo of a teammate at the other end', () => {
    const sim = quiet(['a', 'b']);
    const [a, b] = sim.state.players;
    a.pos = placedPos(map, link.a);
    b.pos = placedPos(map, link.b);
    b.weapons[0].reserve = 0;
    expect(sim.interaction('a')).toMatchObject({ kind: 'link', cost: 250 });
    press(sim, 'a');
    expect(b.weapons[0].reserve).toBe(80);
    expect(a.points).toBe(1e5 - 250);
  });

  it('works both ways, and costs nothing with nobody at the other end', () => {
    const sim = quiet(['a', 'b']);
    const [a, b] = sim.state.players;
    a.pos = placedPos(map, link.b);
    b.pos = { x: 6.5, y: 0, z: 4.5 };
    const evs = press(sim, 'a');
    expect(evs).toContainEqual({ type: 'denied', pid: 'a' });
    expect(a.points).toBe(1e5);
    b.pos = placedPos(map, link.a);
    b.weapons[0].reserve = 3;
    press(sim, 'a');
    expect(b.weapons[0].reserve).toBe(80);
  });
});

describe('cricket bat', () => {
  const buy = map.wallBuys.find((w) => w.weapon === 'cricketBat')!;
  const swing = (sim: Sim) => run(sim, TICK * 2, { p1: { melee: true, yaw: 0 } });

  it('is bought on the wall for 1500 and replaces the knife', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    p.pos = placedPos(map, buy);
    expect(sim.interaction('p1')).toMatchObject({ kind: 'melee', melee: 'cricketBat', cost: 1500 });
    press(sim);
    expect(p.melee).toBe('cricketBat');
    expect(p.points).toBe(1e5 - 1500);
    expect(sim.interaction('p1')?.kind).not.toBe('melee');
  });

  it('hits 3x as hard as the knife: one hit kills a round 4 zombie', () => {
    for (const [melee, dead] of [['knife', false], ['cricketBat', true]] as const) {
      const sim = quiet();
      const p = sim.state.players[0];
      p.pos = { x: 6.5, y: 0, z: 6.5 };
      p.melee = melee;
      const z = zombieAt(sim, 6.5, 0, 5.3);
      z.hp = zombieHp(4);
      swing(sim);
      expect(sim.state.zombies.includes(z)).toBe(!dead);
    }
  });

  it('swings wider and further than the knife', () => {
    for (const [melee, hit] of [['knife', false], ['cricketBat', true]] as const) {
      const sim = quiet();
      const p = sim.state.players[0];
      p.pos = { x: 6.5, y: 0, z: 6.5 };
      p.melee = melee;
      // 1.9 m away, 60 degrees off the aim.
      const z = zombieAt(sim, 6.5 - Math.sin(Math.PI / 3) * 1.9, 0, 6.5 - Math.cos(Math.PI / 3) * 1.9);
      z.hp = 1;
      swing(sim);
      expect(sim.state.zombies.includes(z)).toBe(!hit);
    }
  });

  it('a player who bleeds out loses it', () => {
    const sim = quiet(['a', 'b']);
    const a = sim.player('a')!;
    a.melee = 'cricketBat';
    (sim as unknown as { hurtPlayer(p: unknown, d: number): void }).hurtPlayer(a, 1e6);
    run(sim, 31);
    sim.state.phase = 'break';
    sim.state.phaseT = TICK;
    run(sim, TICK * 2);
    expect(a.melee).toBe('knife');
  });
});

describe("the Lodger's secret", () => {
  const sec = map.secret!;
  const spotsOf = (seed: number) => new Sim(map, seed).state.secret.spots;

  it('hides 3 ration books in different spots, chosen by the seed', () => {
    expect(spotsOf(5)).toEqual(spotsOf(5));
    expect(new Set(spotsOf(5)).size).toBe(3);
    const seen = new Set(Array.from({ length: 20 }, (_, i) => spotsOf(i).join()));
    expect(seen.size).toBeGreaterThan(5);
  });

  it('books are picked up with Use and put in the coal vault; then each player takes one box weapon (never the Zapper)', () => {
    const sim = quiet(['a', 'b']);
    const [a, b] = sim.state.players;
    const vault = placedPos(map, sec.drop);
    for (const i of [...sim.state.secret.spots]) {
      a.pos = placedPos(map, sec.spots[i]);
      expect(sim.interaction('a')).toMatchObject({ kind: 'secret', spot: i });
      press(sim, 'a');
    }
    expect(sim.state.secret.spots).toEqual([]);
    expect(sim.state.secret.carried.a).toBe(3);
    a.pos = vault;
    expect(sim.interaction('a')?.label).toMatch(/3 ration books/);
    press(sim, 'a');
    expect(sim.state.secret.placed).toBe(3);
    const offers = new Set<string>();
    for (let t = 0; t < 30 / TICK; t++) {
      sim.step({});
      const it = sim.interaction('a');
      if (it?.kind === 'shelter' && it.weapon) offers.add(it.weapon);
    }
    expect(offers.has('zapper')).toBe(false);
    expect(offers.size).toBe(5);
    const it = sim.interaction('a');
    press(sim, 'a');
    expect(a.weapons.map((w) => w.id)).toContain(it?.kind === 'shelter' && it.weapon);
    expect(sim.interaction('a')?.kind).toBe('info');
    b.pos = vault;
    expect(sim.interaction('b')).toMatchObject({ kind: 'shelter' });
  });

  it('the hatch stays shut until every book is in', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    p.pos = placedPos(map, sec.spots[sim.state.secret.spots[0]]);
    press(sim);
    p.pos = placedPos(map, sec.drop);
    press(sim);
    expect(sim.state.secret.placed).toBe(1);
    expect(sim.interaction('p1')).toMatchObject({ kind: 'info', label: expect.stringMatching(/1 of 3/) });
  });
});

