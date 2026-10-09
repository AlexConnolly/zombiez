import { describe, expect, it } from 'vitest';
import farmhouse from '../maps/farmhouse.json';
import { NO_INPUT, Sim, TICK, zombieCount, zombieHp, type Command, type GameEvent } from './game';
import type { MapDef } from './map';

const map = farmhouse as MapDef;

function coop(n: number) {
  const sim = new Sim(map, 1, ['a', 'b', 'c', 'd'].slice(0, n));
  sim.state.phaseT = 1e9;
  return sim;
}

function run(sim: Sim, seconds: number, cmds: Record<string, Partial<Command>> = {}): GameEvent[] {
  const evs: GameEvent[] = [];
  for (let i = 0; i < Math.round(seconds / TICK); i++)
    evs.push(...sim.step(Object.fromEntries(sim.state.players.map((p) => [p.id, { ...NO_INPUT, ...cmds[p.id] }]))));
  return evs;
}

const knock = (sim: Sim, id: string) => (sim as unknown as { hurtPlayer(p: unknown, d: number): void }).hurtPlayer(sim.player(id), 1e6);
const startRound = (sim: Sim) => { sim.state.phase = 'break'; sim.state.phaseT = TICK; run(sim, TICK * 2); sim.state.phaseT = 1e9; };

describe('downs and game over', () => {
  it('solo: going down ends the game at once', () => {
    const sim = coop(1);
    knock(sim, 'a');
    run(sim, TICK);
    expect(sim.state.phase).toBe('over');
  });

  it('co-op: a downed player bleeds out after 30 s while others play on', () => {
    const sim = coop(2);
    knock(sim, 'a');
    run(sim, 29);
    expect(sim.player('a')!.status).toBe('down');
    run(sim, 1.1);
    expect(sim.player('a')!.status).toBe('dead');
    expect(sim.state.phase).not.toBe('over');
  });

  it('game over when the last standing player goes down', () => {
    const sim = coop(2);
    knock(sim, 'a');
    knock(sim, 'b');
    run(sim, TICK);
    expect(sim.state.phase).toBe('over');
  });

  it('a bled-out player respawns next round with the P9 and at least 500 points', () => {
    const sim = coop(2);
    const a = sim.player('a')!;
    a.points = 120;
    a.weapons = [{ id: 'ripper', mag: 30, reserve: 180 }];
    a.perks = ['tough'];
    knock(sim, 'a');
    run(sim, 31);
    startRound(sim);
    expect(a.status).toBe('alive');
    expect(a.weapons.map((w) => w.id)).toEqual(['p9']);
    expect(a.points).toBe(500);
    expect(a.perks).toEqual([]);
  });
});

describe('revive', () => {
  const setup = () => {
    const sim = coop(2);
    sim.player('b')!.pos = { ...sim.player('a')!.pos, x: sim.player('a')!.pos.x + 1 };
    knock(sim, 'a');
    return sim;
  };
  it('holding Use for 3 s revives at 50 HP and pays the reviver 100', () => {
    const sim = setup();
    expect(sim.interaction('b')?.kind).toBe('revive');
    run(sim, 2.9, { b: { use: true } });
    expect(sim.player('a')!.status).toBe('down');
    run(sim, 0.2, { b: { use: true } });
    expect(sim.player('a')!.status).toBe('alive');
    expect(sim.player('a')!.hp).toBe(50);
    expect(sim.player('b')!.points).toBe(600);
  });
  it('letting go restarts the timer', () => {
    const sim = setup();
    run(sim, 2, { b: { use: true } });
    run(sim, 0.1);
    run(sim, 2, { b: { use: true } });
    expect(sim.player('a')!.status).toBe('down');
  });
  it('Quick Hands halves revive time', () => {
    const sim = setup();
    sim.player('b')!.perks = ['quick'];
    run(sim, 1.6, { b: { use: true } });
    expect(sim.player('a')!.status).toBe('alive');
  });
});

