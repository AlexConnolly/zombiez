// A headless player for testing: joins a game code and walks in circles, firing.
// npx tsx server/bot.ts [match] [name] [server]
import WebSocket from 'ws';
import farmhouse from '../src/maps/farmhouse.json';
import { NetClient } from '../src/net/client';
import type { ServerMsg } from '../src/net/protocol';
import { NO_INPUT } from '../src/sim/game';
import type { MapDef } from '../src/sim/map';

const [match = 'test', name = 'bot', url = 'ws://localhost:8787'] = process.argv.slice(2);
const ws = new WebSocket(url);
const c = new NetClient(farmhouse as MapDef, (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)), () => performance.now());
ws.on('open', () => c.join(match, name));
ws.on('message', (d) => c.receive(JSON.parse(String(d)) as ServerMsg));
ws.on('close', () => process.exit(0));
let t = 0;
setInterval(() => {
  t++;
  c.tick({ ...NO_INPUT, fwd: 1, yaw: t * 0.04, fire: t % 20 < 2 });
  c.frame(1 / 30);
  c.drainEvents();
  if (process.env.WATCH && t % 60 === 0) {
    const s = c.sim.state;
    console.log(`tick ${s.tick} round ${s.round} ${s.phase} zombies ${s.zombies.length} ` + s.players.map((p) => `${p.id}:${p.status}${p.connected ? '' : '(dc)'} hp${Math.round(p.hp)} bleed${p.bleedT.toFixed(1)}`).join(' '));
  }
}, 1000 / 30);
