// Local online stack in one process: control service on :8788 (PGlite in .data/pg) and one game server on :8787.
// PUBLIC_HOST=your.ip.or.name makes it reachable for friends (the address players' browsers use).
import { startControl } from './control';
import { openDb } from './db';
import { startGameServer } from './game';

const db = await openDb(process.env.DATABASE_URL, process.env.DATABASE_URL ? undefined : '.data/pg');
const host = process.env.PUBLIC_HOST ?? 'localhost';
const control = await startControl(8788, { db, secret: 'dev-secret', origins: ['http://localhost:5317', 'http://127.0.0.1:5317', `http://${host}:5317`] });
await startGameServer(8787, { control: `http://localhost:${control.port}`, secret: 'dev-secret', region: 'local', publicUrl: `ws://${host}:8787/ws` });
console.log(`[dev] control :8788, game server :8787. Open http://${host}:5317 and choose Multiplayer.`);
