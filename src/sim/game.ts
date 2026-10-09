import { DIRS, cellCenter, facingDir, floorIndex, maxBoards, placedPos, stairExits, v3, windowGeom, type MapDef, type V3 } from './map';
import { dist2, moveBody, pointInBox, rayBox, rayWorld, box, type Box } from './physics';
import { next } from './rng';
import { MELEE, PERKS, WEAPONS, isMelee, type MeleeId, type PerkId, type WeaponId } from './weapons';
import { World } from './world';

export const TICK = 1 / 30;
export const MAX_ALIVE = 24;
export const PLAYER_HW = 0.3;
export const PLAYER_H = 1.8;
export const EYE = 1.6;
const ZOMBIE_HW = 0.3;
const ZOMBIE_H = 1.8;
const WALK = 4.5;
const SPRINT = 6.5;
const USE_RANGE = 1.7;
const TEAR_TIME = 1.5;
const REBUILD_TIME = 0.75;
const BOARD_POINTS_CAP = 50;
const BOX_COST = 950;
const POWERUP_LIFE = 30;
const EFFECT_TIME = 30;
const DROP_CHANCE = 0.02;
const MAX_DROPS = 4;
const ZOMBIE_DAMAGE = 50;
/** Zombies climb walls and drainpipes at 1 m/s. */
const CLIMB_SPEED = 1;
/** Footsteps on the roof are heard this long before a zombie reaches a skylight. */
const ROOF_WARNING = 3;
const SLIDE_TIME = 0.6;
const LINK_RANGE = 2.5;
/** The shelter shows each weapon on offer for this long; Use takes the one showing. */
const SHELTER_CYCLE = 1.5;
/** Lag compensation looks back at most this many ticks (~350 ms: 250 ms ping + 100 ms interpolation). */
export const MAX_REWIND = 11;
const BLEED_TIME = 30;
const REVIVE_TIME = 3;
const REVIVE_RANGE = 1.5;
const CRAWL = 1;
export const GRACE_TIME = 60;

export const zombieHp = (round: number) =>
  Math.round(round < 10 ? 150 + 100 * (round - 1) : 950 * 1.1 ** (round - 9));
export const zombieCount = (round: number, players = 1) => Math.min(24, 6 + round * 2) + (players - 1) * 6;
export const hpScale = (players: number) => (players >= 4 ? 1.5 : players === 3 ? 1.25 : 1);
export const spawnInterval = (round: number) => Math.max(0.6, 2.5 - round * 0.15);
export const runChance = (round: number) => (round < 4 ? 0 : Math.min(0.85, (round - 3) * 0.15));

export interface Command {
  /** -1..1 forward/back and right/left. */
  fwd: number;
  strafe: number;
  yaw: number;
  pitch: number;
  sprint: boolean;
  fire: boolean;
  use: boolean;
  reload: boolean;
  swap: boolean;
  melee: boolean;
  /** Online only: the server tick the client was showing when this command was made. Shots are checked against zombies as they were then. */
  view?: number;
}
export const NO_INPUT: Command = { fwd: 0, strafe: 0, yaw: 0, pitch: 0, sprint: false, fire: false, use: false, reload: false, swap: false, melee: false };

export type PowerupKind = 'maxAmmo' | 'instaKill' | 'doublePoints' | 'nuke';
export const POWERUPS: PowerupKind[] = ['maxAmmo', 'instaKill', 'doublePoints', 'nuke'];

export type GameEvent =
  | { type: 'shot'; pid: string; weapon: WeaponId; from: V3; ends: V3[] }
  | { type: 'hit'; zid: number; pos: V3; head: boolean; pid: string }
  | { type: 'kill'; zid: number; pos: V3; head: boolean; pid: string }
  | { type: 'points'; pid: string; amount: number }
  | { type: 'melee'; pid: string; hit: boolean }
  | { type: 'empty' | 'reload' | 'swap' | 'denied' | 'down' | 'bleedOut' | 'respawn' | 'disconnect' | 'reconnect' | 'away' | 'left'; pid: string }
  | { type: 'revive'; pid: string; by: string }
  | { type: 'hurt'; pid: string; hp: number }
  | { type: 'board'; window: string; boards: number; torn: boolean }
  | { type: 'zombieAttack' | 'spawn' | 'climb' | 'roof'; zid: number }
  | { type: 'roundStart' | 'roundEnd' | 'gameOver'; round: number }
  | { type: 'door'; id: string }
  | { type: 'buy'; pid: string; what: string }
  | { type: 'power' }
  | { type: 'powerupDrop'; id: number; kind: PowerupKind }
  | { type: 'powerup'; id: number; kind: PowerupKind }
  | { type: 'explode'; pos: V3; radius: number }
  | { type: 'boxRoll'; pid: string }
  | { type: 'boxOffer'; weapon: WeaponId }
  | { type: 'boxMove'; spot: number }
  | { type: 'trap'; id: string; fire: boolean }
  | { type: 'slide'; pid: string }
  | { type: 'link'; pid: string; to: number }
  | { type: 'secret'; pid: string; placed: number };

export interface Player {
  id: string;
  pos: V3;
  vy: number;
  onGround: boolean;
  yaw: number;
  pitch: number;
  hp: number;
  maxHp: number;
  points: number;
  weapons: { id: WeaponId; mag: number; reserve: number }[];
  cur: number;
  reloadT: number;
  fireCD: number;
  meleeCD: number;
  perks: PerkId[];
  melee: MeleeId;
  /** Sliding down a banister: seconds left, and the start and end of the slide. */
  slide: { t: number; from: V3; to: V3 } | null;
  /** alive: playing. down: last stand, can be revived. dead: bled out, respawns next round. away: grace ran out, respawns next round if back. left: gone. */
  status: 'alive' | 'down' | 'dead' | 'away' | 'left';
  connected: boolean;
  /** Seconds of reconnect grace left while disconnected. */
  graceT: number;
  bleedT: number;
  /** What the player is holding Use on (window or player id); a new target restarts the timer. */
  holdId: string;
  hurtT: number;
  useT: number;
  boardPts: number;
  prev: { fire: boolean; use: boolean; swap: boolean; reload: boolean; melee: boolean };
  stats: { kills: number; headshots: number; earned: number; boards: number };
  flowNode: number;
}

export interface Zombie {
  id: number;
  pos: V3;
  vy: number;
  onGround: boolean;
  yaw: number;
  hp: number;
  run: boolean;
  state: 'approach' | 'tear' | 'climb' | 'hunt';
  window: string;
  from: V3;
  /** Approach: index of the path point being walked to. */
  leg: number;
  t: number;
  attackT: number;
  attackCD: number;
  node: number;
}