describe('zombie targeting', () => {
  it('zombies ignore downed and disconnected players', () => {
    const sim = coop(3);
    const [a, b, c] = sim.state.players;
    a.pos = { x: 8.5, y: 0, z: 12.5 };
    b.pos = { x: 4.5, y: 0, z: 4.5 };
    c.pos = { x: 10.5, y: 0, z: 13.5 };
    knock(sim, 'a');
    sim.disconnect('c');
    const z = sim.spawnZombie('W3');
    z.state = 'hunt';
    z.pos = { x: 9.5, y: 0, z: 12.5 };
    const before = Math.hypot(z.pos.x - b.pos.x, z.pos.z - b.pos.z);
    run(sim, 2);
    expect(Math.hypot(z.pos.x - b.pos.x, z.pos.z - b.pos.z)).toBeLessThan(before - 1.5);
  });
});

describe('disconnects', () => {
  it('reconnecting inside 60 s resumes in place with everything kept', () => {
    const sim = coop(2);
    const a = sim.player('a')!;
    a.weapons.push({ id: 'ripper', mag: 30, reserve: 180 });
    a.perks = ['tough'];
    const pos = { ...a.pos };
    sim.disconnect('a');
    run(sim, 59);
    expect(sim.connect('a')).toBe(true);
    expect(a.status).toBe('alive');
    expect(a.perks).toEqual(['tough']);
    expect(a.pos).toEqual(pos);
  });
  it('after 60 s the player is away; back later, they respawn next round with weapons, no perks', () => {
    const sim = coop(2);
    const a = sim.player('a')!;
    a.weapons.push({ id: 'ripper', mag: 30, reserve: 180 });
    a.perks = ['tough'];
    sim.disconnect('a');
    run(sim, 60.1);
    expect(a.status).toBe('away');
    sim.connect('a');
    startRound(sim);
    expect(a.status).toBe('alive');
    expect(a.weapons.map((w) => w.id)).toEqual(['p9', 'ripper']);
    expect(a.perks).toEqual([]);
  });
  it('a disconnected downed player does not bleed out during the grace period', () => {
    const sim = coop(2);
    knock(sim, 'a');
    sim.disconnect('a');
    run(sim, 40);
    sim.connect('a');
    expect(sim.player('a')!.status).toBe('down');
  });
  it('last connected player goes down while a teammate is in grace: they bleed out normally', () => {
    const sim = coop(2);
    sim.disconnect('b');
    knock(sim, 'a');
    run(sim, 1);
    expect(sim.state.phase).not.toBe('over');
    run(sim, 30);
    expect(sim.player('a')!.status).toBe('dead');
    run(sim, 30);
    expect(sim.state.phase).toBe('over');
  });
  it('with nobody connected the world freezes, then ends after 60 s', () => {
    const sim = coop(2);
    const z = sim.spawnZombie('W1');
    const pos = { ...z.pos };
    sim.disconnect('a');
    sim.disconnect('b');
    run(sim, 30);
    expect(z.pos).toEqual(pos);
    expect(sim.state.phase).not.toBe('over');
    run(sim, 31);
    expect(sim.state.phase).toBe('over');
  });
  it('after everyone else leaves, the last player plays on with solo rules', () => {
    const sim = coop(3);
    sim.leave('b');
    sim.leave('c');
    run(sim, 1);
    expect(sim.state.phase).not.toBe('over');
    knock(sim, 'a');
    run(sim, TICK);
    expect(sim.state.phase).toBe('over');
  });
  it('a leaving player can not reconnect', () => {
    const sim = coop(2);
    sim.leave('a');
    expect(sim.connect('a')).toBe(false);
  });
});

describe('scaling', () => {
  it('zombie count and HP scale with connected players', () => {
    const sim = coop(3);
    startRound(sim);
    expect(sim.state.toSpawn).toBe(zombieCount(1, 3));
    expect(sim.spawnZombie('W1').hp).toBe(Math.round(zombieHp(1) * 1.25));
  });
  it('a player leaving mid-round removes 6 zombies from the rest of the round', () => {
    const sim = coop(3);
    startRound(sim);
    const left = sim.state.toSpawn;
    sim.leave('c');
    expect(sim.state.toSpawn).toBe(left - 6);
  });
});
