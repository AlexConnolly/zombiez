import { POWERUPS, type Command, type Game, type GameEvent, type Player, type Zombie } from '../sim/game';
import type { MapDef } from '../sim/map';
import type { WeaponId } from '../sim/weapons';

/** Bumped on any breaking change; a client with another version is asked to refresh. */
export const PROTOCOL = 1;

export type ClientMsg =
  | { t: 'join'; v: number; match: string; token: string }
  | { t: 'input'; inputs: { seq: number; cmd: Command }[] }
  | { t: 'pong'; id: number }
  | { t: 'leave' };

export type ServerMsg =
  | { t: 'welcome'; you: string; map: string; seed: number; snap: Snap }
  | { t: 'snap'; snap: Snap }
  | { t: 'ping'; id: number }
  | { t: 'end'; round: number; stats: Record<string, Player['stats']> }
  | { t: 'error'; reason: string };

/** A zombie on the wire: id, x, y, z, yaw, state, flags (1 = runner, 2 = attacking), window index. */
export type ZSnap = [number, number, number, number, number, number, number, number];

export interface Snap {
  tick: number;
  /** Last input sequence the server applied for the receiving player. */
  ack: number;
  round: number;
  phase: Game['phase'];
  players: PSnap[];
  zombies: ZSnap[];
  boards: number[];
  doors: Record<string, boolean>;
  zones: Record<string, boolean>;
  power: boolean;
  box: Game['box'];
  instaKill: number;
  doublePoints: number;
  /** id, kind index, x, y, z, seconds left */
  powerups: [number, number, number, number, number, number][];
  /** id, weapon, x, y, z */
  projectiles: [number, WeaponId, number, number, number][];
  events: GameEvent[];
}

/** The parts of a player the client needs: everything except server-only bookkeeping. */
export type PSnap = Omit<Player, 'prev' | 'flowNode' | 'fireCD' | 'meleeCD' | 'hurtT' | 'boardPts'>;

const STATES: Zombie['state'][] = ['approach', 'tear', 'climb', 'hunt'];
const r2 = (n: number) => Math.round(n * 100) / 100;

export function encodeSnap(s: Game, map: MapDef, ack: number, events: GameEvent[]): Snap {
  return {
    tick: s.tick,
    ack,
    round: s.round,
    phase: s.phase,
    players: s.players.map(({ prev: _p, flowNode: _f, fireCD: _c, meleeCD: _m, hurtT: _h, boardPts: _b, ...p }) => p),
    zombies: s.zombies.map((z) => [
      z.id, r2(z.pos.x), r2(z.pos.y), r2(z.pos.z), r2(z.yaw), STATES.indexOf(z.state),
      (z.run ? 1 : 0) | (z.attackT > 0 ? 2 : 0), map.windows.findIndex((w) => w.id === z.window),
    ]),
    boards: map.windows.map((w) => s.windows[w.id].boards),
    doors: s.doors,
    zones: s.zones,
    power: s.power,
    box: s.box,
    instaKill: s.instaKill,
    doublePoints: s.doublePoints,
    powerups: s.powerups.map((p) => [p.id, POWERUPS.indexOf(p.kind), r2(p.pos.x), r2(p.pos.y), r2(p.pos.z), r2(p.t)]),
    projectiles: s.projectiles.map((p) => [p.id, p.weapon, r2(p.pos.x), r2(p.pos.y), r2(p.pos.z)]),
    events,
  };
}

/** Writes a snapshot into a client-side game state. Fields the client never reads are left alone. */
export function applySnap(s: Game, map: MapDef, n: Snap) {
  s.tick = n.tick;
  s.round = n.round;
  s.phase = n.phase;
  s.players = n.players.map((p) => ({
    ...p,
    prev: { fire: false, use: false, swap: false, reload: false, melee: false },
    flowNode: -1, fireCD: 0, meleeCD: 0, hurtT: 0, boardPts: 0,
  }));
  s.zombies = n.zombies.map(([id, x, y, z, yaw, st, flags, wi]) => ({
    id, pos: { x, y, z }, yaw, state: STATES[st], run: !!(flags & 1), attackT: flags & 2 ? 0.25 : 0,
    window: map.windows[wi]?.id ?? '', vy: 0, onGround: true, hp: 1, from: { x, y, z }, leg: 0, t: 0, attackCD: 0, node: -1,
  }));
  map.windows.forEach((w, i) => (s.windows[w.id].boards = n.boards[i]));
  s.doors = n.doors;
  s.zones = n.zones;
  s.power = n.power;
  s.box = n.box;
  s.instaKill = n.instaKill;
  s.doublePoints = n.doublePoints;
  s.powerups = n.powerups.map(([id, k, x, y, z, t]) => ({ id, kind: POWERUPS[k], pos: { x, y, z }, t }));
  s.projectiles = n.projectiles.map(([id, weapon, x, y, z]) => ({ id, pid: '', weapon, pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, t: 0 }));
}
