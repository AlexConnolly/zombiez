// Hosts the whole game from this PC for friends on the internet:
//   :5317 the built web client (dist/), :8788 control service, :8787 game server.
// Settings come from .env (never committed): PUBLIC_HOST, optional DUCKDNS_DOMAIN + DUCKDNS_TOKEN.
// Run with: npm run host
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, normalize } from 'node:path';
import { startControl } from './control';
import { openDb } from './db';
import { startGameServer } from './game';

if (existsSync('.env'))
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }

const host = process.env.PUBLIC_HOST;
if (!host) {
  console.error('Set PUBLIC_HOST in .env, e.g. PUBLIC_HOST=myzombies.duckdns.org');
  process.exit(1);
}

// Static web client. Paths are resolved inside dist/ only.
const DIST = join(process.cwd(), 'dist');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
http.createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^([/\\])+/, '');
  let file = join(DIST, path || 'index.html');
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  res.end(readFileSync(file));
}).listen(5317);

const db = await openDb(process.env.DATABASE_URL, process.env.DATABASE_URL ? undefined : '.data/pg');
const control = await startControl(8788, { db, secret: process.env.GAME_SECRET ?? 'dev-secret', origins: [`http://${host}:5317`, 'http://localhost:5317'] });
await startGameServer(8787, { control: `http://localhost:${control.port}`, secret: process.env.GAME_SECRET ?? 'dev-secret', region: 'local', publicUrl: `ws://${host}:8787/ws` });

// Keep the DuckDNS name pointed at this connection's public IP.
const { DUCKDNS_DOMAIN: domain, DUCKDNS_TOKEN: token } = process.env;
if (domain && token) {
  const update = () => fetch(`https://www.duckdns.org/update?domains=${encodeURIComponent(domain)}&token=${encodeURIComponent(token)}`)
    .then((r) => r.text()).then((t) => console.log(`[duckdns] ${t.trim()}`)).catch((e) => console.log(`[duckdns] ${e}`));
  void update();
  setInterval(update, 5 * 60_000);
}

console.log(`[host] Friends open http://${host}:5317`);
