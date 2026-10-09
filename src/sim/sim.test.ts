import { describe, expect, it } from 'vitest';
import farmhouse from '../maps/farmhouse.json';
import { NO_INPUT, Sim, TICK, zombieCount, zombieHp, type Command, type GameEvent } from './game';
import { validateMap, windowGeom, type MapDef } from './map';

const map = farmhouse as MapDef;

/** A sim held in the pre-round break so tests control every zombie. */
function quiet(seed = 1) {
  const sim = new Sim(map, seed);
  sim.state.phaseT = 1e9;
  return sim;
}

function run(sim: Sim, seconds: number, cmd: Partial<Command> = {}): GameEvent[] {
  const evs: GameEvent[] = [];
  for (let i = 0; i < Math.round(seconds / TICK); i++) evs.push(...sim.step({ p1: { ...NO_INPUT, ...cmd } }));
  return evs;
}

const win = (id: string) => map.windows.find((w) => w.id === id)!;

describe('round scaling', () => {
  it('zombie HP grows by 100 to round 9, then 10% a round', () => {
    expect(zombieHp(1)).toBe(150);
    expect(zombieHp(9)).toBe(950);
    expect(zombieHp(10)).toBe(1045);
  });
  it('zombie count is capped at 24 for one player, +6 per extra player', () => {
    expect(zombieCount(1)).toBe(8);
    expect(zombieCount(20)).toBe(24);
    expect(zombieCount(1, 3)).toBe(20);
  });
  it('round 1 starts after the 3 s break and spawns zombies', () => {
    const sim = new Sim(map, 1);
    const evs = run(sim, 5);
    expect(evs).toContainEqual({ type: 'roundStart', round: 1 });
    expect(sim.state.zombies.length).toBeGreaterThan(0);
  });
});

describe('points', () => {
  const setup = () => {
    const sim = quiet();
    const z = sim.spawnZombie('W1');
    return { sim, z, p: sim.state.players[0] };
  };
  it('non-lethal hit = 10', () => {
    const { sim, z, p } = setup();
    sim.hurtZombie(z, 10, p, 'body');
    expect(p.points).toBe(510);
  });
  it('kill = 60, headshot kill = 100, knife kill = 130', () => {
    for (const [kind, pts] of [['body', 60], ['head', 100], ['knife', 130]] as const) {
      const { sim, z, p } = setup();
      sim.hurtZombie(z, 1000, p, kind);
      expect(p.points).toBe(500 + pts);
      expect(sim.state.zombies).toHaveLength(0);
    }
  });
  it('rebuilding boards pays 10 each, capped at 50 per round', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    sim.state.windows.W1.boards = 0;
    p.pos = { ...windowGeom(map, win('W1')).inside };
    run(sim, 6, { use: true });
    expect(sim.state.windows.W1.boards).toBe(6);
    expect(p.points).toBe(550);
  });
});

describe('barricades', () => {
  it('a zombie tears one board per 1.5 s, then climbs in and hunts', () => {
    const sim = quiet();
    const z = sim.spawnZombie('W1');
    z.pos = { ...windowGeom(map, win('W1')).outside };
    run(sim, 1.6);
    expect(sim.state.windows.W1.boards).toBe(5);
    run(sim, 7.5);
    expect(sim.state.windows.W1.boards).toBe(0);
    run(sim, 1.5);
    expect(z.state).toBe('hunt');
  });
  it('a player rebuilds one board per 0.75 s', () => {
    const sim = quiet();
    sim.state.windows.W1.boards = 0;
    sim.state.players[0].pos = { ...windowGeom(map, win('W1')).inside };
    run(sim, 0.8, { use: true });
    expect(sim.state.windows.W1.boards).toBe(1);
    run(sim, 1.5, { use: true });
    expect(sim.state.windows.W1.boards).toBe(3);
  });
});

describe('doors', () => {
  const atDoor = () => {
    const sim = quiet();
    sim.state.players[0].pos = { x: 10.5, y: 0, z: 8.5 };
    return sim;
  };
  it('refuses when the player is too poor', () => {
    const sim = atDoor();
    const evs = run(sim, 0.1, { use: true });
    expect(evs.some((e) => e.type === 'denied')).toBe(true);
    expect(sim.state.doors.stairs).toBe(false);
  });
  it('takes the cost, opens the zone, and its windows start spawning', () => {
    const sim = atDoor();
    const p = sim.state.players[0];
    p.points = 2000;
    run(sim, 0.1, { use: true });
    expect(sim.state.doors.stairs).toBe(true);
    expect(p.points).toBe(1250);
    expect(sim.state.zones.B).toBe(true);
    expect(sim.activeWindows().map((w) => w.id)).toEqual(['W1', 'W2', 'W3', 'W4', 'W5']);
  });
});

