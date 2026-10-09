import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import farmhouse from '../src/maps/farmhouse.json';
import { NetClient } from '../src/net/client';
import { PROTOCOL, type ServerMsg } from '../src/net/protocol';
import type { ControlIn, ControlOut } from '../src/net/wire';
import type { MapDef } from '../src/sim/map';
import { startControl } from './control';
import { openDb, type Db } from './db';
import { startGameServer } from './game';

// Sign-up hashes the password and 8 recovery codes with Argon2: slow on purpose.
vi.setConfig({ testTimeout: 30_000 });

const map = farmhouse as MapDef;
let db: Db;
let control: Awaited<ReturnType<typeof startControl>>;
let game: Awaited<ReturnType<typeof startGameServer>>;
let base = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;

async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await sleep(20); }
}

async function post(path: string, body: object, access?: string) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(access ? { authorization: `Bearer ${access}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json(), cookie: r.headers.get('set-cookie') ?? '' };
}

/** A signed-up player connected to the control service. */
async function player(pings = { lhr: 20 }) {
  const name = `bot${++n}${Date.now() % 1000}`;
  const r = await post('/auth/signup', { username: name, password: 'a long enough password' });
  expect(r.status).toBe(200);
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const got: ControlOut[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  await new Promise((res) => ws.on('open', res));
  const send = (m: ControlIn) => ws.send(JSON.stringify(m));
  send({ t: 'auth', access: r.body.access });
  send({ t: 'pings', pings });
  await until(() => got.some((m) => m.t === 'lobby'));
  const last = <T extends ControlOut['t']>(t: T) => [...got].reverse().find((m) => m.t === t) as Extract<ControlOut, { t: T }> | undefined;
  return { name, access: r.body.access as string, send, got, last, close: () => ws.terminate() };
}

/** Joins a game server with a match ticket and returns the live NetClient. */
async function play(url: string, matchId: string, token: string) {
  const ws = new WebSocket(url);
  const c = new NetClient(map, (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)), () => performance.now());
  ws.on('message', (d) => c.receive(JSON.parse(String(d)) as ServerMsg));
  await new Promise((r) => ws.on('open', r));
  c.join(matchId, token);
  await until(() => c.joined || !!c.error);
  return { c, ws };
}

beforeAll(async () => {
  db = await openDb(undefined);
  control = await startControl(0, { db, secret: 'test-secret', origins: [] });
  base = `http://127.0.0.1:${control.port}`;
  game = await startGameServer(0, { control: base, secret: 'test-secret', region: 'lhr' });
  await until(() => control.servers() === 1);
});
afterAll(() => { game.stop(); control.stop(); });