export interface Game {
  seed: number;
  rng: { s: number };
  tick: number;
  round: number;
  phase: 'break' | 'active' | 'over';
  phaseT: number;
  toSpawn: number;
  spawnT: number;
  players: Player[];
  zombies: Zombie[];
  windows: Record<string, { boards: number; tearT: number; tearer: number }>;
  doors: Record<string, boolean>;
  zones: Record<string, boolean>;
  power: boolean;
  box: { spot: number; uses: number; moveAt: number; phase: 'idle' | 'rolling' | 'offer'; t: number; weapon: WeaponId | null; pid: string | null };
  powerups: { id: number; kind: PowerupKind; pos: V3; t: number }[];
  drops: number;
  instaKill: number;
  doublePoints: number;
  projectiles: { id: number; pid: string; weapon: WeaponId; pos: V3; vel: V3; t: number }[];
  nextId: number;
  /** Per trap: seconds until it can be used again, and seconds until a lit one fires (0 = not lit). */
  traps: Record<string, { cd: number; fuse: number }>;
  /** The map's secret: hiding spots that still hold an item, items each player carries, items placed, players who took their reward. */
  secret: { spots: number[]; carried: Record<string, number>; placed: number; claimed: string[] };
}

export type Interaction =
  | { kind: 'window'; id: string; label: string; hold: true }
  | { kind: 'revive'; id: string; label: string; hold: true }
  | { kind: 'door'; id: string; label: string; cost: number }
  | { kind: 'wall'; weapon: WeaponId; label: string; cost: number }
  | { kind: 'box'; label: string; cost: number }
  | { kind: 'perk'; perk: PerkId; label: string; cost: number }
  | { kind: 'power'; label: string }
  | { kind: 'trap'; id: string; label: string; cost: number }
  | { kind: 'slide'; stair: number; label: string }
  | { kind: 'link'; link: number; label: string; cost: number }
  | { kind: 'melee'; melee: MeleeId; label: string; cost: number }
  | { kind: 'secret'; spot: number; label: string }
  | { kind: 'shelter'; weapon: WeaponId | null; label: string }
  | { kind: 'info'; label: string };

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const copy = (p: V3): V3 => ({ ...p });

export class Sim {
  readonly world: World;
  readonly state: Game;
  events: GameEvent[] = [];
  private flows = new Map<string, { field: Float64Array; node: number }>();
  /** Zombie positions for the last second, by tick, for lag-compensated shots. */
  private history: { tick: number; pos: Map<number, V3> }[] = [];

  constructor(readonly map: MapDef, seed: number, playerIds: string[] = ['p1']) {
    this.world = new World(map);
    const s: Game = {
      seed,
      rng: { s: seed | 0 },
      tick: 0,
      round: 0,
      phase: 'break',
      phaseT: 3,
      toSpawn: 0,
      spawnT: 0,
      players: [],
      zombies: [],
      windows: Object.fromEntries(map.windows.map((w) => [w.id, { boards: maxBoards(w), tearT: 0, tearer: -1 }])),
      doors: Object.fromEntries(map.doors.map((d) => [d.id, false])),
      zones: { [map.startZone]: true },
      power: !map.power,
      box: { spot: 0, uses: 0, moveAt: 4, phase: 'idle', t: 0, weapon: null, pid: null },
      powerups: [],
      drops: 0,
      instaKill: 0,
      doublePoints: 0,
      projectiles: [],
      nextId: 1,
      traps: Object.fromEntries((map.traps ?? []).map((t) => [t.id, { cd: 0, fuse: 0 }])),
      secret: { spots: [], carried: {}, placed: 0, claimed: [] },
    };
    this.state = s;
    if (map.secret) {
      const pool = map.secret.spots.map((_, i) => i);
      for (let i = 0; i < map.secret.count; i++) s.secret.spots.push(pool.splice(Math.floor(this.rand() * pool.length), 1)[0]);
    }
    s.box.moveAt = 4 + Math.floor(this.rand() * 5);
    s.players = playerIds.map((id, i) => ({ ...newPlayer(id), pos: placedPos(map, map.playerSpawns[i % map.playerSpawns.length]) }));
    this.world.update(s.doors, s.box.spot);
  }

  rand() { return next(this.state.rng); }

  /** Movement only, for inputs that arrive late and are caught up in one server tick. */
  extraMove(id: string, c: Command) {
    const p = this.player(id);
    if (p && p.connected && !p.slide && (p.status === 'alive' || p.status === 'down')) movePlayer(p, c, this.world, p.status === 'down');
  }

  /** Adds a player mid-match (dev matches and tests; lobby matches start with everyone). */
  addPlayer(id: string) {
    const s = this.state;
    if (this.player(id)) return;
    const sp = this.map.playerSpawns[s.players.length % this.map.playerSpawns.length];
    s.players.push({ ...newPlayer(id), pos: placedPos(this.map, sp) });
  }

  player(id: string) { return this.state.players.find((p) => p.id === id); }

  step(cmds: Record<string, Command>): GameEvent[] {
    this.events = [];
    const s = this.state;
    this.updateGrace();
    // Nobody connected: the world freezes until someone returns or every grace period runs out.
    const frozen = !s.players.some((p) => p.connected);
    if (s.phase !== 'over' && !frozen) {
      for (const p of s.players) this.updatePlayer(p, cmds[p.id] ?? { ...NO_INPUT, yaw: p.yaw, pitch: p.pitch });
      this.updateRound();
      this.updateFlows();
      for (const z of [...s.zombies]) this.updateZombie(z);
      this.separate();
      this.updateProjectiles();
      this.updatePowerups();
      this.updateBox();
      this.updateTraps();
      s.instaKill = Math.max(0, s.instaKill - TICK);
      s.doublePoints = Math.max(0, s.doublePoints - TICK);
    }
    this.checkOver();
    s.tick++;
    this.history.push({ tick: s.tick, pos: new Map(s.zombies.map((z) => [z.id, copy(z.pos)])) });
    if (this.history.length > 30) this.history.shift();
    return this.events;
  }

  // ---------------------------------------------------------------- players

