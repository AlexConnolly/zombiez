import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import farmhouse from '../src/maps/farmhouse.json';
import { NetClient } from '../src/net/client';
import { PROTOCOL, type ServerMsg } from '../src/net/protocol';
import { NO_INPUT } from '../src/sim/game';
import type { MapDef } from '../src/sim/map';
import { startGameServer } from './game';

const map = farmhouse as MapDef;
let srv: Awaited<ReturnType<typeof startGameServer>>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A headless player: a real WebSocket driving a NetClient at 30 Hz. */
function bot(name: string, match = 'it') {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  const c = new NetClient(map, (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)), () => performance.now());
  ws.on('message', (d) => c.receive(JSON.parse(String(d)) as ServerMsg));
  const opened = new Promise<void>((r) => ws.on('open', () => { c.join(match, name); r(); }));
  let cmd = { ...NO_INPUT };
  const timer = setInterval(() => { c.tick(cmd); c.frame(1 / 30); }, 1000 / 30);
  return {
    c, ws, opened,
    set(next: Partial<typeof cmd>) { cmd = { ...NO_INPUT, ...next }; },
    close() { clearInterval(timer); ws.terminate(); },
  };
}

beforeAll(async () => { srv = await startGameServer(0); });
afterAll(() => srv.stop());

describe('game server over real sockets', () => {
  it('two players join, see each other, and the server moves them', async () => {
    const a = bot('alice');
    const b = bot('bob');
    await Promise.all([a.opened, b.opened]);
    await sleep(400);
    expect(a.c.you).toBe('alice');
    expect(b.c.sim.player('alice')).toBeTruthy();
    const m = srv.matches.get('it')!;
    m.sim.state.phaseT = 1e9;
    m.sim.player('alice')!.pos = { x: 2.5, y: 0, z: 8.5 };
    await sleep(300);
    a.set({ fwd: 1, yaw: -Math.PI / 2 });
    await sleep(1000);
    a.set({ yaw: -Math.PI / 2 });
    await sleep(400);
    const server = m.sim.player('alice')!.pos;
    expect(server.x).toBeGreaterThan(5);
    expect(Math.abs(a.c.predicted()!.x - server.x)).toBeLessThan(0.05);
    expect(Math.abs(b.c.sim.player('alice')!.pos.x - server.x)).toBeLessThan(0.2);
    a.close();
    b.close();
  });

  it('a dropped socket keeps the player for the grace period, and they can reconnect', async () => {
    const a = bot('carol', 'rc');
    const b = bot('dave', 'rc');
    await Promise.all([a.opened, b.opened]);
    await sleep(300);
    a.close();
    await sleep(300);
    expect(b.c.sim.player('carol')!.connected).toBe(false);
    const again = bot('carol', 'rc');
    await again.opened;
    await sleep(300);
    expect(again.c.me()!.connected).toBe(true);
    expect(b.c.sim.player('carol')!.connected).toBe(true);
    again.close();
    b.close();
  });

  it('refuses a client with the wrong protocol version', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    const got = new Promise<ServerMsg>((r) => ws.on('message', (d) => r(JSON.parse(String(d)))));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'join', v: PROTOCOL + 1, match: 'v', token: 'eve' }));
    expect(await got).toEqual({ t: 'error', reason: 'version' });
    ws.terminate();
  });

  it('answers region pings', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ping`);
    await new Promise((r) => ws.on('open', r));
    const t = performance.now();
    const echo = new Promise((r) => ws.on('message', r));
    ws.send('x');
    await echo;
    expect(performance.now() - t).toBeLessThan(50);
    ws.terminate();
  });
});
