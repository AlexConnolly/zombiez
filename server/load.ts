// Load check: N matches x 4 players stepped in one process, like one game-server machine.
// npx tsx server/load.ts [matches] [seconds]
import farmhouse from '../src/maps/farmhouse.json';
import { Match } from '../src/net/match';
import { NO_INPUT } from '../src/sim/game';
import type { MapDef } from '../src/sim/map';

const [n = 50, secs = 20] = process.argv.slice(2).map(Number);
const ids = ['a', 'b', 'c', 'd'];
let bytes = 0;
const matches = Array.from({ length: n }, (_, i) => {
  const m = new Match(`m${i}`, farmhouse as MapDef, i + 1, ids);
  for (const id of ids) m.join(id, (msg) => { bytes += JSON.stringify(msg).length; });
  for (const p of m.sim.state.players) { p.hp = 1e9; p.maxHp = 1e9; }
  return m;
});
const times: number[] = [];
let seq = 0;
for (let t = 0; t < secs * 30; t++) {
  seq++;
  for (const m of matches)
    for (const [k, id] of ids.entries())
      m.receive(id, { t: 'input', inputs: [{ seq, cmd: { ...NO_INPUT, fwd: 1, yaw: t * 0.03 + k, fire: t % 15 === 0 } }] });
  const t0 = performance.now();
  for (const m of matches) m.tick();
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const at = (q: number) => times[Math.floor(times.length * q)].toFixed(2);
const zombies = matches.reduce((s, m) => s + m.sim.state.zombies.length, 0);
console.log(`${n} matches, ${n * 4} players, ${zombies} zombies alive at end (round ${matches[0].sim.state.round})`);
console.log(`tick for all matches: p50 ${at(0.5)} ms, p99 ${at(0.99)} ms, max ${times.at(-1)!.toFixed(2)} ms (budget 33 ms; spec p99 < 10 ms)`);
console.log(`outgoing: ${(bytes / secs / 1024 / (n * 4)).toFixed(1)} KB/s per player`);