  private updatePlayer(p: Player, c: Command) {
    if (!p.connected || (p.status !== 'alive' && p.status !== 'down')) return;
    const down = p.status === 'down';
    if (p.slide) {
      const sl = p.slide;
      sl.t = Math.max(0, sl.t - TICK);
      const k = 1 - sl.t / SLIDE_TIME;
      p.pos = v(sl.from.x + (sl.to.x - sl.from.x) * k, sl.from.y + (sl.to.y - sl.from.y) * k, sl.from.z + (sl.to.z - sl.from.z) * k);
      p.vy = 0;
      p.yaw = c.yaw;
      p.pitch = c.pitch;
      if (sl.t <= 0) p.slide = null;
    } else movePlayer(p, c, this.world, down);
    if (down) {
      p.bleedT -= TICK;
      if (p.bleedT <= 0) {
        p.status = 'dead';
        p.perks = [];
        this.events.push({ type: 'bleedOut', pid: p.id });
        return;
      }
      c = { ...c, swap: false, melee: false, use: false };
    } else {
      p.hurtT += TICK;
      if (p.hurtT > 4) p.hp = Math.min(p.maxHp, p.hp + 100 * TICK);
    }

    p.fireCD -= TICK;
    p.meleeCD -= TICK;
    const w = p.weapons[p.cur];
    const def = WEAPONS[w.id];
    if (p.reloadT > 0) {
      p.reloadT -= TICK;
      if (p.reloadT <= 0) {
        const n = Math.min(def.mag - w.mag, w.reserve);
        w.mag += n;
        w.reserve -= n;
      }
    }
    const edge = (k: keyof Player['prev']) => c[k] && !p.prev[k];
    if (edge('swap') && p.weapons.length > 1) {
      p.cur = 1 - p.cur;
      p.reloadT = 0;
      p.fireCD = 0.35;
      this.events.push({ type: 'swap', pid: p.id });
    } else if (edge('reload')) this.startReload(p);
    if (edge('melee') && p.meleeCD <= 0) this.melee(p);
    const trigger = def.auto ? c.fire : edge('fire');
    if (trigger && p.fireCD <= 0 && p.reloadT <= 0 && p.meleeCD < MELEE[p.melee].cooldown - 0.3) {
      const cw = p.weapons[p.cur];
      if (cw.mag > 0) this.fire(p, c.view);
      else if (edge('fire')) {
        this.events.push({ type: 'empty', pid: p.id });
        this.startReload(p);
      }
    }
    if (p.weapons[p.cur].mag === 0 && p.reloadT <= 0 && p.fireCD <= 0) this.startReload(p);

    const it = c.use ? this.interaction(p.id) : null;
    if (it?.kind === 'window' || it?.kind === 'revive') {
      if (p.holdId !== it.id) { p.holdId = it.id; p.useT = 0; }
      p.useT += TICK;
      if (it.kind === 'window' && p.useT >= REBUILD_TIME) {
        p.useT = 0;
        this.rebuild(p, it.id);
      }
      if (it.kind === 'revive' && p.useT >= REVIVE_TIME * (p.perks.includes('quick') ? 0.5 : 1)) {
        p.useT = 0;
        this.revive(p, it.id);
      }
    } else {
      p.useT = 0;
      p.holdId = '';
      if (it && edge('use')) this.use(p, it);
    }
    p.prev = { fire: c.fire, use: c.use, swap: c.swap, reload: c.reload, melee: c.melee };
  }

  private startReload(p: Player) {
    const w = p.weapons[p.cur];
    const def = WEAPONS[w.id];
    if (p.reloadT > 0 || w.mag >= def.mag || w.reserve <= 0) return;
    p.reloadT = def.reload * (p.perks.includes('quick') ? 0.5 : 1);
    this.events.push({ type: 'reload', pid: p.id });
  }

  eye(p: Player): V3 { return v(p.pos.x, p.pos.y + EYE, p.pos.z); }

  aim(p: Player): V3 {
    const cp = Math.cos(p.pitch);
    return v(-Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp);
  }

