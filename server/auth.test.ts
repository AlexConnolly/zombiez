import { beforeEach, describe, expect, it } from 'vitest';
import { Auth, verifyJoin, type Session } from './auth';
import { openDb, type Db } from './db';

let db: Db;
let auth: Auth;
let clock = 0;
const PW = 'correct horse battery';

beforeEach(async () => {
  db = await openDb(undefined);
  clock = 1_000_000;
  auth = await Auth.create(db, () => clock);
});

const ok = <T,>(r: T | { error: string }) => {
  if (r && typeof r === 'object' && 'error' in r) throw new Error(r.error);
  return r as T;
};

describe('sign up', () => {
  it('creates an account, a session and 8 one-time recovery codes', async () => {
    const r = ok(await auth.signup('Alex_1', PW));
    expect(r.codes).toHaveLength(8);
    expect(r.codes[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(await auth.verifyAccess(r.access)).toEqual({ id: r.user.id, username: 'Alex_1' });
  });
  it('refuses bad usernames and weak passwords', async () => {
    expect(await auth.signup('ab', PW)).toHaveProperty('error');
    expect(await auth.signup('has space', PW)).toHaveProperty('error');
    expect(await auth.signup('xXnaziXx', PW)).toHaveProperty('error');
    expect(await auth.signup('alex', 'short')).toHaveProperty('error');
    expect(await auth.signup('alex', 'password123')).toHaveProperty('error');
    expect(await auth.signup('alexander', 'alexander-is-cool')).toHaveProperty('error');
  });
  it('usernames are unique regardless of case', async () => {
    ok(await auth.signup('Alex', PW));
    expect(await auth.signup('aLEX', PW)).toEqual({ error: 'That username is taken.' });
  });
});

describe('log in', () => {
  beforeEach(async () => { ok(await auth.signup('alex', PW)); });
  it('works with the right password, any case of username', async () => {
    expect(ok(await auth.login('ALEX', PW, '1.1.1.1')).user.username).toBe('alex');
  });
  it('gives the same error for a wrong password and an unknown user', async () => {
    const a = await auth.login('alex', 'wrong password!', '1.1.1.1');
    const b = await auth.login('nobody', 'wrong password!', '2.2.2.2');
    expect(a).toEqual(b);
  });
  it('locks out after 5 wrong tries in a minute, then lets you in after the lockout', async () => {
    for (let i = 0; i < 5; i++) await auth.login('alex', 'wrong password!', '1.1.1.1');
    expect(await auth.login('alex', PW, '1.1.1.1')).toHaveProperty('error');
    expect(await auth.login('alex', PW, '9.9.9.9')).toHaveProperty('error');
    clock += 6_000;
    expect(ok(await auth.login('alex', PW, '1.1.1.1')).user.username).toBe('alex');
  });
});

describe('sessions', () => {
  let s: Session;
  beforeEach(async () => { s = ok(await auth.signup('alex', PW)); });
  it('refresh rotates the token', async () => {
    const next = await auth.refresh(s.refresh);
    expect(next).not.toBeNull();
    expect(next!.refresh).not.toBe(s.refresh);
    expect(await auth.verifyAccess(next!.access)).not.toBeNull();
  });
  it('reusing a rotated token revokes the whole session (stolen token)', async () => {
    const next = (await auth.refresh(s.refresh))!;
    expect(await auth.refresh(s.refresh)).toBeNull();
    expect(await auth.refresh(next.refresh)).toBeNull();
  });
  it('logout ends the session', async () => {
    await auth.logout(s.refresh);
    expect(await auth.refresh(s.refresh)).toBeNull();
  });
  it('changing the password signs out other sessions but keeps this one', async () => {
    const other = ok(await auth.login('alex', PW, '1.1.1.1'));
    expect(await auth.changePassword(s.user, PW, 'a whole new password', s.refresh)).toEqual({});
    expect(await auth.refresh(other.refresh)).toBeNull();
    expect(await auth.refresh(s.refresh)).not.toBeNull();
    expect(await auth.login('alex', PW, '1.1.1.1')).toHaveProperty('error');
  });
});

describe('recovery', () => {
  it('a recovery code resets the password once and signs out everywhere', async () => {
    const s = ok(await auth.signup('alex', PW));
    const r = ok(await auth.recover('alex', s.codes[3].toLowerCase(), 'brand new password', '1.1.1.1'));
    expect(r.user.username).toBe('alex');
    expect(await auth.refresh(s.refresh)).toBeNull();
    expect(await auth.recover('alex', s.codes[3], 'another new password', '1.1.1.1')).toHaveProperty('error');
    expect(ok(await auth.login('alex', 'brand new password', '1.1.1.1')).user.username).toBe('alex');
  });
  it('regenerating codes needs the password and replaces the old codes', async () => {
    const s = ok(await auth.signup('alex', PW));
    expect(await auth.regenerateCodes(s.user, 'wrong')).toHaveProperty('error');
    const { codes } = ok(await auth.regenerateCodes(s.user, PW));
    expect(await auth.recover('alex', s.codes[0], 'brand new password', '1.1.1.1')).toHaveProperty('error');
    expect(await auth.recover('alex', codes[0], 'brand new password', '2.2.2.2')).not.toHaveProperty('error');
  });
});

describe('tokens', () => {
  it('a join ticket opens one match on a game server; an access token is not a join ticket', async () => {
    const s = ok(await auth.signup('alex', PW));
    const join = await auth.signJoin(s.user, 'm1');
    expect(await verifyJoin(join, auth.pub)).toEqual({ userId: s.user.id, username: 'alex', match: 'm1' });
    expect(await verifyJoin(s.access, auth.pub)).toBeNull();
    expect(await auth.verifyAccess(join)).toBeNull();
  });
  it('deleting the account removes it', async () => {
    const s = ok(await auth.signup('alex', PW));
    expect(await auth.deleteAccount(s.user, PW)).toEqual({});
    expect(await auth.login('alex', PW, '1.1.1.1')).toHaveProperty('error');
  });
});
