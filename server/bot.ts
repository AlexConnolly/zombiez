// A headless player for testing.
//   npx tsx server/bot.ts --lobby CODE   sign up, join that lobby, ready up, play when it starts
//   npx tsx server/bot.ts --quick        sign up and Quick Play
//   npx tsx server/bot.ts --dev MATCH    open dev match on a game server with no control service
// Options: --control http://localhost:8788  --game ws://localhost:8787/ws  --name NAME  --watch
import WebSocket from 'ws';
import farmhouse from '../src/maps/farmhouse.json';
import { NetClient } from '../src/net/client';
import type { ServerMsg } from '../src/net/protocol';
import type { ControlOut } from '../src/net/wire';
import { NO_INPUT } from '../src/sim/game';
import type { MapDef } from '../src/sim/map';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1] ?? ''; };
const control = arg('control') ?? 'http://localhost:8788';
const name = arg('name') ?? `bot${Math.floor(Math.random() * 1e5)}`;
const watch = process.argv.includes('--watch');

function play(url: string, match: string, token: string) {
  const ws = new WebSocket(url);
  const c = new NetClient(farmhouse as MapDef, (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)), () => performance.now());
  ws.on('open', () => c.join(match, token));
  ws.on('message', (d) => c.receive(JSON.parse(String(d)) as ServerMsg));
  ws.on('close', () => process.exit(0));
  let t = 0;
  setInterval(() => {
    t++;
    c.tick({ ...NO_INPUT, fwd: 1, yaw: t * 0.04, fire: t % 20 < 2 });
    c.frame(1 / 30);
    c.drainEvents();
    if (c.error) { console.log(`[${name}] refused: ${c.error}`); process.exit(1); }
    if (watch && t % 60 === 0) {
      const s = c.sim.state;
      console.log(`tick ${s.tick} round ${s.round} ${s.phase} zombies ${s.zombies.length} ` + s.players.map((p) => `${p.id}:${p.status}${p.connected ? '' : '(dc)'}`).join(' '));
    }
  }, 1000 / 30);
}

if (arg('dev') !== undefined) {
  play(arg('game') ?? 'ws://localhost:8787/ws', arg('dev') || 'test', name);
} else {
  const r = await fetch(`${control}/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'bot password 12345' }) });
  const s = (await r.json()) as { access?: string; error?: string };
  if (!s.access) { console.log(`[${name}] sign-up failed: ${s.error}`); process.exit(1); }
  const ws = new WebSocket(control.replace(/^http/, 'ws') + '/ws');
  const send = (m: object) => ws.send(JSON.stringify(m));
  ws.on('open', () => {
    send({ t: 'auth', access: s.access });
    send({ t: 'pings', pings: { local: 1, lhr: 20 } });
    if (arg('lobby')) send({ t: 'lobby.join', code: arg('lobby') });
    else send({ t: 'queue' });
  });
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as ControlOut;
    if (m.t === 'lobby' && m.lobby && !m.lobby.members.find((x) => x.username === name)?.ready) send({ t: 'lobby.ready', ready: true });
    if (m.t === 'error') console.log(`[${name}] ${m.reason}`);
    if (m.t === 'match') { console.log(`[${name}] joining match ${m.matchId}`); play(m.url, m.matchId, m.token); }
  });
  console.log(`[${name}] signed up, ${arg('lobby') ? `joining lobby ${arg('lobby')}` : 'in Quick Play'}`);
}
