import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { importSPKI, type CryptoKey } from 'jose';
import WebSocket, { WebSocketServer } from 'ws';
import { mapById } from '../src/maps';
import { TICK } from '../src/sim/game';
import { Match } from '../src/net/match';
import type { ClientMsg, ServerMsg } from '../src/net/protocol';
import type { ControlToGame, GameToControl } from '../src/net/wire';
import { verifyJoin } from './auth';

const map = mapById('farmhouse');

export interface GameOptions {
  region?: string;
  /** Control service base URL (http...). Without it the server runs open dev matches: anyone joins any code by name. */
  control?: string;
  secret?: string;
  /** The ws:// or wss:// address players use to reach this server. */
  publicUrl?: string;
}

/** Starts a game server. Resolves with the bound port (tests pass 0) and a stop function. */
export function startGameServer(port: number, o: GameOptions = {}) {
  const region = o.region ?? 'local';
  const matches = new Map<string, Match>();
  const reported = new Set<string>();
  let control: WebSocket | null = null;
  let pub: CryptoKey | null = null;
  let stopped = false;
  const toControl = (m: GameToControl) => { if (control?.readyState === WebSocket.OPEN) control.send(JSON.stringify(m)); };

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ region, matches: matches.size, players: [...matches.values()].reduce((n, m) => n + m.connected(), 0) }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

  wss.on('connection', (ws, req) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/ping') {
      // Region ping for matchmaking: echo straight back.
      ws.on('message', (d) => ws.send(d));
      return;
    }
    let pid = '';
    let match: Match | null = null;
    let joining = false;
    const send = (m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };

    ws.on('message', async (data) => {
      let msg: ClientMsg;
      try { msg = JSON.parse(String(data)); } catch { ws.close(); return; }
      if (match) {
        match.receive(pid, msg);
        if (msg.t === 'leave') ws.close();
        return;
      }
      if (joining || msg?.t !== 'join' || typeof msg.match !== 'string' || typeof msg.token !== 'string') { if (!joining) ws.close(); return; }
      joining = true;
      let m: Match | undefined;
      if (o.control) {
        const ticket = pub && (await verifyJoin(msg.token, pub));
        m = ticket && ticket.match === msg.match ? matches.get(msg.match) : undefined;
        pid = ticket ? ticket.username : '';
      } else {
        // Dev: the token is the player's name and matches open on demand.
        pid = msg.token.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'player';
        const id = msg.match.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'dev';
        m = matches.get(id);
        if (!m || m.ended) { m = new Match(id, map, (Math.random() * 2 ** 31) | 0, [], true); matches.set(id, m); }
      }
      if (!m || !m.join(pid, send, msg.v)) { send({ t: 'error', reason: 'not in match' }); ws.close(); return; }
      match = m;
    });
    ws.on('close', () => match?.drop(pid, send));
  });

  async function connectControl() {
    if (!o.control || stopped) return;
    try {
      if (!pub) pub = await importSPKI(((await (await fetch(`${o.control}/keys`)).json()) as { publicKey: string }).publicKey, 'EdDSA');
    } catch { setTimeout(connectControl, 2000); return; }
    const ws = new WebSocket(o.control.replace(/^http/, 'ws') + '/internal');
    control = ws;
    ws.on('open', () => {
      toControl({ t: 'hello', secret: o.secret ?? '', region, url: o.publicUrl ?? `ws://localhost:${port}/ws` });
    });
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as ControlToGame;
      if (m.t === 'create' && !matches.has(m.matchId)) {
        matches.set(m.matchId, new Match(m.matchId, mapById(m.map), m.seed, m.players.map((p) => p.username)));
        toControl({ t: 'created', matchId: m.matchId });
      }
    });
    ws.on('close', () => { if (!stopped) setTimeout(connectControl, 2000); });
    ws.on('error', () => {});
  }

  // Fixed 30 Hz for every match on this machine. The accumulator means timer drift never skips or doubles a tick.
  let last = performance.now();
  let acc = 0;
  let loadAt = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    acc = Math.min(acc + now - last, 250);
    last = now;
    while (acc >= TICK * 1000) {
      acc -= TICK * 1000;
      for (const [id, m] of matches) {
        m.tick();
        if (m.ended && !reported.has(id)) {
          reported.add(id);
          const s = m.sim.state;
          toControl({
            t: 'ended', matchId: id, map: m.map.id, round: s.round,
            result: s.players.some((p) => p.connected) ? 'over' : 'abandoned',
            stats: Object.fromEntries(s.players.map((p) => [p.id, p.stats])),
          });
        }
        if (m.ended && m.connected() === 0) { matches.delete(id); reported.delete(id); }
      }
    }
    if (now - loadAt > 5000) {
      loadAt = now;
      toControl({ t: 'load', matches: matches.size, players: [...matches.values()].reduce((n, m) => n + m.connected(), 0) });
    }
  }, 4);

  return new Promise<{ port: number; matches: Map<string, Match>; stop: () => void }>((resolve) => {
    server.listen(port, () => {
      port = (server.address() as { port: number }).port;
      void connectControl();
      resolve({ port, matches, stop: () => { stopped = true; clearInterval(timer); control?.close(); wss.close(); server.close(); } });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  startGameServer(Number(process.env.PORT ?? 8787), {
    region: process.env.REGION,
    control: process.env.CONTROL_URL,
    secret: process.env.GAME_SECRET ?? 'dev-secret',
    publicUrl: process.env.PUBLIC_URL,
  }).then(({ port }) => console.log(`[game] ${process.env.REGION ?? 'local'} listening on :${port}${process.env.CONTROL_URL ? ` (control ${process.env.CONTROL_URL})` : ' (open dev matches)'}`));
