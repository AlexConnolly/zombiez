import { describe, expect, it } from 'vitest';
import farmhouse from '../maps/farmhouse.json';
import { NO_INPUT, TICK, type Command, type GameEvent, type Zombie } from '../sim/game';
import type { MapDef } from '../sim/map';
import { NetClient } from './client';
import { Match } from './match';
import { encodeSnap, type ClientMsg, type ServerMsg } from './protocol';

const map = farmhouse as MapDef;
const TICK_MS = TICK * 1000;

interface Link { latency: number; jitter: number; loss: number }

/**
 * A virtual-time network: every message is delivered after latency + jitter, in order (like TCP),
 * and a "lost" packet arrives 200 ms late, holding up the ones behind it.
 */
function world(ids: string[], link: Link, seed = 7) {
  let t = 0;
  let r = seed;
  const rand = () => ((r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296);
  const now = () => t;
  const queue: { at: number; n: number; fn: () => void }[] = [];
  let n = 0;
  const pipe = () => {
    let last = 0;
    return (fn: () => void) => {
      let at = t + link.latency + rand() * link.jitter + (rand() < link.loss ? 200 : 0);
      at = Math.max(at, last);
      last = at;
      queue.push({ at, n: n++, fn });
    };
  };
  const match = new Match('m', map, 1, ids, false, now);
  match.sim.state.phaseT = 1e9;
  const clients = new Map<string, NetClient>();
  const strip = new Set<string>();
  for (const id of ids) {
    const up = pipe();
    const down = pipe();
    const c = new NetClient(map, (m: ClientMsg) => {
      const msg: ClientMsg = JSON.parse(JSON.stringify(m));
      if (strip.has(id) && msg.t === 'input') msg.inputs.forEach((i) => delete i.cmd.view);
      up(() => match.receive(id, msg));
    }, now);
    const send = (m: ServerMsg) => { const msg = JSON.parse(JSON.stringify(m)); down(() => c.receive(msg)); };
    match.join(id, send);
    clients.set(id, c);
  }
  const events: GameEvent[] = [];
  let nextServer = 0;
  let nextClient = TICK_MS / 2;
  let nextFrame = 0;
  /** Runs for ms of virtual time. cmd gives each client's command per client tick; frame runs at 60 fps. */
  const run = (ms: number, cmd: (id: string, c: NetClient) => Partial<Command> = () => ({}), onServerTick?: () => void, onFrame?: () => void) => {
    const end = t + ms;
    while (t < end) {
      const nextNet = queue.length ? Math.min(...queue.map((q) => q.at)) : Infinity;
      t = Math.min(nextServer, nextClient, nextFrame, nextNet, end);
      queue.sort((a, b) => a.at - b.at || a.n - b.n);
      while (queue.length && queue[0].at <= t) queue.shift()!.fn();
      if (t >= nextServer) {
        onServerTick?.();
        match.tick();
        nextServer += TICK_MS;
      }
      if (t >= nextClient) {
        for (const [id, c] of clients) c.tick({ ...NO_INPUT, ...cmd(id, c) });
        nextClient += TICK_MS;
      }
      if (t >= nextFrame) {
        for (const c of clients.values()) { c.frame(1 / 60); events.push(...c.drainEvents()); }
        onFrame?.();
        nextFrame += 1000 / 60;
      }
      if (t >= end) break;
    }
  };
  return { match, clients, run, strip, events, now };
}

const typical: Link = { latency: 75, jitter: 20, loss: 0.02 };

describe('prediction and reconciliation', () => {
  it('the predicted position ends where the server says, with no visible snap', () => {
    const w = world(['a', 'b'], typical);
    w.match.sim.player('a')!.pos = { x: 2.5, y: 0, z: 8.5 };
    w.run(500);
    w.clients.get('a')!.maxCorrection = 0;
    w.run(2000, (id) => (id === 'a' ? { fwd: 1, yaw: -Math.PI / 2 } : {}));
    w.run(1000, () => ({ yaw: -Math.PI / 2 }));
    const server = w.match.sim.player('a')!.pos;
    const local = w.clients.get('a')!.predicted()!;
    expect(Math.hypot(server.x - local.x, server.z - local.z)).toBeLessThan(0.01);
    expect(w.clients.get('a')!.maxCorrection).toBeLessThan(0.05);
  });

  it('own movement responds on the same tick, before the server hears of it', () => {
    const w = world(['a'], { latency: 150, jitter: 0, loss: 0 });
    w.run(500);
    const c = w.clients.get('a')!;
    const x0 = c.predicted()!.x;
    w.run(TICK_MS + 1, () => ({ fwd: 1, yaw: -Math.PI / 2 }));
    expect(c.predicted()!.x).toBeGreaterThan(x0 + 0.1);
    expect(w.match.sim.player('a')!.pos.x).toBeCloseTo(x0, 5);
  });
});

describe('interpolation', () => {
  it('other players move smoothly at 2% loss and 20 ms jitter', () => {
    const w = world(['a', 'b'], typical);
    w.match.sim.player('a')!.pos = { x: 2.5, y: 0, z: 8.5 };
    w.run(500);
    let last: { x: number; z: number } | null = null;
    let worst = 0;
    w.run(2000, (id) => (id === 'a' ? { fwd: 1, yaw: -Math.PI / 2 } : {}), undefined, () => {
      const seen = w.clients.get('b')!.sim.player('a')!.pos;
      if (last) worst = Math.max(worst, Math.hypot(seen.x - last.x, seen.z - last.z));
      last = { ...seen };
    });
    // Walking is 4.5 m/s = 0.075 m per 60 fps frame. Allow 3x for interpolation catching up after a late packet.
    expect(worst).toBeLessThan(0.075 * 3);
  });
});

describe('lag compensation', () => {
  /** A zombie strafes past at 3 m/s, 5 m in front of the player; the client fires at where it sees the head. */
  function shootMovingZombie(link: Link, stripView = false) {
    const w = world(['a'], link);
    if (stripView) w.strip.add('a');
    const p = w.match.sim.player('a')!;
    p.pos = { x: 10.5, y: 0, z: 13.5 };
    const z = w.match.sim.spawnZombie('W3') as Zombie;
    z.state = 'tear';
    z.pos = { x: 8, y: 0, z: 8.5 };
    z.hp = 10;
    const move = () => { if (w.match.sim.state.zombies.includes(z)) z.pos.x += 3 * TICK; };
    w.run(800, () => ({}), move);
    const c = w.clients.get('a')!;
    c.frame(0);
    const seen = c.sim.state.zombies.find((o) => o.id === z.id)!.pos;
    const eye = { x: 10.5, y: 1.6, z: 13.5 };
    const dx = seen.x - eye.x, dz = seen.z - eye.z;
    const aim = { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(seen.y + 1.1 - eye.y, Math.hypot(dx, dz)) };
    let fired = false;
    w.run(TICK_MS, () => (fired ? aim : ((fired = true), { ...aim, fire: true })), move);
    w.run(1000, () => aim, move);
    return w.events.some((e) => e.type === 'kill');
  }

  it('at 150 ms round trip, aiming at what you see hits', () => {
    expect(shootMovingZombie({ latency: 75, jitter: 0, loss: 0 })).toBe(true);
  });
  it('without lag compensation the same shot misses', () => {
    expect(shootMovingZombie({ latency: 75, jitter: 0, loss: 0 }, true)).toBe(false);
  });
  it('rewind is capped: at 600 ms round trip the shot misses', () => {
    expect(shootMovingZombie({ latency: 300, jitter: 0, loss: 0 })).toBe(false);
  });
});

describe('server authority', () => {
  it('out-of-range inputs are clamped, so speed hacks do nothing', () => {
    const w = world(['a'], { latency: 10, jitter: 0, loss: 0 });
    w.match.sim.player('a')!.pos = { x: 2.5, y: 0, z: 8.5 };
    w.run(300);
    const x0 = w.match.sim.player('a')!.pos.x;
    w.run(1000, () => ({ fwd: 50, yaw: -Math.PI / 2 }));
    expect(w.match.sim.player('a')!.pos.x - x0).toBeLessThan(4.6);
    expect(w.match.sim.player('a')!.pos.x - x0).toBeGreaterThan(4);
  });
  it('sending inputs 3x faster than 30 Hz does not move the player faster', () => {
    const w = world(['a'], { latency: 10, jitter: 0, loss: 0 });
    w.match.sim.player('a')!.pos = { x: 2.5, y: 0, z: 8.5 };
    w.run(300);
    const x0 = w.match.sim.player('a')!.pos.x;
    let seq = 1e6;
    for (let t = 0; t < 30; t++) {
      const inputs = [0, 1, 2].map(() => ({ seq: seq++, cmd: { ...NO_INPUT, fwd: 1, yaw: -Math.PI / 2 } }));
      w.match.receive('a', { t: 'input', inputs });
      w.match.tick();
    }
    // 30 ticks of walking is 4.5 m, plus at most the 10 saved-up inputs. A 3x speed hack would be 13.5 m.
    expect(w.match.sim.player('a')!.pos.x - x0).toBeLessThan(40 * 4.5 * TICK + 1e-6);
  });
  it('inputs that arrive late after a stall are caught up', () => {
    const w = world(['a'], { latency: 10, jitter: 0, loss: 0 });
    w.match.sim.player('a')!.pos = { x: 2.5, y: 0, z: 8.5 };
    w.run(300);
    const x0 = w.match.sim.player('a')!.pos.x;
    for (let t = 0; t < 6; t++) w.match.tick();
    const inputs = Array.from({ length: 6 }, (_, i) => ({ seq: 1e6 + i, cmd: { ...NO_INPUT, fwd: 1, yaw: -Math.PI / 2 } }));
    w.match.receive('a', { t: 'input', inputs });
    w.match.tick();
    w.match.tick();
    expect(w.match.sim.player('a')!.pos.x - x0).toBeCloseTo(6 * 4.5 * TICK, 5);
  });
});

describe('reconnect', () => {
  it('a dropped player reconnects to the same character', () => {
    const w = world(['a', 'b'], typical);
    w.run(500);
    w.match.sim.player('a')!.points = 1234;
    w.match.drop('a');
    expect(w.match.sim.player('a')!.connected).toBe(false);
    const c = new NetClient(map, (m) => w.match.receive('a', m), w.now);
    expect(w.match.join('a', (m) => c.receive(JSON.parse(JSON.stringify(m))))).toBe(true);
    expect(c.me()!.points).toBe(1234);
    expect(w.match.sim.player('a')!.connected).toBe(true);
  });
  it('a player who left can not rejoin', () => {
    const w = world(['a', 'b'], typical);
    w.match.receive('a', { t: 'leave' });
    expect(w.match.join('a', () => {})).toBe(false);
  });
});

describe('bandwidth', () => {
  it('a full snapshot with 24 zombies and 4 players is under 6 KB of JSON', () => {
    const m = new Match('m', map, 1, ['a', 'b', 'c', 'd']);
    for (let i = 0; i < 24; i++) m.sim.spawnZombie();
    const size = JSON.stringify(encodeSnap(m.sim.state, map, 0, [])).length;
    expect(size).toBeLessThan(6000);
  });
});