  /** Where a zombie was at a past (fractional) tick, or where it is now if that is unknown. */
  private rewound(z: Zombie, view: number | undefined): Zombie {
    const now = this.state.tick;
    if (view === undefined || view >= now) return z;
    const t = Math.max(now - MAX_REWIND, view);
    const h = this.history;
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].tick > t) continue;
      const a = h[i - 1].pos.get(z.id), b = h[i].pos.get(z.id);
      if (!a || !b) return z;
      const k = (t - h[i - 1].tick) / (h[i].tick - h[i - 1].tick);
      return { ...z, pos: v(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k) };
    }
    return z;
  }

  private fire(p: Player, view?: number) {
    const w = p.weapons[p.cur];
    const def = WEAPONS[w.id];
    w.mag--;
    p.fireCD = 1 / def.rate;
    const o = this.eye(p);
    const d = this.aim(p);
    if (def.splash) {
      const speed = w.id === 'zapper' ? 40 : 25;
      this.state.projectiles.push({ id: this.state.nextId++, pid: p.id, weapon: w.id, pos: copy(o), vel: v(d.x * speed, d.y * speed, d.z * speed), t: 0 });
      this.events.push({ type: 'shot', pid: p.id, weapon: w.id, from: o, ends: [] });
      return;
    }
    const ends: V3[] = [];
    for (let i = 0; i < def.pellets; i++) {
      const dir = this.jitter(d, def.spread);
      const wall = rayWorld(o, dir, 60, this.world.ray());
      let best = wall;
      let hitZ: Zombie | null = null;
      let head = false;
      for (const z of this.state.zombies) {
        const [bodyBox, headBox] = zombieBoxes(this.rewound(z, view));
        const th = rayBox(o, dir, headBox);
        const tb = rayBox(o, dir, bodyBox);
        const t = Math.min(th, tb);
        if (t < best) { best = t; hitZ = z; head = th <= tb; }
      }
      ends.push(v(o.x + dir.x * best, o.y + dir.y * best, o.z + dir.z * best));
      if (hitZ) this.hurtZombie(hitZ, def.damage * (head ? 2 : 1), p, head ? 'head' : 'body');
    }
    this.events.push({ type: 'shot', pid: p.id, weapon: w.id, from: o, ends });
  }

  private jitter(d: V3, spread: number): V3 {
    if (!spread) return d;
    const a = this.rand() * Math.PI * 2;
    const r = Math.sqrt(this.rand()) * spread;
    // Any vector not parallel to d gives a basis for the cone.
    const up = Math.abs(d.y) < 0.9 ? v(0, 1, 0) : v(1, 0, 0);
    const ux = d.y * up.z - d.z * up.y, uy = d.z * up.x - d.x * up.z, uz = d.x * up.y - d.y * up.x;
    const ul = Math.hypot(ux, uy, uz);
    const u = v(ux / ul, uy / ul, uz / ul);
    const w = v(d.y * u.z - d.z * u.y, d.z * u.x - d.x * u.z, d.x * u.y - d.y * u.x);
    const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
    const x = d.x + u.x * ca + w.x * sa, y = d.y + u.y * ca + w.y * sa, z = d.z + u.z * ca + w.z * sa;
    const l = Math.hypot(x, y, z);
    return v(x / l, y / l, z / l);
  }

  private melee(p: Player) {
    const m = MELEE[p.melee];
    p.meleeCD = m.cooldown;
    const d = this.aim(p);
    let best: Zombie | null = null;
    let bd = m.range ** 2;
    for (const z of this.state.zombies) {
      const dx = z.pos.x - p.pos.x, dz = z.pos.z - p.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > bd || Math.abs(z.pos.y - p.pos.y) > 1.5) continue;
      const l = Math.sqrt(d2) || 1;
      if ((dx * d.x + dz * d.z) / l < m.cone) continue;
      best = z;
      bd = d2;
    }
    if (best) this.hurtZombie(best, m.damage, p, 'knife');
    this.events.push({ type: 'melee', pid: p.id, hit: !!best });
  }

  award(p: Player, n: number) {
    n *= this.state.doublePoints > 0 ? 2 : 1;
    p.points += n;
    p.stats.earned += n;
    this.events.push({ type: 'points', pid: p.id, amount: n });
  }

  hurtZombie(z: Zombie, dmg: number, p: Player, kind: 'body' | 'head' | 'knife' | 'blast') {
    if (!this.state.zombies.includes(z)) return;
    z.hp -= this.state.instaKill > 0 ? z.hp : dmg;
    const head = kind === 'head';
    if (z.hp > 0) {
      this.award(p, 10);
      this.events.push({ type: 'hit', zid: z.id, pos: copy(z.pos), head, pid: p.id });
      return;
    }
    this.award(p, kind === 'knife' ? 130 : head ? 100 : 60);
    p.stats.kills++;
    if (head) p.stats.headshots++;
    this.removeZombie(z);
    this.events.push({ type: 'kill', zid: z.id, pos: copy(z.pos), head, pid: p.id });
    const s = this.state;
    if (s.drops < MAX_DROPS && this.rand() < DROP_CHANCE) this.drop(z.pos);
  }

  drop(pos: V3, kind?: PowerupKind) {
    const s = this.state;
    s.drops++;
    const k = kind ?? POWERUPS[Math.floor(this.rand() * POWERUPS.length)];
    const id = s.nextId++;
    s.powerups.push({ id, kind: k, pos: v(pos.x, Math.max(pos.y, this.floorBelow(pos)) + 0.6, pos.z), t: POWERUP_LIFE });
    this.events.push({ type: 'powerupDrop', id, kind: k });
  }

  private floorBelow(p: V3) {
    const n = this.world.nodeAt(p);
    return n >= 0 ? this.world.nodePos(n).y : p.y;
  }

  private removeZombie(z: Zombie) {
    const s = this.state;
    s.zombies = s.zombies.filter((o) => o !== z);
    for (const w of Object.values(s.windows)) if (w.tearer === z.id) { w.tearer = -1; w.tearT = 0; }
  }

  private hurtPlayer(p: Player, dmg: number) {
    p.hp -= dmg;
    p.hurtT = 0;
    this.events.push({ type: 'hurt', pid: p.id, hp: p.hp });
    if (p.hp > 0) return;
    p.hp = 0;
    p.status = 'down';
    p.bleedT = BLEED_TIME;
    p.reloadT = 0;
    this.events.push({ type: 'down', pid: p.id });
  }

  private revive(by: Player, id: string) {
    const p = this.player(id);
    if (!p || p.status !== 'down') return;
    p.status = 'alive';
    p.hp = 50;
    p.hurtT = 0;
    p.bleedT = 0;
    this.award(by, 100);
    this.events.push({ type: 'revive', pid: p.id, by: by.id });
  }

  /** Over when nobody is left standing. A disconnected player still in their grace period counts as standing. */
  private checkOver() {
    const s = this.state;
    if (s.phase === 'over' || !s.players.length || s.players.some((p) => p.status === 'alive')) return;
    s.phase = 'over';
    this.events.push({ type: 'gameOver', round: s.round });
  }

  private updateGrace() {
    for (const p of this.state.players) {
      if (p.connected || p.graceT <= 0) continue;
      p.graceT -= TICK;
      if (p.graceT > 0) continue;
      if (p.status === 'alive' || p.status === 'down') this.dropFromRound();
      if (p.status !== 'left') p.status = 'away';
      this.events.push({ type: 'away', pid: p.id });
    }
  }

  /** A player who stops counting mid-round takes their share of the remaining zombies with them. */
  private dropFromRound() {
    this.state.toSpawn = Math.max(0, this.state.toSpawn - 6);
  }

  disconnect(id: string) {
    const p = this.player(id);
    if (!p || !p.connected) return;
    p.connected = false;
    p.graceT = GRACE_TIME;
    this.events.push({ type: 'disconnect', pid: id });
  }

  /** Inside the grace period play resumes in place; after it, the player respawns at the next round. */
  connect(id: string) {
    const p = this.player(id);
    if (!p || p.connected || p.status === 'left') return false;
    p.connected = true;
    p.graceT = 0;
    this.events.push({ type: 'reconnect', pid: id });
    return true;
  }

  leave(id: string) {
    const p = this.player(id);
    if (!p || p.status === 'left') return;
    if (p.status === 'alive' || p.status === 'down') this.dropFromRound();
    p.status = 'left';
    p.connected = false;
    p.graceT = 0;
    this.events.push({ type: 'left', pid: id });
  }

  /** Players counted for zombie numbers: connected and still in the match. */
  activeCount() {
    return Math.max(1, this.state.players.filter((p) => p.connected && p.status !== 'left').length);
  }

  private respawn(p: Player, i: number) {
    const sp = this.map.playerSpawns[i % this.map.playerSpawns.length];
    if (p.status === 'dead') {
      p.weapons = [{ id: 'p9', mag: WEAPONS.p9.mag, reserve: WEAPONS.p9.reserve }];
      p.cur = 0;
      p.melee = 'knife';
      p.points = Math.max(p.points, 500);
    }
    Object.assign(p, { pos: placedPos(this.map, sp), slide: null, vy: 0, onGround: true, hp: 100, maxHp: 100, perks: [], status: 'alive', reloadT: 0, bleedT: 0, hurtT: 99 });
    this.events.push({ type: 'respawn', pid: p.id });
  }

  // ---------------------------------------------------------------- interactions

  interaction(pid: string): Interaction | null {
    const p = this.player(pid);
    if (!p || p.status !== 'alive' || !p.connected) return null;
    const s = this.state;
    const map = this.map;
    const opts: [number, Interaction][] = [];
    for (const o of s.players)
      if (o !== p && o.status === 'down' && dist2(o.pos, p.pos) <= REVIVE_RANGE ** 2 && Math.abs(o.pos.y - p.pos.y) < 1.2)
        opts.push([-1, { kind: 'revive', id: o.id, label: `Hold to revive ${o.id}`, hold: true }]);
    const near = (pos: V3, range = USE_RANGE) => {
      if (Math.abs(pos.y - p.pos.y) > 1.2) return -1;
      const d = dist2(pos, p.pos);
      return d <= range * range ? d : -1;
    };
    const add = (pos: V3, it: Interaction | null, range?: number) => {
      const d = near(pos, range);
      if (it && d >= 0) opts.push([d, it]);
    };

    for (const w of map.windows)
      if (s.windows[w.id].boards < maxBoards(w)) add(windowGeom(map, w).center, { kind: 'window', id: w.id, label: 'Hold to rebuild barrier', hold: true }, 1.9);
    for (const d of map.doors) {
      if (s.doors[d.id]) continue;
      const fi = floorIndex(map, d.floor);
      const ready = (d.needs ?? []).every((z) => s.zones[z]);
      for (const [x, z] of d.cells) add(cellCenter(map, fi, x, z), ready ? { kind: 'door', id: d.id, label: 'Clear debris', cost: d.cost } : { kind: 'info', label: 'Blocked from the other side' });
    }
    for (const wb of map.wallBuys) {
      if (isMelee(wb.weapon)) {
        if (p.melee !== wb.weapon) add(placedPos(map, wb), { kind: 'melee', melee: wb.weapon, label: `Buy ${MELEE[wb.weapon].name}`, cost: MELEE[wb.weapon].cost });
        continue;
      }
      const id = wb.weapon as WeaponId;
      const def = WEAPONS[id];
      const has = p.weapons.some((w) => w.id === id);
      add(placedPos(map, wb), has ? { kind: 'wall', weapon: id, label: `Ammo for ${def.name}`, cost: def.cost / 2 } : { kind: 'wall', weapon: id, label: `Buy ${def.name}`, cost: def.cost });
    }
    const b = s.box;
    const bpos = placedPos(map, map.boxSpots[b.spot]);
    if (b.phase === 'idle') add(bpos, { kind: 'box', label: 'Mystery box', cost: BOX_COST });
    if (b.phase === 'offer' && b.pid === p.id && b.weapon) add(bpos, { kind: 'box', label: `Take ${WEAPONS[b.weapon].name}`, cost: 0 });
    for (const pk of map.perks) {
      const id = pk.perk as PerkId;
      if (p.perks.includes(id)) continue;
      add(placedPos(map, pk), s.power ? { kind: 'perk', perk: id, label: `Drink ${PERKS[id].name}`, cost: PERKS[id].cost } : { kind: 'info', label: 'Needs power' });
    }
    if (map.power && !s.power) add(placedPos(map, map.power), { kind: 'power', label: 'Turn on power' });
    for (const t of map.traps ?? []) {
      const ts = s.traps[t.id];
      add(placedPos(map, t), ts.cd > 0 ? { kind: 'info', label: `Cooling down ${Math.ceil(ts.cd)}s` } : { kind: 'trap', id: t.id, label: 'Light the gas', cost: t.cost });
    }
    (map.links ?? []).forEach((l, i) => {
      add(placedPos(map, l.a), { kind: 'link', link: i, label: 'Send ammo up the dumbwaiter', cost: l.cost });
      add(placedPos(map, l.b), { kind: 'link', link: i, label: 'Send ammo down the dumbwaiter', cost: l.cost });
    });
    const sec = map.secret;
    if (sec) {
      for (const i of s.secret.spots) add(placedPos(map, sec.spots[i]), { kind: 'secret', spot: i, label: 'Pick up a ration book' });
      const offer = this.shelterOffer(p);
      const label = this.shelterLabel(p);
      add(placedPos(map, sec.drop), s.secret.carried[p.id] || offer ? { kind: 'shelter', weapon: offer, label } : { kind: 'info', label });
    }
    map.stairs.forEach((st, i) => {
      if (!st.slide) return;
      const fi = floorIndex(map, st.floor) + 1;
      for (const [x, z] of stairExits(map, st)) if (!this.doorAt(fi, x, z)) add(cellCenter(map, fi, x, z), { kind: 'slide', stair: i, label: 'Slide down the banister' }, 1.2);
    });
    opts.sort((a, b) => a[0] - b[0]);
    return opts[0]?.[1] ?? null;
  }

  private pay(p: Player, cost: number): boolean {
    if (p.points < cost) {
      this.events.push({ type: 'denied', pid: p.id });
      return false;
    }
    p.points -= cost;
    return true;
  }

  private use(p: Player, it: Interaction) {
    const s = this.state;
    switch (it.kind) {
      case 'door': {
        if (!this.pay(p, it.cost)) return;
        s.doors[it.id] = true;
        s.zones[this.map.doors.find((d) => d.id === it.id)!.opens] = true;
        this.world.update(s.doors, s.box.spot);
        this.flows.clear();
        this.events.push({ type: 'door', id: it.id });
        return;
      }
      case 'wall':
        if (!this.pay(p, it.cost)) return;
        this.give(p, it.weapon);
        this.events.push({ type: 'buy', pid: p.id, what: it.weapon });
        return;
      case 'box':
        if (s.box.phase === 'offer' && s.box.weapon) {
          this.give(p, s.box.weapon);
          this.events.push({ type: 'buy', pid: p.id, what: s.box.weapon });
          s.box.phase = 'idle';
          s.box.weapon = null;
          s.box.pid = null;
          return;
        }
        if (!this.pay(p, it.cost)) return;
        Object.assign(s.box, { phase: 'rolling', t: 0, pid: p.id });
        this.events.push({ type: 'boxRoll', pid: p.id });
        return;
      case 'perk':
        if (!this.pay(p, it.cost)) return;
        p.perks.push(it.perk);
        if (it.perk === 'tough') { p.maxHp = 250; p.hp = 250; }
        this.events.push({ type: 'buy', pid: p.id, what: it.perk });
        return;
      case 'power':
        s.power = true;
        this.events.push({ type: 'power' });
        return;
      case 'melee':
        if (!this.pay(p, it.cost)) return;
        p.melee = it.melee;
        this.events.push({ type: 'buy', pid: p.id, what: it.melee });
        return;
      case 'trap': {
        if (!this.pay(p, it.cost)) return;
        const t = this.map.traps!.find((x) => x.id === it.id)!;
        s.traps[it.id] = { cd: t.cooldown, fuse: t.delay };
        this.events.push({ type: 'trap', id: it.id, fire: false });
        return;
      }
      case 'link': {
        const l = this.map.links![it.link];
        const a = placedPos(this.map, l.a);
        const far = dist2(a, p.pos) <= USE_RANGE ** 2 && Math.abs(a.y - p.pos.y) < 1.2 ? placedPos(this.map, l.b) : a;
        const to = s.players.filter((o) => o !== p && o.status === 'alive' && dist2(o.pos, far) <= LINK_RANGE ** 2 && Math.abs(o.pos.y - far.y) < 1.2);
        // Nobody at the other end to catch it: no charge.
        if (!to.length) return void this.events.push({ type: 'denied', pid: p.id });
        if (!this.pay(p, it.cost)) return;
        for (const o of to) for (const w of o.weapons) w.reserve = WEAPONS[w.id].reserve;
        this.events.push({ type: 'link', pid: p.id, to: it.link });
        return;
      }
      case 'secret':
        s.secret.spots = s.secret.spots.filter((i) => i !== it.spot);
        s.secret.carried[p.id] = (s.secret.carried[p.id] ?? 0) + 1;
        this.events.push({ type: 'secret', pid: p.id, placed: s.secret.placed });
        return;
      case 'shelter': {
        const carried = s.secret.carried[p.id] ?? 0;
        if (carried) {
          s.secret.placed += carried;
          s.secret.carried[p.id] = 0;
          this.events.push({ type: 'secret', pid: p.id, placed: s.secret.placed });
        } else if (it.weapon) {
          this.give(p, it.weapon);
          s.secret.claimed.push(p.id);
          this.events.push({ type: 'buy', pid: p.id, what: it.weapon });
        }
        return;
      }
      case 'slide': {
        const st = this.map.stairs[it.stair];
        const fi = floorIndex(this.map, st.floor);
        const [dx, dz] = DIRS[st.up];
        const prog = (c: [number, number]) => c[0] * dx + c[1] * dz;
        const lo = Math.min(...st.cells.map(prog));
        // Land on the bottom step in the lane nearest the player.
        const bottom = st.cells.filter((c) => prog(c) === lo).map(([x, z]) => cellCenter(this.map, fi, x, z));
        const lane = (q: V3) => (dx ? q.z - p.pos.z : q.x - p.pos.x) ** 2;
        const to = bottom.sort((a, b) => lane(a) - lane(b))[0];
        p.slide = { t: SLIDE_TIME, from: copy(p.pos), to: v(to.x, to.y + 0.3, to.z) };
        p.reloadT = 0;
        this.events.push({ type: 'slide', pid: p.id });
        return;
      }
    }
  }

  /** Once all the secret items are in, the weapon the shelter is showing this player right now. */
  private shelterOffer(p: Player): WeaponId | null {
    const sec = this.state.secret;
    if (!this.map.secret || sec.placed < this.map.secret.count || sec.claimed.includes(p.id) || sec.carried[p.id]) return null;
    const pool = (Object.keys(WEAPONS) as WeaponId[]).filter((id) => WEAPONS[id].boxWeight > 0 && id !== 'zapper' && !p.weapons.some((w) => w.id === id));
    return pool[Math.floor((this.state.tick * TICK) / SHELTER_CYCLE) % pool.length] ?? null;
  }

  private shelterLabel(p: Player) {
    const sec = this.state.secret;
    const n = sec.carried[p.id] ?? 0;
    const offer = this.shelterOffer(p);
    if (n) return `Put ${n === 1 ? 'the ration book' : `${n} ration books`} in the shelter`;
    if (offer) return `Take the ${WEAPONS[offer].name} from the Anderson shelter`;
    if (sec.claimed.includes(p.id)) return 'The Anderson shelter is empty';
    return `A locked hatch: ${sec.placed} of ${this.map.secret!.count} ration books`;
  }

  private doorAt(fi: number, x: number, z: number) {
    return this.map.doors.some((d) => !this.state.doors[d.id] && floorIndex(this.map, d.floor) === fi && d.cells.some((c) => c[0] === x && c[1] === z));
  }

  private updateTraps() {
    const s = this.state;
    for (const t of this.map.traps ?? []) {
      const ts = s.traps[t.id];
      ts.cd = Math.max(0, ts.cd - TICK);
      if (ts.fuse <= 0) continue;
      ts.fuse -= TICK;
      if (ts.fuse > 1e-9) continue;
      ts.fuse = 0;
      this.events.push({ type: 'trap', id: t.id, fire: true });
      const b = { min: v3(t.box.min), max: v3(t.box.max) };
      for (const z of [...s.zombies]) {
        if (!pointInBox(v(z.pos.x, z.pos.y + 0.5, z.pos.z), b)) continue;
        this.removeZombie(z);
        this.events.push({ type: 'kill', zid: z.id, pos: copy(z.pos), head: false, pid: '' });
      }
      for (const p of s.players) if (p.status === 'alive' && pointInBox(v(p.pos.x, p.pos.y + 0.5, p.pos.z), b)) this.hurtPlayer(p, t.playerDamage);
    }
  }

  private give(p: Player, id: WeaponId) {
    const def = WEAPONS[id];
    const has = p.weapons.find((w) => w.id === id);
    if (has) {
      has.reserve = def.reserve;
      return;
    }
    const w = { id, mag: def.mag, reserve: def.reserve };
    if (p.weapons.length < 2) {
      p.weapons.push(w);
      p.cur = p.weapons.length - 1;
    } else p.weapons[p.cur] = w;
    p.reloadT = 0;
    p.fireCD = 0.4;
  }

  private rebuild(p: Player, id: string) {
    const w = this.state.windows[id];
    if (w.boards >= maxBoards(this.map.windows.find((x) => x.id === id)!)) return;
    w.boards++;
    p.stats.boards++;
    this.events.push({ type: 'board', window: id, boards: w.boards, torn: false });
    if (p.boardPts < BOARD_POINTS_CAP) {
      p.boardPts += 10;
      this.award(p, 10);
    }
  }

  // ---------------------------------------------------------------- rounds and zombies

  private updateRound() {
    const s = this.state;
    if (s.phase === 'break') {
      s.phaseT -= TICK;
      if (s.phaseT > 0) return;
      s.round++;
      s.phase = 'active';
      s.toSpawn = zombieCount(s.round, this.activeCount());
      s.spawnT = 1;
      s.drops = 0;
      s.players.forEach((p, i) => {
        p.boardPts = 0;
        if (p.connected && (p.status === 'dead' || p.status === 'away')) this.respawn(p, i);
      });
      this.events.push({ type: 'roundStart', round: s.round });
      return;
    }
    if (s.toSpawn > 0) {
      s.spawnT -= TICK;
      if (s.spawnT <= 0 && s.zombies.length < MAX_ALIVE) {
        this.spawnZombie();
        s.spawnT = spawnInterval(s.round);
      }
    } else if (!s.zombies.length) {
      s.phase = 'break';
      s.phaseT = 10;
      this.events.push({ type: 'roundEnd', round: s.round });
    }
  }

  activeWindows() {
    return this.map.windows.filter((w) => this.state.zones[w.zone]);
  }

  spawnZombie(windowId?: string) {
    const s = this.state;
    const wins = this.activeWindows();
    const w = windowId ? this.map.windows.find((x) => x.id === windowId)! : wins[Math.floor(this.rand() * wins.length)];
    let pos: V3;
    if (w.spawns?.length) pos = v3(w.spawns[Math.floor(this.rand() * w.spawns.length)]);
    else {
      const g = windowGeom(this.map, w);
      const [dx, dz] = facingDir(w.facing);
      const side = (this.rand() - 0.5) * 3;
      pos = v(g.spawn.x + dz * side, g.spawn.y, g.spawn.z + dx * side);
    }
    const z: Zombie = {
      id: s.nextId++,
      pos,
      vy: 0,
      onGround: true,
      yaw: 0,
      hp: Math.round(zombieHp(Math.max(1, s.round)) * hpScale(this.activeCount())),
      run: this.rand() < runChance(s.round),
      state: 'approach',
      window: w.id,
      from: copy(pos),
      leg: 0,
      t: 0,
      attackT: 0,
      attackCD: 0,
      node: -1,
    };
    s.zombies.push(z);
    s.toSpawn = Math.max(0, s.toSpawn - 1);
    this.events.push({ type: 'spawn', zid: z.id });
    return z;
  }

  /** Each player's path field depends only on their last nav cell (kept in state) and the doors, so a restored snapshot rebuilds the same field. */
  private updateFlows() {
    for (const p of this.state.players) {
      const n = this.world.nodeAt(p.pos);
      if (n >= 0) p.flowNode = n;
      const f = this.flows.get(p.id);
      if (!f || f.node !== p.flowNode) this.flows.set(p.id, { field: this.world.flow(p.flowNode), node: p.flowNode });
    }
  }

  private updateZombie(z: Zombie) {
    const s = this.state;
    const speed = z.run ? 3.0 : 1.3;
    const win = this.map.windows.find((w) => w.id === z.window)!;
    const g = windowGeom(this.map, win);
    const ws = s.windows[z.window];
    z.attackCD -= TICK;

    if (z.state === 'approach') {
      const path = g.path;
      const to = path[z.leg];
      const from = z.leg > 0 ? path[z.leg - 1] : z.from;
      const climb = Math.abs(to.y - from.y) > Math.hypot(to.x - from.x, to.z - from.z);
      const pace = climb ? CLIMB_SPEED : speed;
      const dx = to.x - z.pos.x, dy = to.y - z.pos.y, dz = to.z - z.pos.z;
      const d = Math.hypot(dx, dy, dz);
      const st = Math.min(d, pace * TICK);
      if (win.facing === 'up') {
        let left = d;
        for (let i = z.leg + 1; i < path.length; i++) left += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y, path[i].z - path[i - 1].z);
        if (left / pace > ROOF_WARNING && (left - st) / pace <= ROOF_WARNING) this.events.push({ type: 'roof', zid: z.id });
      }
      if (d > 1e-6) {
        z.pos.x += (dx / d) * st;
        z.pos.y += (dy / d) * st;
        z.pos.z += (dz / d) * st;
        if (!climb) z.yaw = Math.atan2(-dx, -dz);
      }
      if (z.leg < path.length - 1) { if (st >= d) z.leg++; }
      else if (d < 0.6) z.state = 'tear';
      return;
    }
    if (z.state === 'tear') {
      if (win.facing !== 'up') {
        const [fx, fz] = DIRS[win.facing];
        z.yaw = Math.atan2(fx, fz);
      }
      if (ws.boards > 0) {
        if (ws.tearer < 0 || !s.zombies.some((o) => o.id === ws.tearer && o.state === 'tear')) { ws.tearer = z.id; ws.tearT = 0; }
        if (ws.tearer !== z.id) return;
        ws.tearT += TICK;
        if (ws.tearT >= TEAR_TIME) {
          ws.tearT = 0;
          ws.boards--;
          this.events.push({ type: 'board', window: z.window, boards: ws.boards, torn: true });
        }
        return;
      }
      if (ws.tearer === z.id) ws.tearer = -1;
      z.state = 'climb';
      z.from = copy(z.pos);
      z.t = 0;
      this.events.push({ type: 'climb', zid: z.id });
      return;
    }
    if (z.state === 'climb') {
      z.t += TICK;
      const k = Math.min(1, z.t);
      z.pos.x = z.from.x + (g.inside.x - z.from.x) * k;
      z.pos.z = z.from.z + (g.inside.z - z.from.z) * k;
      z.pos.y = z.from.y + (g.inside.y - z.from.y) * k + Math.sin(Math.PI * k) * 0.7;
      if (k >= 1) {
        z.state = 'hunt';
        z.vy = 0;
        z.node = this.world.nodeAt(z.pos);
      }
      return;
    }

    // hunt
    const n = this.world.nodeAt(z.pos);
    if (n >= 0) z.node = n;
    let target: Player | null = null;
    let best = Infinity;
    for (const p of s.players) {
      if (p.status !== 'alive' || !p.connected) continue;
      const f = this.flows.get(p.id);
      const d = f && z.node >= 0 ? f.field[z.node] : Infinity;
      const cost = Number.isFinite(d) ? d : 1e6 + Math.sqrt(dist2(p.pos, z.pos));
      if (cost < best) { best = cost; target = p; }
    }
    if (!target) return;
    const close = dist2(target.pos, z.pos) < 1.5 * 1.5 && Math.abs(target.pos.y - z.pos.y) < 1.2;
    let goal = target.pos;
    const field = this.flows.get(target.id)?.field;
    if (!close && field && z.node >= 0 && Number.isFinite(field[z.node])) {
      let nb = -1;
      let nd = field[z.node];
      for (const [m, c] of this.world.edges[z.node]) if (field[m] + c < nd + 1e-9 && (nb < 0 || field[m] + c < nd)) { nb = m; nd = field[m] + c; }
      if (nb >= 0) goal = this.world.nodePos(nb);
    }
    let dx = goal.x - z.pos.x;
    let dz = goal.z - z.pos.z;
    const d = Math.hypot(dx, dz);
    const reach = dist2(target.pos, z.pos) < 0.85 * 0.85 && Math.abs(target.pos.y - z.pos.y) < 1.2;
    if (d > 1e-6) z.yaw = Math.atan2(-dx, -dz);
    if (reach || d < 1e-6) { dx = 0; dz = 0; }
    else { dx = (dx / d) * speed * TICK; dz = (dz / d) * speed * TICK; }
    if (z.attackT > 0) { dx *= 0.3; dz *= 0.3; }
    moveBody(z, dx, dz, TICK, ZOMBIE_HW, ZOMBIE_H, this.world.body());
    if (z.pos.y < -20) this.removeZombie(z);

    const inRange = (r: number) => dist2(target!.pos, z.pos) < r * r && Math.abs(target!.pos.y - z.pos.y) < 1.4;
    if (z.attackT > 0) {
      z.attackT += TICK;
      if (z.attackT >= 0.5) {
        z.attackT = 0;
        z.attackCD = 1;
        if (inRange(1.4)) this.hurtPlayer(target, ZOMBIE_DAMAGE);
      }
    } else if (z.attackCD <= 0 && inRange(1.1)) {
      z.attackT = TICK;
      this.events.push({ type: 'zombieAttack', zid: z.id });
    }
  }

  private separate() {
    const zs = this.state.zombies.filter((z) => z.state !== 'climb');
    for (let i = 0; i < zs.length; i++)
      for (let j = i + 1; j < zs.length; j++) {
        const a = zs[i], b = zs[j];
        if (Math.abs(a.pos.y - b.pos.y) > 1) continue;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const d = Math.hypot(dx, dz);
        if (d >= 0.6 || d < 1e-6) continue;
        const push = (0.6 - d) / 2;
        for (const [z, sgn] of [[a, -1], [b, 1]] as const) {
          const mx = (dx / d) * push * sgn, mz = (dz / d) * push * sgn;
          if (z.state === 'hunt') moveBody({ pos: z.pos, vy: 0, onGround: z.onGround }, mx, mz, 0, ZOMBIE_HW, ZOMBIE_H, this.world.body());
          else { z.pos.x += mx * 0.5; z.pos.z += mz * 0.5; }
        }
      }
  }

  private updateProjectiles() {
    const s = this.state;
    for (const pr of [...s.projectiles]) {
      pr.t += TICK;
      const step = v(pr.vel.x * TICK, pr.vel.y * TICK, pr.vel.z * TICK);
      let t = rayWorld(pr.pos, step, 1, this.world.ray());
      for (const z of s.zombies) for (const b of zombieBoxes(z)) t = Math.min(t, rayBox(pr.pos, step, b));
      if (t < 1 || pr.t > 3) {
        const at = v(pr.pos.x + step.x * Math.min(t, 1), pr.pos.y + step.y * Math.min(t, 1), pr.pos.z + step.z * Math.min(t, 1));
        s.projectiles = s.projectiles.filter((o) => o !== pr);
        this.explode(pr.pid, pr.weapon, at);
      } else {
        pr.pos.x += step.x;
        pr.pos.y += step.y;
        pr.pos.z += step.z;
      }
    }
  }

  private explode(pid: string, weapon: WeaponId, at: V3) {
    const def = WEAPONS[weapon];
    const p = this.player(pid);
    this.events.push({ type: 'explode', pos: at, radius: def.splash });
    if (!p) return;
    for (const z of [...this.state.zombies]) {
      const c = v(z.pos.x, z.pos.y + 1, z.pos.z);
      if ((c.x - at.x) ** 2 + (c.y - at.y) ** 2 + (c.z - at.z) ** 2 <= def.splash ** 2) this.hurtZombie(z, def.damage, p, 'blast');
    }
  }

  private updatePowerups() {
    const s = this.state;
    for (const pu of [...s.powerups]) {
      pu.t -= TICK;
      const taker = s.players.find((p) => p.status === 'alive' && p.connected && dist2(p.pos, pu.pos) < 1.2 * 1.2 && Math.abs(p.pos.y + 0.6 - pu.pos.y) < 1.5);
      if (!taker && pu.t > 0) continue;
      s.powerups = s.powerups.filter((o) => o !== pu);
      if (taker) this.applyPowerup(pu.id, pu.kind);
    }
  }

  applyPowerup(id: number, kind: PowerupKind) {
    const s = this.state;
    this.events.push({ type: 'powerup', id, kind });
    if (kind === 'maxAmmo') for (const p of s.players) for (const w of p.weapons) w.reserve = WEAPONS[w.id].reserve;
    if (kind === 'instaKill') s.instaKill = EFFECT_TIME;
    if (kind === 'doublePoints') s.doublePoints = EFFECT_TIME;
    if (kind === 'nuke') {
      for (const z of [...s.zombies]) {
        this.removeZombie(z);
        this.events.push({ type: 'kill', zid: z.id, pos: copy(z.pos), head: false, pid: '' });
      }
      for (const p of s.players) if (p.status !== 'left') this.award(p, 400);
    }
  }

  private updateBox() {
    const s = this.state;
    const b = s.box;
    if (b.phase === 'idle') return;
    b.t += TICK;
    if (b.phase === 'rolling' && b.t >= 4) {
      b.uses++;
      const p = this.player(b.pid!);
      if (b.uses >= b.moveAt) {
        if (p) p.points += BOX_COST;
        const others = this.map.boxSpots.map((_, i) => i).filter((i) => i !== b.spot && s.zones[this.map.boxSpots[i].zone]);
        if (others.length) b.spot = others[Math.floor(this.rand() * others.length)];
        Object.assign(b, { phase: 'idle', t: 0, uses: 0, moveAt: 4 + Math.floor(this.rand() * 5), pid: null, weapon: null });
        this.world.update(s.doors, b.spot);
        this.events.push({ type: 'boxMove', spot: b.spot });
        return;
      }
      b.weapon = this.rollWeapon(p);
      b.phase = 'offer';
      b.t = 0;
      this.events.push({ type: 'boxOffer', weapon: b.weapon });
    } else if (b.phase === 'offer' && b.t >= 8) {
      Object.assign(b, { phase: 'idle', t: 0, weapon: null, pid: null });
    }
  }

  private rollWeapon(p: Player | undefined): WeaponId {
    const pool = (Object.keys(WEAPONS) as WeaponId[]).filter((id) => WEAPONS[id].boxWeight > 0 && !p?.weapons.some((w) => w.id === id));
    const total = pool.reduce((a, id) => a + WEAPONS[id].boxWeight, 0);
    let r = this.rand() * total;
    for (const id of pool) if ((r -= WEAPONS[id].boxWeight) < 0) return id;
    return pool[pool.length - 1];
  }
}