describe('mystery box', () => {
  const atBox = (seed: number) => {
    const sim = quiet(seed);
    const p = sim.state.players[0];
    p.pos = { x: 6.5, y: 3, z: 5.5 };
    p.points = 1e6;
    return sim;
  };
  it('the same seed gives the same weapon', () => {
    const roll = (seed: number) => {
      const sim = atBox(seed);
      run(sim, 0.1, { use: true });
      run(sim, 4);
      return sim.state.box.weapon;
    };
    expect(roll(7)).toBe(roll(7));
    expect(roll(7)).not.toBeNull();
  });
  it('moves after its use count and refunds the last roll', () => {
    const sim = atBox(3);
    const moveAt = sim.state.box.moveAt;
    let uses = 0;
    for (; uses < 20; uses++) {
      run(sim, 0.1, { use: true });
      const evs = run(sim, 4.1);
      if (evs.some((e) => e.type === 'boxMove')) break;
      run(sim, 8.1);
    }
    expect(uses + 1).toBe(moveAt);
    // Only zone A is open, so the box can only move to the ground-floor spot.
    expect(map.boxSpots[sim.state.box.spot].zone).toBe('A');
    expect(sim.state.players[0].points).toBe(1e6 - 950 * (moveAt - 1));
  });
});

describe('power-ups', () => {
  it('at most 4 drop in a round', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    let drops = 0;
    for (let i = 0; i < 1000; i++) {
      const z = sim.spawnZombie('W1');
      sim.events = [];
      sim.hurtZombie(z, 1e6, p, 'body');
      drops += sim.events.filter((e) => e.type === 'powerupDrop').length;
    }
    expect(drops).toBe(4);
  });
  it('double points doubles for 30 s', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    sim.applyPowerup(1, 'doublePoints');
    sim.award(p, 10);
    expect(p.points).toBe(520);
    run(sim, 30.1);
    sim.award(p, 10);
    expect(p.points).toBe(530);
  });
  it('insta-kill kills in one hit', () => {
    const sim = quiet();
    const z = sim.spawnZombie('W1');
    sim.applyPowerup(1, 'instaKill');
    sim.hurtZombie(z, 1, sim.state.players[0], 'body');
    expect(sim.state.zombies).toHaveLength(0);
  });
  it('max ammo refills reserves; nuke clears zombies and pays 400', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    p.weapons[0].reserve = 0;
    sim.spawnZombie('W1');
    sim.spawnZombie('W2');
    sim.applyPowerup(1, 'maxAmmo');
    sim.applyPowerup(2, 'nuke');
    expect(p.weapons[0].reserve).toBe(80);
    expect(sim.state.zombies).toHaveLength(0);
    expect(p.points).toBe(900);
  });
  it('a player walking over a drop picks it up', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    sim.drop({ ...p.pos }, 'doublePoints');
    const evs = run(sim, 0.1);
    expect(evs).toContainEqual(expect.objectContaining({ type: 'powerup', kind: 'doublePoints' }));
  });
});

describe('pathfinding', () => {
  const setup = () => {
    const sim = quiet();
    const p = sim.state.players[0];
    p.pos = { x: 4.5, y: 3, z: 9.5 };
    p.hp = 1e9;
    p.maxHp = 1e9;
    const z = sim.spawnZombie('W3');
    z.state = 'hunt';
    z.pos = { x: 8.5, y: 0, z: 12.5 };
    return { sim, p, z };
  };
  it('has no path upstairs while the door is closed', () => {
    const { sim, z } = setup();
    run(sim, 3);
    expect(z.pos.y).toBeLessThan(1);
  });
  it('reaches the player upstairs through the opened door', () => {
    const { sim, p, z } = setup();
    sim.state.doors.stairs = true;
    sim.world.update(sim.state.doors, 0);
    let reached = false;
    for (let t = 0; t < 30 && !reached; t += 0.5) {
      run(sim, 0.5, { yaw: 0 });
      reached = Math.hypot(z.pos.x - p.pos.x, z.pos.z - p.pos.z) < 1.5 && Math.abs(z.pos.y - p.pos.y) < 0.5;
    }
    expect(reached).toBe(true);
  });
  it('reaches the player in the cellar', () => {
    const { sim, p, z } = setup();
    p.pos = { x: 8.5, y: -3, z: 6.5 };
    sim.state.doors.cellar = true;
    sim.world.update(sim.state.doors, 0);
    let reached = false;
    for (let t = 0; t < 30 && !reached; t += 0.5) {
      run(sim, 0.5);
      reached = Math.hypot(z.pos.x - p.pos.x, z.pos.z - p.pos.z) < 1.5 && Math.abs(z.pos.y - p.pos.y) < 0.5;
    }
    expect(reached).toBe(true);
  });
});

