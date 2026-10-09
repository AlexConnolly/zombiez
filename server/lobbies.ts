import { randomInt } from 'node:crypto';
import type { LobbyView } from '../src/net/wire';
import { MATCH_SIZE, pickRegion, type Pings } from './matchmaker';

// No vowels, so codes never spell words.
const CODE = 'BCDFGHJKLMNPQRSTVWXZ';
const IDLE_MS = 30 * 60_000;

export interface Member { userId: string; username: string; pings: Pings; ready: boolean }
export interface Lobby { code: string; members: Member[]; mode: 'normal' | 'daily'; map: string; region: string | null; touched: number }

/** Lobby view sent to members: the host is members[0]. */
export function lobbyView(l: Lobby, regions: string[]): LobbyView {
  const auto = pickRegion(l.members.map((m) => m.pings), regions);
  const region = l.region ?? auto?.region ?? null;
  return {
    code: l.code,
    mode: l.mode,
    map: l.map,
    region,
    regionChosen: !!l.region,
    host: l.members[0]?.username,
    members: l.members.map((m) => ({ username: m.username, ready: m.ready, ping: region ? m.pings[region] ?? null : null })),
  };
}

export class Lobbies {
  private byCode = new Map<string, Lobby>();
  private byUser = new Map<string, Lobby>();
  constructor(private now: () => number = Date.now) {}

  of(userId: string) { return this.byUser.get(userId); }
  get(code: string) { return this.byCode.get(code.toUpperCase()); }

  create(m: Omit<Member, 'ready'>): Lobby {
    this.leave(m.userId);
    let code = '';
    do code = Array.from({ length: 4 }, () => CODE[randomInt(CODE.length)]).join(''); while (this.byCode.has(code));
    const l: Lobby = { code, members: [{ ...m, ready: false }], mode: 'normal', map: 'farmhouse', region: null, touched: this.now() };
    this.byCode.set(code, l);
    this.byUser.set(m.userId, l);
    return l;
  }

  join(code: string, m: Omit<Member, 'ready'>): Lobby | string {
    const l = this.get(code);
    if (!l) return 'No lobby with that code.';
    if (l.members.some((x) => x.userId === m.userId)) return l;
    if (l.members.length >= MATCH_SIZE) return 'That lobby is full.';
    this.leave(m.userId);
    l.members.push({ ...m, ready: false });
    l.touched = this.now();
    this.byUser.set(m.userId, l);
    return l;
  }

  /** Leaving hands the lobby to the next member; the last one out closes it. */
  leave(userId: string): Lobby | null {
    const l = this.byUser.get(userId);
    if (!l) return null;
    l.members = l.members.filter((m) => m.userId !== userId);
    this.byUser.delete(userId);
    if (!l.members.length) this.byCode.delete(l.code);
    l.touched = this.now();
    return l.members.length ? l : null;
  }

  update(userId: string, fn: (l: Lobby, me: Member, host: boolean) => void): Lobby | null {
    const l = this.byUser.get(userId);
    const me = l?.members.find((m) => m.userId === userId);
    if (!l || !me) return null;
    fn(l, me, l.members[0] === me);
    l.touched = this.now();
    return l;
  }

  /** Only the host, and only when everyone is ready. */
  canStart(userId: string): string | null {
    const l = this.byUser.get(userId);
    if (!l) return 'You are not in a lobby.';
    if (l.members[0].userId !== userId) return 'Only the host can start.';
    if (!l.members.every((m) => m.ready)) return 'Everyone must be ready.';
    return null;
  }

  close(l: Lobby) {
    for (const m of l.members) this.byUser.delete(m.userId);
    this.byCode.delete(l.code);
  }

  /** Lobbies idle for 30 minutes close. Returns the closed ones so members can be told. */
  sweep(): Lobby[] {
    const old = [...this.byCode.values()].filter((l) => this.now() - l.touched > IDLE_MS);
    old.forEach((l) => this.close(l));
    return old;
  }
}
