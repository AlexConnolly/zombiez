import { hash, verify } from '@node-rs/argon2';
import { exportSPKI, generateKeyPair, importPKCS8, importSPKI, jwtVerify, SignJWT, type CryptoKey } from 'jose';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { Db } from './db';

export const USERNAME = /^[A-Za-z0-9_]{3,16}$/;
const ACCESS_TTL = '15m';
export const SESSION_DAYS = 30;
const CODE_COUNT = 8;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// ponytail: a short list of the most common passwords; swap for a 100k breached-password list file if sign-ups show weak passwords getting through.
const COMMON = new Set(
  ('123456 123456789 12345678 password qwerty123 qwerty 1234567890 1234567 111111 123123 abc123 password1 1234 iloveyou ' +
    '1q2w3e4r 000000 qwertyuiop 123321 dragon monkey letmein football baseball sunshine princess welcome admin master ' +
    'shadow superman batman trustno1 passw0rd starwars whatever freedom michael charlie jordan23 hello123 login ' +
    'zaq12wsx qazwsx 654321 7777777 555555 666666 121212 password123 password12 1qaz2wsx asdfghjkl asdfgh zxcvbnm ' +
    'computer hunter2 killer pokemon soccer hockey jennifer mustang buster harley ranger thomas tigger robert ' +
    'daniel andrew joshua matthew access flower hottie loveme cheese summer winter internet google samsung ' +
    'minecraft fortnite zombies zombie callofduty playstation xbox360 nintendo liverpool chelsea arsenal ' +
    'qwerty12345 1234qwer aa123456 a123456 abcd1234 iloveyou1 princess1 football1 baseball1 welcome1 ' +
    'changeme default secret letmein1 trustno11 0987654321 987654321 11111111 22222222 88888888 12341234 ' +
    'qwertyui 1qazxsw2 q1w2e3r4 q1w2e3r4t5 password! p@ssw0rd p@ssword passw0rd1 superstar').split(' '),
);
const BANNED = ['fuck', 'shit', 'cunt', 'nigg', 'fag', 'rape', 'nazi', 'hitler', 'whore', 'slut', 'retard'];

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');

export function usernameProblem(name: string): string | null {
  if (!USERNAME.test(name)) return 'Username must be 3-16 letters, numbers or _.';
  if (BANNED.some((b) => name.toLowerCase().includes(b))) return 'Pick a different username.';
  return null;
}

export function passwordProblem(pw: string, username: string): string | null {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (COMMON.has(pw.toLowerCase())) return 'That password is too common. Pick another.';
  if (pw.toLowerCase().includes(username.toLowerCase())) return 'Password must not contain your username.';
  return null;
}

function recoveryCode() {
  const pick = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  return `${pick()}-${pick()}`;
}

/** Counts failures in a 1-minute window; after 5, each extra failure doubles the lockout (max 15 min). */
export class Limiter {
  private hits = new Map<string, { n: number; start: number; until: number }>();
  constructor(private now: () => number = Date.now) {}
  blocked(key: string) {
    const h = this.hits.get(key);
    return !!h && h.until > this.now();
  }
  fail(key: string) {
    const t = this.now();
    let h = this.hits.get(key);
    if (!h || t - h.start > 60_000) h = { n: 0, start: t, until: 0 };
    h.n++;
    if (h.n >= 5) h.until = t + Math.min(15 * 60_000, 1000 * 2 ** (h.n - 5) * 5);
    this.hits.set(key, h);
  }
  clear(key: string) { this.hits.delete(key); }
}

export type User = { id: string; username: string };
export type Session = { user: User; access: string; refresh: string };

export class Auth {
  readonly limiter: Limiter;
  private dummy = hash('not-a-real-password-just-for-timing');

  private constructor(private db: Db, private priv: CryptoKey, readonly pub: CryptoKey, readonly pubPem: string, now?: () => number) {
    this.limiter = new Limiter(now);
  }