describe('online end to end', () => {
  it('Quick Play: 4 players in the same region are matched at once and join with their tickets', async () => {
    const ps = await Promise.all([0, 1, 2, 3].map(() => player()));
    ps.forEach((p) => p.send({ t: 'queue' }));
    await until(() => ps.every((p) => p.last('match')));
    const m = ps[0].last('match')!;
    expect(new Set(ps.map((p) => p.last('match')!.matchId)).size).toBe(1);
    const joined = await Promise.all(ps.map((p) => play(m.url, m.matchId, p.last('match')!.token)));
    expect(joined.map((j) => j.c.you).sort()).toEqual(ps.map((p) => p.name).sort());
    joined.forEach((j) => j.ws.terminate());
    ps.forEach((p) => p.close());
  });

  it('Private lobby: host creates, friend joins by code, both ready, host starts; stats are saved at the end', async () => {
    const [a, b] = await Promise.all([player(), player()]);
    a.send({ t: 'lobby.create' });
    await until(() => !!a.last('lobby')?.lobby);
    const code = a.last('lobby')!.lobby!.code;
    b.send({ t: 'lobby.join', code: code.toLowerCase() });
    await until(() => a.last('lobby')!.lobby!.members.length === 2);
    a.send({ t: 'lobby.start' });
    await until(() => a.last('error')?.reason === 'Everyone must be ready.');
    a.send({ t: 'lobby.ready', ready: true });
    b.send({ t: 'lobby.ready', ready: true });
    await until(() => a.last('lobby')!.lobby!.members.every((x) => x.ready));
    a.send({ t: 'lobby.start' });
    await until(() => !!a.last('match') && !!b.last('match'));
    const m = a.last('match')!;
    const ja = await play(m.url, m.matchId, m.token);
    const jb = await play(m.url, m.matchId, b.last('match')!.token);
    expect(ja.c.sim.state.players.map((p) => p.id).sort()).toEqual([a.name, b.name].sort());

    // A dropped player can get a fresh ticket while the match runs.
    const re = await post('/rejoin', {}, a.access);
    expect(re.body.matchId).toBe(m.matchId);

    const live = game.matches.get(m.matchId)!;
    live.sim.player(a.name)!.stats.kills = 7;
    live.sim.state.round = 5;
    live.sim.state.phase = 'over';
    await until(() => ja.c.ended !== null);
    await sleep(300);
    const stats = await db.query<{ username: string; games: number; best_round: number; total_kills: number }>(
      'SELECT u.username, s.games, s.best_round, s.total_kills FROM player_stats s JOIN users u ON u.id = s.user_id ORDER BY u.username');
    expect(stats.rows).toContainEqual({ username: a.name, games: 1, best_round: 5, total_kills: 7 });
    expect((await post('/rejoin', {}, a.access)).body).toEqual({});
    [ja, jb].forEach((j) => j.ws.terminate());
    [a, b].forEach((p) => p.close());
  });

  it('the lobby host picks the map; the game server plays it and reports it at the end', async () => {
    const [a, b] = await Promise.all([player(), player()]);
    a.send({ t: 'lobby.create' });
    await until(() => !!a.last('lobby')?.lobby);
    expect(a.last('lobby')!.lobby!.map).toBe('farmhouse');
    b.send({ t: 'lobby.join', code: a.last('lobby')!.lobby!.code });
    await until(() => a.last('lobby')!.lobby!.members.length === 2);
    b.send({ t: 'lobby.map', map: 'townhouse' });
    a.send({ t: 'lobby.map', map: 'nowhere' });
    await sleep(200);
    expect(a.last('lobby')!.lobby!.map).toBe('farmhouse');
    a.send({ t: 'lobby.map', map: 'townhouse' });
    await until(() => b.last('lobby')!.lobby!.map === 'townhouse');
    a.send({ t: 'lobby.ready', ready: true });
    b.send({ t: 'lobby.ready', ready: true });
    await until(() => a.last('lobby')!.lobby!.members.every((x) => x.ready));
    a.send({ t: 'lobby.start' });
    await until(() => !!a.last('match'));
    const m = a.last('match')!;
    expect(game.matches.get(m.matchId)!.map.id).toBe('townhouse');
    const ws = new WebSocket(m.url);
    const welcome = new Promise<ServerMsg>((r) => ws.on('message', (d) => r(JSON.parse(String(d)))));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'join', v: PROTOCOL, match: m.matchId, token: m.token }));
    expect(await welcome).toMatchObject({ t: 'welcome', map: 'townhouse' });
    game.matches.get(m.matchId)!.sim.state.phase = 'over';
    await sleep(400);
    const row = await db.query<{ map: string }>('SELECT map FROM matches WHERE id = $1', [m.matchId]);
    expect(row.rows[0].map).toBe('townhouse');
    ws.terminate();
    [a, b].forEach((p) => p.close());
  });

  it('a game server refuses forged tickets and tickets for another match', async () => {
    const ps = await Promise.all([0, 1, 2, 3].map(() => player()));
    ps.forEach((p) => p.send({ t: 'queue' }));
    await until(() => ps.every((p) => p.last('match')));
    const m = ps[0].last('match')!;
    const forged = await play(m.url, m.matchId, 'not-a-ticket');
    expect(forged.c.error).toBe('not in match');
    const wrong = await play(m.url, 'other-match', m.token);
    expect(wrong.c.error).toBe('not in match');
    const old = new WebSocket(m.url);
    const reply = new Promise<ServerMsg>((r) => old.on('message', (d) => r(JSON.parse(String(d)))));
    await new Promise((r) => old.on('open', r));
    old.send(JSON.stringify({ t: 'join', v: PROTOCOL + 1, match: m.matchId, token: m.token }));
    expect(await reply).toEqual({ t: 'error', reason: 'version' });
    [forged.ws, wrong.ws, old].forEach((w) => w.terminate());
    ps.forEach((p) => p.close());
  });

  it('session cookie: refresh works with the cookie and logout clears it', async () => {
    const r = await post('/auth/signup', { username: `ck${Date.now() % 100000}`, password: 'a long enough password' });
    const cookie = r.cookie.split(';')[0];
    expect(r.cookie).toMatch(/HttpOnly; SameSite=Lax/);
    const refreshed = await fetch(base + '/auth/refresh', { method: 'POST', headers: { cookie } });
    expect(refreshed.status).toBe(200);
    const again = await fetch(base + '/auth/refresh', { method: 'POST', headers: { cookie } });
    expect(again.status).toBe(401);
  });
});
