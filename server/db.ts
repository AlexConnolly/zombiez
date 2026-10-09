import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

/** The one database call we use. pg's Pool and PGlite share this shape. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

/** Postgres from DATABASE_URL (Neon in production), or an in-process PGlite for dev and tests. */
export async function openDb(url = process.env.DATABASE_URL, dataDir?: string): Promise<Db> {
  let db: Db;
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    db = { query: (sql, params) => pool.query(sql, params) as never, close: () => pool.end() };
  } else {
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    const lite = new PGlite(dataDir);
    db = { query: (sql, params) => lite.query(sql, params) as never, close: () => lite.close() };
  }
  for (const sql of MIGRATIONS) await db.query(sql);
  return db;
}

// ponytail: idempotent CREATE ... IF NOT EXISTS statements; switch to numbered migrations at the first column change.
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username text NOT NULL,
    username_key text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash text PRIMARY KEY,
    family uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rotated boolean NOT NULL DEFAULT false,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_family ON sessions(family)`,
  `CREATE TABLE IF NOT EXISTS recovery_codes (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash text NOT NULL,
    used boolean NOT NULL DEFAULT false
  )`,
  `CREATE TABLE IF NOT EXISTS matches (
    id text PRIMARY KEY,
    map text NOT NULL,
    mode text NOT NULL,
    seed integer NOT NULL,
    region text NOT NULL,
    round_reached integer NOT NULL,
    result text NOT NULL,
    started_at timestamptz NOT NULL,
    ended_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS match_players (
    match_id text NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kills integer NOT NULL,
    headshots integer NOT NULL,
    points_earned integer NOT NULL,
    boards integer NOT NULL,
    PRIMARY KEY (match_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS player_stats (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    map text NOT NULL,
    games integer NOT NULL DEFAULT 0,
    best_round integer NOT NULL DEFAULT 0,
    total_kills integer NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, map)
  )`,
  `CREATE TABLE IF NOT EXISTS daily_scores (
    day date NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    round integer NOT NULL,
    kills integer NOT NULL,
    match_id text NOT NULL,
    PRIMARY KEY (day, user_id)
  )`,
];