  /** Keys from JWT_PRIVATE_KEY / JWT_PUBLIC_KEY (PEM) or, in dev, a fresh pair per process. */
  static async create(db: Db, now?: () => number) {
    let priv: CryptoKey, pub: CryptoKey;
    if (process.env.JWT_PRIVATE_KEY && process.env.JWT_PUBLIC_KEY) {
      priv = await importPKCS8(process.env.JWT_PRIVATE_KEY, 'EdDSA');
      pub = await importSPKI(process.env.JWT_PUBLIC_KEY, 'EdDSA');
    } else {
      ({ privateKey: priv, publicKey: pub } = await generateKeyPair('EdDSA', { extractable: true }));
    }
    return new Auth(db, priv, pub, await exportSPKI(pub), now);
  }

  private async session(user: User, family: string = randomUUID()): Promise<Session> {
    const refresh = token();
    await this.db.query(`INSERT INTO sessions (token_hash, family, user_id, expires_at) VALUES ($1, $2, $3, now() + interval '${SESSION_DAYS} days')`, [sha(refresh), family, user.id]);
    const access = await new SignJWT({ name: user.username }).setProtectedHeader({ alg: 'EdDSA' }).setSubject(user.id).setAudience('control').setIssuedAt().setExpirationTime(ACCESS_TTL).sign(this.priv);
    return { user, access, refresh };
  }