describe('movement', () => {
  it('the player walks up the stairs to the upper floor once the door is open', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    sim.state.doors.stairs = true;
    sim.world.update(sim.state.doors, 0);
    p.pos = { x: 11, y: 0, z: 8.5 };
    run(sim, 2.5, { fwd: 1 });
    expect(p.pos.y).toBeCloseTo(3, 1);
    expect(p.pos.z).toBeLessThan(3);
  });
  it('a closed door blocks the player', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    p.pos = { x: 11, y: 0, z: 8.5 };
    run(sim, 2, { fwd: 1 });
    expect(p.pos.z).toBeGreaterThan(7.9);
  });
  it('shooting a zombie in the head pays a headshot kill', () => {
    const sim = quiet();
    const p = sim.state.players[0];
    p.pos = { x: 8.5, y: 0, z: 12.5 };
    const z = sim.spawnZombie('W3');
    z.state = 'hunt';
    z.hp = 40;
    z.pos = { x: 8.5, y: 0, z: 8.5 };
    z.run = false;
    // Look straight north (yaw 0), pitched to the head 4 m away.
    const pitch = Math.atan2(1.62 - 1.6, 4);
    run(sim, 0.05, { yaw: 0, pitch, fire: true });
    expect(sim.state.zombies).toHaveLength(0);
    expect(p.points).toBe(600);
  });
});

describe('input', () => {
  it('a missing command keeps the player aim', () => {
    const sim = quiet();
    run(sim, 0.1, { yaw: 1.2, pitch: 0.3 });
    sim.step({});
    expect(sim.state.players[0].yaw).toBe(1.2);
    expect(sim.state.players[0].pitch).toBe(0.3);
  });
});

describe('snapshots', () => {
  it('a sim restored from a state snapshot plays on identically', () => {
    const a = new Sim(map, 9);
    const cmd = (t: number): Command => ({ ...NO_INPUT, yaw: t * 0.02, fire: t % 15 < 2, fwd: Math.sin(t / 40) });
    for (let t = 0; t < 900; t++) a.step({ p1: cmd(t) });
    const b = new Sim(map, 9);
    Object.assign(b.state, JSON.parse(JSON.stringify(a.state)));
    b.world.update(b.state.doors, b.state.box.spot);
    for (let t = 900; t < 1800; t++) { a.step({ p1: cmd(t) }); b.step({ p1: cmd(t) }); }
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
  });
});

describe('map validator', () => {
  it('accepts The Farmhouse', () => {
    expect(validateMap(map)).toEqual([]);
  });
  it('rejects a window on a wall tile and stairs with no exit', () => {
    const bad: MapDef = JSON.parse(JSON.stringify(map));
    bad.windows[0].cells[0] = [2, 1];
    bad.floors[2].tiles[2] = ' #........##.#';
    const errs = validateMap(bad);
    expect(errs.some((e) => e.includes('window W1'))).toBe(true);
    expect(errs.some((e) => e.includes('exit'))).toBe(true);
  });
});

describe('determinism', () => {
  function play(seed: number) {
    const sim = new Sim(map, seed);
    sim.state.players[0].hp = 1e9;
    sim.state.players[0].maxHp = 1e9;
    for (let t = 0; t < 5 * 60 * 30; t++) {
      const c: Command = { ...NO_INPUT, yaw: t * 0.01, fire: t % 20 < 2, reload: t % 300 === 0, fwd: Math.sin(t / 50), strafe: Math.cos(t / 70) };
      sim.step({ p1: c });
    }
    return JSON.stringify(sim.state);
  }
  it('same seed + same commands = same state after 5 minutes', () => {
    const a = play(42);
    expect(play(42)).toBe(a);
    expect(play(43)).not.toBe(a);
  });
});