function newPlayer(id: string): Player {
  return {
    id,
    pos: { x: 0, y: 0, z: 0 },
    vy: 0,
    onGround: true,
    yaw: 0,
    pitch: 0,
    hp: 100,
    maxHp: 100,
    points: 500,
    weapons: [{ id: 'p9', mag: WEAPONS.p9.mag, reserve: WEAPONS.p9.reserve }],
    cur: 0,
    reloadT: 0,
    fireCD: 0,
    meleeCD: 0,
    perks: [],
    melee: 'knife',
    slide: null,
    status: 'alive',
    connected: true,
    graceT: 0,
    bleedT: 0,
    holdId: '',
    hurtT: 99,
    useT: 0,
    boardPts: 0,
    prev: { fire: false, use: false, swap: false, reload: false, melee: false },
    stats: { kills: 0, headshots: 0, earned: 0, boards: 0 },
    flowNode: -1,
  };
}

/** One tick of player movement. The server sim and client prediction both use this, so they move the same way. */
export function movePlayer(p: Pick<Player, 'pos' | 'vy' | 'onGround' | 'yaw' | 'pitch'>, c: Command, world: World, down = false) {
  p.yaw = c.yaw;
  p.pitch = Math.max(-1.5, Math.min(1.5, c.pitch));
  let f = c.fwd;
  let r = c.strafe;
  const len = Math.hypot(f, r);
  if (len > 1) { f /= len; r /= len; }
  const speed = (down ? CRAWL : c.sprint && f > 0 ? SPRINT : WALK) * TICK;
  const sin = Math.sin(p.yaw);
  const cos = Math.cos(p.yaw);
  moveBody(p, (-sin * f + cos * r) * speed, (-cos * f - sin * r) * speed, TICK, PLAYER_HW, PLAYER_H, world.body());
}

export function zombieBoxes(z: Zombie): [Box, Box] {
  const { x, y, z: zz } = z.pos;
  return [box(x - 0.3, y, zz - 0.3, x + 0.3, y + 1.45, zz + 0.3), box(x - 0.18, y + 1.45, zz - 0.18, x + 0.18, y + 1.8, zz + 0.18)];
}