  private async newCodes(userId: string) {
    const codes = Array.from({ length: CODE_COUNT }, recoveryCode);
    await this.db.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
    for (const c of codes) await this.db.query('INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, await hash(c)]);
    return codes;
  }

  async signup(username: string, password: string): Promise<{ error: string } | (Session & { codes: string[] })> {
    const bad = usernameProblem(username) ?? passwordProblem(password, username);
    if (bad) return { error: bad };
    const taken = await this.db.query('SELECT 1 FROM users WHERE username_key = $1', [username.toLowerCase()]);
    if (taken.rows.length) return { error: 'That username is taken.' };
    const { rows } = await this.db.query<{ id: string }>('INSERT INTO users (username, username_key, password_hash) VALUES ($1, $2, $3) RETURNING id', [username, username.toLowerCase(), await hash(password)]);
    const user = { id: rows[0].id, username };
    return { ...(await this.session(user)), codes: await this.newCodes(user.id) };
  }

  /** Same error for unknown user and wrong password, and the same work either way, so usernames can not be probed. */
  async login(username: string, password: string, ip: string): Promise<{ error: string } | Session> {
    const key = String(username).toLowerCase();
    if (this.limiter.blocked(`ip:${ip}`) || this.limiter.blocked(`user:${key}`)) return { error: 'Too many tries. Wait a minute and try again.' };
    const { rows } = await this.db.query<{ id: string; username: string; password_hash: string }>('SELECT id, username, password_hash FROM users WHERE username_key = $1', [key]);
    const ok = rows[0] ? await verify(rows[0].password_hash, String(password)) : (await verify(await this.dummy, String(password)), false);
    if (!ok) {
      this.limiter.fail(`ip:${ip}`);
      this.limiter.fail(`user:${key}`);
      return { error: 'Wrong username or password.' };
    }
    this.limiter.clear(`user:${key}`);
    return this.session({ id: rows[0].id, username: rows[0].username });
  }

  /** Rotates the refresh token. Presenting an already-rotated token means it was stolen: the whole family is revoked. */
  async refresh(refresh: string): Promise<Session | null> {
    if (!refresh) return null;
    const { rows } = await this.db.query<{ family: string; user_id: string; rotated: boolean; expired: boolean; username: string }>(
      'SELECT s.family, s.user_id, s.rotated, s.expires_at < now() AS expired, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1',
      [sha(refresh)],
    );
    const s = rows[0];
    if (!s || s.expired) return null;
    if (s.rotated) {
      await this.db.query('DELETE FROM sessions WHERE family = $1', [s.family]);
      return null;
    }
    await this.db.query('UPDATE sessions SET rotated = true WHERE token_hash = $1', [sha(refresh)]);
    return this.session({ id: s.user_id, username: s.username }, s.family);
  }

  async logout(refresh: string) {
    await this.db.query('DELETE FROM sessions WHERE family = (SELECT family FROM sessions WHERE token_hash = $1)', [sha(refresh)]);
  }

  async recover(username: string, code: string, password: string, ip: string): Promise<{ error: string } | Session> {
    const key = String(username).toLowerCase();
    if (this.limiter.blocked(`ip:${ip}`) || this.limiter.blocked(`user:${key}`)) return { error: 'Too many tries. Wait a minute and try again.' };
    const fail = () => { this.limiter.fail(`ip:${ip}`); this.limiter.fail(`user:${key}`); return { error: 'That recovery code is not valid.' }; };
    const { rows } = await this.db.query<{ id: string; username: string }>('SELECT id, username FROM users WHERE username_key = $1', [key]);
    if (!rows[0]) return fail();
    const user = rows[0];
    const bad = passwordProblem(password, user.username);
    if (bad) return { error: bad };
    const codes = await this.db.query<{ code_hash: string }>('SELECT code_hash FROM recovery_codes WHERE user_id = $1 AND NOT used', [user.id]);
    const clean = String(code).trim().toUpperCase();
    let match: string | null = null;
    for (const c of codes.rows) if (await verify(c.code_hash, clean)) { match = c.code_hash; break; }
    if (!match) return fail();
    await this.db.query('UPDATE recovery_codes SET used = true WHERE user_id = $1 AND code_hash = $2', [user.id, match]);
    await this.db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hash(password), user.id]);
    await this.db.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
    return this.session(user);
  }

  private async checkPassword(userId: string, password: string) {
    const { rows } = await this.db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
    return !!rows[0] && (await verify(rows[0].password_hash, String(password)));
  }

  /** Changing the password signs out every other session. */
  async changePassword(user: User, current: string, next: string, keepRefresh: string): Promise<{ error?: string }> {
    if (!(await this.checkPassword(user.id, current))) return { error: 'Current password is wrong.' };
    const bad = passwordProblem(next, user.username);
    if (bad) return { error: bad };
    await this.db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hash(next), user.id]);
    await this.db.query('DELETE FROM sessions WHERE user_id = $1 AND family <> (SELECT family FROM sessions WHERE token_hash = $2)', [user.id, sha(keepRefresh)]);
    return {};
  }

  async regenerateCodes(user: User, password: string): Promise<{ error: string } | { codes: string[] }> {
    if (!(await this.checkPassword(user.id, password))) return { error: 'Password is wrong.' };
    return { codes: await this.newCodes(user.id) };
  }

  async deleteAccount(user: User, password: string): Promise<{ error?: string }> {
    if (!(await this.checkPassword(user.id, password))) return { error: 'Password is wrong.' };
    await this.db.query('DELETE FROM users WHERE id = $1', [user.id]);
    return {};
  }

  async verifyAccess(jwt: string): Promise<User | null> {
    try {
      const { payload } = await jwtVerify(jwt, this.pub, { audience: 'control' });
      return { id: String(payload.sub), username: String(payload.name) };
    } catch { return null; }
  }

  /** Short-lived ticket that lets one player into one match on a game server. */
  signJoin(user: User, matchId: string) {
    return new SignJWT({ name: user.username, match: matchId }).setProtectedHeader({ alg: 'EdDSA' }).setSubject(user.id).setAudience('game').setIssuedAt().setExpirationTime('60s').sign(this.priv);
  }
}

/** Game servers verify join tickets with the control service's public key. */
export async function verifyJoin(jwt: string, pub: CryptoKey): Promise<{ userId: string; username: string; match: string } | null> {
  try {
    const { payload } = await jwtVerify(jwt, pub, { audience: 'game' });
    return { userId: String(payload.sub), username: String(payload.name), match: String(payload.match) };
  } catch { return null; }
}
