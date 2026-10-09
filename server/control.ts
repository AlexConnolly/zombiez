import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Auth, SESSION_DAYS, type User } from './auth';
import { openDb, type Db } from './db';
import { Lobbies, lobbyView, type Lobby } from './lobbies';
import { matchmake, type Pings, type Ticket } from './matchmaker';
import type { ControlIn, ControlOut, GameToControl } from '../src/net/wire';
import { isMapId } from '../src/maps';

const BODY_LIMIT = 10_000;
const COOKIE = 'zs';

export interface ControlOptions {
  db: Db;
  /** Shared secret game servers present when they register. */
  secret: string;
  /** Browser origins allowed to call the API with cookies. */
  origins: string[];
  secureCookie?: boolean;
  now?: () => number;
}

interface GameServer { ws: WebSocket; region: string; url: string; players: number }
interface Live { id: string; server: GameServer; users: User[]; mode: 'normal' | 'daily'; seed: number; startedAt: Date }

export const dailySeed = (d = new Date()) => [...d.toISOString().slice(0, 10)].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

export async function startControl(port: number, o: ControlOptions) {
  const now = o.now ?? Date.now;
  const auth = await Auth.create(o.db);
  const lobbies = new Lobbies(now);
  const servers = new Set<GameServer>();
  const clients = new Map<string, Set<WebSocket>>();
  const pings = new Map<string, Pings>();
  const queue = new Map<string, Ticket>();
  const live = new Map<string, Live>();
  const userMatch = new Map<string, string>();
  const pendingCreate = new Map<string, () => void>();

  const regions = () => [...new Set([...servers].map((s) => s.region))];
  const push = (userId: string, m: ControlOut) => clients.get(userId)?.forEach((ws) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)));
  const pushLobby = (l: Lobby | null, extra?: string[]) => {
    const view = l ? lobbyView(l, regions()) : null;
    for (const m of l?.members ?? []) push(m.userId, { t: 'lobby', lobby: view });
    for (const id of extra ?? []) push(id, { t: 'lobby', lobby: null });
  };

  async function startMatch(users: User[], region: string, mode: 'normal' | 'daily', map = 'farmhouse'): Promise<string | null> {
    const candidates = [...servers].filter((s) => s.region === region).sort((a, b) => a.players - b.players);
    const server = candidates[0];
    if (!server) return 'No game server in that region right now.';
    const id = randomUUID().slice(0, 8);
    const seed = mode === 'daily' ? dailySeed() : randomUUID().split('-').reduce((h, p) => (h ^ parseInt(p, 16)) | 0, 0);
    const created = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { pendingCreate.delete(id); resolve(false); }, 5000);
      pendingCreate.set(id, () => { clearTimeout(timer); resolve(true); });
    });
    server.ws.send(JSON.stringify({ t: 'create', matchId: id, seed, mode, map, players: users.map((u) => ({ userId: u.id, username: u.username })) }));
    if (!(await created)) return 'The game server did not answer. Try again.';
    live.set(id, { id, server, users, mode, seed, startedAt: new Date(now()) });
    server.players += users.length;
    for (const u of users) {
      userMatch.set(u.id, id);
      push(u.id, { t: 'match', url: server.url, matchId: id, token: await auth.signJoin(u, id) });
    }
    return null;
  }

  async function recordEnd(m: Extract<GameToControl, { t: 'ended' }>) {
    const l = live.get(m.matchId);
    if (!l) return;
    live.delete(m.matchId);
    l.server.players = Math.max(0, l.server.players - l.users.length);
    for (const u of l.users) if (userMatch.get(u.id) === m.matchId) userMatch.delete(u.id);
    const db = o.db;
    await db.query('INSERT INTO matches (id, map, mode, seed, region, round_reached, result, started_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING',
      [l.id, m.map, l.mode, l.seed, l.server.region, m.round, m.result, l.startedAt]);
    for (const u of l.users) {
      const st = m.stats[u.username];
      if (!st) continue;
      await db.query('INSERT INTO match_players (match_id, user_id, kills, headshots, points_earned, boards) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [l.id, u.id, st.kills, st.headshots, st.earned, st.boards]);
      await db.query(`INSERT INTO player_stats (user_id, map, games, best_round, total_kills) VALUES ($1,$2,1,$3,$4)
        ON CONFLICT (user_id, map) DO UPDATE SET games = player_stats.games + 1, best_round = GREATEST(player_stats.best_round, $3), total_kills = player_stats.total_kills + $4`,
        [u.id, m.map, m.round, st.kills]);
      if (l.mode === 'daily' && m.result === 'over')
        await db.query(`INSERT INTO daily_scores (day, user_id, round, kills, match_id) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (day, user_id) DO UPDATE SET round = $3, kills = $4, match_id = $5 WHERE daily_scores.round < $3`,
          [l.startedAt.toISOString().slice(0, 10), u.id, m.round, st.kills, l.id]);
    }
  }

  // ---------------------------------------------------------------- HTTP

  const cookie = (v: string, maxAge: number) =>
    `${COOKIE}=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${o.secureCookie ? '; Secure' : ''}`;
  const readCookie = (req: http.IncomingMessage) =>
    (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE)?.[1] ?? '';
  const ipOf = (req: http.IncomingMessage) => String(req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? '');

  async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > BODY_LIMIT) throw new Error('too big');
      chunks.push(c as Buffer);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return {}; }
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin ?? '';
    if (o.origins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-headers', 'content-type, authorization');
      res.setHeader('vary', 'origin');
    }
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    const send = (status: number, data: unknown, setCookie?: string) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      if (setCookie) res.setHeader('set-cookie', setCookie);
      res.end(JSON.stringify(data));
    };
    const session = (s: { user: User; access: string; refresh: string }, extra: object = {}) =>
      send(200, { user: s.user, access: s.access, ...extra }, cookie(s.refresh, SESSION_DAYS * 86400));
    const user = async () => auth.verifyAccess(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    try {
      if (req.method === 'GET' && path === '/health') return send(200, { ok: true, servers: servers.size, live: live.size });
      if (req.method === 'GET' && path === '/keys') return send(200, { publicKey: auth.pubPem });
      if (req.method === 'GET' && path === '/regions') {
        const byRegion = new Map<string, string>();
        for (const s of servers) byRegion.set(s.region, s.url.replace(/\/ws$/, '') + '/ping');
        return send(200, [...byRegion].map(([region, pingUrl]) => ({ region, pingUrl })));
      }
      if (req.method === 'GET' && path === '/leaderboard') {
        const best = await o.db.query(`SELECT u.username, s.best_round AS round, s.total_kills AS kills FROM player_stats s JOIN users u ON u.id = s.user_id
          WHERE s.map = 'farmhouse' ORDER BY s.best_round DESC, s.total_kills DESC LIMIT 20`);
        const daily = await o.db.query(`SELECT u.username, d.round, d.kills FROM daily_scores d JOIN users u ON u.id = d.user_id
          WHERE d.day = $1 ORDER BY d.round DESC, d.kills DESC LIMIT 20`, [new Date(now()).toISOString().slice(0, 10)]);
        return send(200, { best: best.rows, daily: daily.rows });
      }
      if (req.method !== 'POST' && !(req.method === 'GET' && path === '/me')) return send(404, { error: 'Not found.' });
      const b = req.method === 'POST' ? await body(req) : {};
      const str = (k: string) => String(b[k] ?? '');
      switch (path) {
        case '/auth/signup': {
          const r = await auth.signup(str('username'), str('password'));
          return 'error' in r ? send(400, r) : session(r, { codes: r.codes });
        }
        case '/auth/login': {
          const r = await auth.login(str('username'), str('password'), ipOf(req));
          return 'error' in r ? send(400, r) : session(r);
        }
        case '/auth/refresh': {
          const r = await auth.refresh(readCookie(req));
          return r ? session(r) : send(401, { error: 'Not logged in.' }, cookie('', 0));
        }
        case '/auth/logout':
          await auth.logout(readCookie(req));
          return send(200, {}, cookie('', 0));
        case '/auth/recover': {
          const r = await auth.recover(str('username'), str('code'), str('password'), ipOf(req));
          return 'error' in r ? send(400, r) : session(r);
        }
      }
      const u = await user();
      if (!u) return send(401, { error: 'Not logged in.' });
      switch (path) {
        case '/me': {
          const stats = await o.db.query('SELECT games, best_round, total_kills FROM player_stats WHERE user_id = $1 AND map = $2', [u.id, 'farmhouse']);
          return send(200, { user: u, stats: stats.rows[0] ?? { games: 0, best_round: 0, total_kills: 0 } });
        }
        case '/me/password': {
          const r = await auth.changePassword(u, str('current'), str('password'), readCookie(req));
          return send(r.error ? 400 : 200, r);
        }
        case '/me/codes': {
          const r = await auth.regenerateCodes(u, str('password'));
          return send('error' in r ? 400 : 200, r);
        }
        case '/me/delete': {
          const r = await auth.deleteAccount(u, str('password'));
          return send(r.error ? 400 : 200, r, r.error ? undefined : cookie('', 0));
        }
        case '/rejoin': {
          const id = userMatch.get(u.id);
          const l = id && live.get(id);
          if (!l) return send(200, {});
          return send(200, { url: l.server.url, matchId: l.id, token: await auth.signJoin(u, l.id) });
        }
      }
      return send(404, { error: 'Not found.' });
    } catch (e) {
      return send(500, { error: e instanceof Error && e.message === 'too big' ? 'Request too large.' : 'Server error.' });
    }
  });

  // ---------------------------------------------------------------- WebSockets

  const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 });
  wss.on('connection', (ws, req) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/internal') return gameServerSocket(ws);
    if (path === '/ws') return playerSocket(ws);
    ws.close();
  });

  function gameServerSocket(ws: WebSocket) {
    let gs: GameServer | null = null;
    ws.on('message', (data) => {
      let m: GameToControl;
      try { m = JSON.parse(String(data)); } catch { ws.close(); return; }
      if (!gs) {
        const a = Buffer.from(String(m.t === 'hello' ? m.secret : ''));
        const b = Buffer.from(o.secret);
        if (m.t !== 'hello' || a.length !== b.length || !timingSafeEqual(a, b)) { ws.close(); return; }
        gs = { ws, region: m.region, url: m.url, players: 0 };
        servers.add(gs);
        return;
      }
      if (m.t === 'created') pendingCreate.get(m.matchId)?.();
      if (m.t === 'load') gs.players = m.players;
      if (m.t === 'ended') void recordEnd(m);
    });
    ws.on('close', () => { if (gs) servers.delete(gs); });
  }

  function playerSocket(ws: WebSocket) {
    let u: User | null = null;
    // Handle messages strictly in order: auth is async, and what follows it must wait for it.
    let chain = Promise.resolve();
    ws.on('message', (data) => { chain = chain.then(() => handle(data)).catch(() => ws.close()); });
    const handle = async (data: WebSocket.RawData) => {
      let m: ControlIn;
      try { m = JSON.parse(String(data)); } catch { ws.close(); return; }
      if (!u) {
        if (m.t !== 'auth' || !(u = await auth.verifyAccess(String(m.access)))) { ws.close(); return; }
        const set = clients.get(u.id) ?? new Set();
        set.add(ws);
        clients.set(u.id, set);
        push(u.id, { t: 'lobby', lobby: lobbies.of(u.id) ? lobbyView(lobbies.of(u.id)!, regions()) : null });
        return;
      }
      const me = u;
      const member = () => ({ userId: me.id, username: me.username, pings: pings.get(me.id) ?? {} });
      const err = (reason: string) => push(me.id, { t: 'error', reason });
      switch (m.t) {
        case 'pings':
          if (m.pings && typeof m.pings === 'object') {
            pings.set(me.id, Object.fromEntries(Object.entries(m.pings).filter(([, v]) => typeof v === 'number').slice(0, 10)) as Pings);
            const t = queue.get(me.id);
            if (t) t.pings = pings.get(me.id)!;
            pushLobby(lobbies.update(me.id, (_, mm) => (mm.pings = pings.get(me.id)!)) ?? null);
          }
          return;
        case 'queue':
          lobbies.leave(me.id);
          queue.set(me.id, { userId: me.id, username: me.username, pings: pings.get(me.id) ?? {}, since: now() });
          return;
        case 'unqueue':
          queue.delete(me.id);
          push(me.id, { t: 'queue', status: null });
          return;
        case 'lobby.create':
          queue.delete(me.id);
          pushLobby(lobbies.create(member()));
          return;
        case 'lobby.join': {
          queue.delete(me.id);
          const r = lobbies.join(String(m.code ?? ''), member());
          return typeof r === 'string' ? err(r) : pushLobby(r);
        }
        case 'lobby.leave':
          pushLobby(lobbies.leave(me.id), [me.id]);
          return;
        case 'lobby.ready':
          pushLobby(lobbies.update(me.id, (_, mm) => (mm.ready = !!m.ready)));
          return;
        case 'lobby.mode':
          pushLobby(lobbies.update(me.id, (l, _, host) => { if (host) l.mode = m.mode === 'daily' ? 'daily' : 'normal'; }));
          return;
        case 'lobby.map':
          pushLobby(lobbies.update(me.id, (l, _, host) => { if (host && isMapId(m.map)) l.map = m.map; }));
          return;
        case 'lobby.region':
          pushLobby(lobbies.update(me.id, (l, _, host) => { if (host) l.region = regions().includes(String(m.region)) ? String(m.region) : null; }));
          return;
        case 'lobby.start': {
          const why = lobbies.canStart(me.id);
          if (why) return err(why);
          const l = lobbies.of(me.id)!;
          const view = lobbyView(l, regions());
          if (!view.region) return err('No game server is reachable for this lobby.');
          lobbies.close(l);
          const fail = await startMatch(l.members.map((x) => ({ id: x.userId, username: x.username })), view.region, l.mode, l.map);
          if (fail) l.members.forEach((x) => push(x.userId, { t: 'error', reason: fail }));
          l.members.forEach((x) => push(x.userId, { t: 'lobby', lobby: null }));
          return;
        }
      }
    };
    ws.on('close', () => {
      if (!u) return;
      const set = clients.get(u.id);
      set?.delete(ws);
      if (set && !set.size) {
        clients.delete(u.id);
        queue.delete(u.id);
        pushLobby(lobbies.leave(u.id));
      }
    });
  }

  // Matchmaking pass every second; queue status to everyone waiting.
  const timer = setInterval(async () => {
    const r = matchmake([...queue.values()], regions(), now());
    for (const g of r.groups) {
      g.players.forEach((p) => queue.delete(p.userId));
      const fail = await startMatch(g.players.map((p) => ({ id: p.userId, username: p.username })), g.region, 'normal');
      if (fail) g.players.forEach((p) => push(p.userId, { t: 'error', reason: fail }));
      g.players.forEach((p) => push(p.userId, { t: 'queue', status: null }));
    }
    for (const t of queue.values())
      push(t.userId, { t: 'queue', status: { seconds: Math.floor((now() - t.since) / 1000), waiting: Math.min(queue.size, 4), regions: regions().length } });
    for (const l of lobbies.sweep()) pushLobby(null, l.members.map((m) => m.userId));
  }, 1000);

  return new Promise<{ port: number; auth: Auth; stop: () => void; servers: () => number }>((resolve) => {
    server.listen(port, () => resolve({
      port: (server.address() as { port: number }).port,
      auth,
      servers: () => servers.size,
      stop: () => { clearInterval(timer); wss.close(); server.close(); },
    }));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = await openDb(process.env.DATABASE_URL, process.env.DATABASE_URL ? undefined : '.data/pg');
  const { port } = await startControl(Number(process.env.PORT ?? 8788), {
    db,
    secret: process.env.GAME_SECRET ?? 'dev-secret',
    origins: (process.env.CLIENT_ORIGINS ?? 'http://localhost:5317').split(','),
    secureCookie: process.env.COOKIE_SECURE === '1',
  });
  console.log(`[control] listening on :${port}`);
}
