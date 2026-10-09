import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import farmhouse from '../src/maps/farmhouse.json';
import { TICK } from '../src/sim/game';
import type { MapDef } from '../src/sim/map';
import { Match } from '../src/net/match';
import type { ClientMsg, ServerMsg } from '../src/net/protocol';

const REGION = process.env.REGION ?? 'local';
const map = farmhouse as MapDef;

/** Starts a game server. Resolves with the bound port (tests pass 0) and a stop function. */
export function startGameServer(port: number) {
  const matches = new Map<string, Match>();

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ region: REGION, matches: matches.size, players: [...matches.values()].reduce((n, m) => n + m.connected(), 0) }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

  wss.on('connection', (ws: WebSocket, req) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/ping') {
      // Region ping for matchmaking: echo straight back.
      ws.on('message', (d) => ws.send(d));
      return;
    }
    let pid = '';
    let match: Match | null = null;
    const send = (m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };

    ws.on('message', (data) => {
      let msg: ClientMsg;
      try { msg = JSON.parse(String(data)); } catch { ws.close(); return; }
      if (!match) {
        if (msg?.t !== 'join' || typeof msg.match !== 'string' || typeof msg.token !== 'string') { ws.close(); return; }
        // ponytail: dev joining, the token is the player's name and matches open on demand. N5 swaps in signed join tokens.
        const name = msg.token.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'player';
        const id = msg.match.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'dev';
        let m = matches.get(id);
        if (!m || m.ended) {
          m = new Match(id, map, (Math.random() * 2 ** 31) | 0, [], true);
          matches.set(id, m);
        }
        if (!m.join(name, send, msg.v)) { ws.close(); return; }
        match = m;
        pid = name;
        return;
      }
      match.receive(pid, msg);
      if (msg.t === 'leave') ws.close();
    });
    ws.on('close', () => match?.drop(pid, send));
  });

  // Fixed 30 Hz for every match on this machine. The accumulator means timer drift never skips or doubles a tick.
  let last = performance.now();
  let acc = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    acc = Math.min(acc + now - last, 250);
    last = now;
    while (acc >= TICK * 1000) {
      acc -= TICK * 1000;
      for (const [id, m] of matches) {
        m.tick();
        if (m.ended && m.connected() === 0) matches.delete(id);
      }
    }
  }, 4);

  return new Promise<{ port: number; matches: Map<string, Match>; stop: () => void }>((resolve) => {
    server.listen(port, () => {
      const bound = (server.address() as { port: number }).port;
      resolve({ port: bound, matches, stop: () => { clearInterval(timer); wss.close(); server.close(); } });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  startGameServer(Number(process.env.PORT ?? 8787)).then(({ port }) => console.log(`[game] ${REGION} listening on :${port}`));
