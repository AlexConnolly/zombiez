import { EYE, Sim, TICK, movePlayer, zombieBoxes, type Command, type GameEvent } from '../sim/game';
import type { MapDef, V3 } from '../sim/map';
import { rayBox, rayWorld } from '../sim/physics';
import { WEAPONS } from '../sim/weapons';
import { PROTOCOL, applySnap, type ClientMsg, type ServerMsg, type Snap } from './protocol';

const TICK_MS = TICK * 1000;
/** Inputs repeated in every packet, so one late or lost packet costs nothing. */
const REDUNDANCY = 3;
/** Interpolation delay bounds, in ticks: 100 ms to 200 ms. */
const MIN_DELAY = 3;
const MAX_DELAY = 6;
/** Extrapolate at most this far past the newest snapshot, then hold. */
const MAX_EXTRAPOLATE = 3;
/** Visual corrections above this snap instead of blending. */
const SNAP_DISTANCE = 1;
const BLEND_SECONDS = 0.1;
/** Others ease toward their interpolated spot over ~50 ms, so a late packet never shows as a jump. */
const EASE_SECONDS = 0.05;
/** Further than this and the entity really moved (respawn, climb in): place it at once. */
const TELEPORT = 3;

type Body = { pos: V3; vy: number; onGround: boolean; yaw: number; pitch: number };
type Frame = { tick: number; zombies: Map<number, [number, number, number, number]>; players: Map<string, [number, number, number, number]> };

/**
 * The online side of the client: sends inputs, predicts the local player, reconciles with the server,
 * and interpolates everyone else. It owns a local Sim used only as a view (state written from snapshots)
 * plus the world geometry for prediction. No DOM, so bots and tests use it too.
 */
export class NetClient {
  readonly sim: Sim;
  you = '';
  joined = false;
  ended: Extract<ServerMsg, { t: 'end' }> | null = null;
  error = '';
  /** Server events plus locally predicted ones, drained by the renderer each frame. */
  events: GameEvent[] = [];
  /** Largest visual correction seen; tests read this to prove prediction stays smooth. */
  maxCorrection = 0;

  private seq = 0;
  private pending: { seq: number; cmd: Command }[] = [];
  private frames: Frame[] = [];
  private offset = 0;
  private jitter = 0;
  private synced = false;
  private body: Body | null = null;
  private smooth = { x: 0, y: 0, z: 0 };
  private fireCD = 0;
  private prevFire = false;
  private prevMelee = false;
  private shots: number[] = [];
  private ack = 0;
  private lastCmd: Command | null = null;
  private shown = new Map<string | number, V3>();

  constructor(
    readonly map: MapDef,
    /** Swapped for a new socket on reconnect. */
    public send: (m: ClientMsg) => void,
    private now: () => number,
  ) {
    this.sim = new Sim(map, 0, []);
  }

  join(match: string, token: string) {
    this.send({ t: 'join', v: PROTOCOL, match, token });
  }

  leave() {
    this.send({ t: 'leave' });
  }

  me() {
    return this.sim.player(this.you);
  }

  receive(m: ServerMsg) {
    switch (m.t) {
      case 'welcome':
        this.you = m.you;
        this.joined = true;
        this.synced = false;
        this.frames = [];
        this.pending = [];
        this.body = null;
        this.onSnap(m.snap);
        return;
      case 'snap':
        this.onSnap(m.snap);
        return;
      case 'ping':
        this.send({ t: 'pong', id: m.id });
        return;
      case 'end':
        this.ended = m;
        return;
      case 'error':
        this.error = m.reason;
        return;
    }
  }

  private localTicks() {
    return this.now() / TICK_MS;
  }

  /** Best guess of the newest server tick we could have received by now. */
  serverTick() {
    return this.localTicks() + this.offset;
  }

  /** Server tick other entities are drawn at: far enough back to always have two snapshots around it. */
  renderTick() {
    const delay = Math.min(MAX_DELAY, Math.max(MIN_DELAY, 1.5 + 2 * this.jitter));
    return this.serverTick() - delay;
  }

  private onSnap(n: Snap) {
    const est = n.tick - this.localTicks();
    if (!this.synced || Math.abs(est - this.offset) > 10) {
      this.offset = est;
      this.synced = true;
    } else {
      const d = est - this.offset;
      this.jitter = this.jitter * 0.9 + Math.abs(d) * 0.1;
      // Only drift forwards slowly; late packets should not drag the clock back.
      this.offset += d > 0 ? d * 0.1 : d * 0.02;
    }

    const doorsChanged = JSON.stringify(n.doors) !== JSON.stringify(this.sim.state.doors) || n.box.spot !== this.sim.state.box.spot;
    applySnap(this.sim.state, this.map, n);
    if (doorsChanged) this.sim.world.update(n.doors, n.box.spot);

    this.frames.push({
      tick: n.tick,
      zombies: new Map(n.zombies.map((z) => [z[0], [z[1], z[2], z[3], z[4]]])),
      players: new Map(n.players.map((p) => [p.id, [p.pos.x, p.pos.y, p.pos.z, p.yaw]])),
    });
    if (this.frames.length > 30) this.frames.shift();

    this.addEvents(n.events);

    this.ack = n.ack;
    this.reconcile();
  }

  /** Server events, from a snapshot or sent on their own. */
  addEvents(evs: GameEvent[]) {
    for (const e of evs) {
      // Our own shots and swings were already shown when we pressed the button.
      if ((e.type === 'shot' || e.type === 'melee') && e.pid === this.you) continue;
      this.events.push(e);
    }
  }

  /** Reset to the server's position, then replay every input it has not applied yet. */
  private reconcile() {
    const me = this.me();
    if (!me) return;
    this.pending = this.pending.filter((p) => p.seq > this.ack);
    this.shots = this.shots.filter((s) => s > this.ack);
    const before = this.body && { ...this.body.pos };
    this.body = { pos: { ...me.pos }, vy: me.vy, onGround: me.onGround, yaw: me.yaw, pitch: me.pitch };
    if (!me.slide && (me.status === 'alive' || me.status === 'down'))
      for (const p of this.pending) movePlayer(this.body, p.cmd, this.sim.world, me.status === 'down');
    if (!before) return;
    const dx = before.x - this.body.pos.x, dy = before.y - this.body.pos.y, dz = before.z - this.body.pos.z;
    const d = Math.hypot(dx, dy, dz);
    this.maxCorrection = Math.max(this.maxCorrection, d);
    if (d > SNAP_DISTANCE) this.smooth = { x: 0, y: 0, z: 0 };
    else { this.smooth.x += dx; this.smooth.y += dy; this.smooth.z += dz; }
  }

  /** One local 30 Hz tick: send the command, predict our movement, show our own shots at once. */
  tick(cmd: Command) {
    if (!this.joined) return;
    const c = { ...cmd, view: this.renderTick() - EASE_SECONDS / TICK };
    this.seq++;
    this.pending.push({ seq: this.seq, cmd: c });
    this.send({ t: 'input', inputs: this.pending.slice(-REDUNDANCY) });
    this.lastCmd = c;
    const me = this.me();
    if (!me || !this.body || (me.status !== 'alive' && me.status !== 'down') || !me.connected) return;
    if (!me.slide) movePlayer(this.body, c, this.sim.world, me.status === 'down');
    this.predictFire(c);
  }

  private predictFire(c: Command) {
    const me = this.me()!;
    this.fireCD -= TICK;
    const w = me.weapons[me.cur];
    const def = WEAPONS[w.id];
    const trigger = def.auto ? c.fire : c.fire && !this.prevFire;
    this.prevFire = c.fire;
    if (c.melee && !this.prevMelee && me.status === 'alive') this.events.push({ type: 'melee', pid: this.you, hit: false });
    this.prevMelee = c.melee;
    if (!trigger || this.fireCD > 0 || me.reloadT > 0 || w.mag - this.shots.length <= 0) return;
    this.fireCD = 1 / def.rate;
    this.shots.push(this.seq);
    const o = { x: this.body!.pos.x, y: this.body!.pos.y + EYE, z: this.body!.pos.z };
    const cp = Math.cos(c.pitch);
    const d = { x: -Math.sin(c.yaw) * cp, y: Math.sin(c.pitch), z: -Math.cos(c.yaw) * cp };
    const ends: V3[] = [];
    if (!def.splash) {
      let t = rayWorld(o, d, 60, this.sim.world.ray());
      for (const z of this.sim.state.zombies) for (const b of zombieBoxes(z)) t = Math.min(t, rayBox(o, d, b));
      ends.push({ x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t });
    }
    this.events.push({ type: 'shot', pid: this.you, weapon: w.id, from: o, ends });
  }

  /** Per render frame: draw others between snapshots and ourselves at the predicted position. */
  frame(dt: number) {
    const s = this.sim.state;
    const rt = this.renderTick();
    const fr = this.frames;
    if (fr.length) {
      let i = fr.findIndex((f) => f.tick > rt);
      let a: Frame, b: Frame, k: number;
      if (i === -1) {
        // Past the newest snapshot: carry on along the last movement for a moment, then hold.
        a = fr[Math.max(0, fr.length - 2)];
        b = fr[fr.length - 1];
        const span = b.tick - a.tick || 1;
        k = 1 + Math.min(rt - b.tick, MAX_EXTRAPOLATE) / span;
      } else if (i === 0) {
        a = b = fr[0];
        k = 0;
      } else {
        a = fr[i - 1];
        b = fr[i];
        k = (rt - a.tick) / (b.tick - a.tick);
      }
      const lerp = (p: number[], q: number[]) => {
        const yaw = p[3] + Math.atan2(Math.sin(q[3] - p[3]), Math.cos(q[3] - p[3])) * k;
        return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k, yaw];
      };
      const ease = 1 - Math.exp(-dt / EASE_SECONDS);
      const place = (key: string | number, x: number, y: number, z: number): V3 => {
        const was = this.shown.get(key);
        const to = was && Math.hypot(x - was.x, y - was.y, z - was.z) < TELEPORT
          ? { x: was.x + (x - was.x) * ease, y: was.y + (y - was.y) * ease, z: was.z + (z - was.z) * ease }
          : { x, y, z };
        this.shown.set(key, to);
        return { ...to };
      };
      const seen = new Set<string | number>();
      for (const z of s.zombies) {
        const p = a.zombies.get(z.id), q = b.zombies.get(z.id);
        if (!p || !q) continue;
        const [x, y, zz, yaw] = lerp(p, q);
        z.pos = place(z.id, x, y, zz);
        z.yaw = yaw;
        seen.add(z.id);
      }
      for (const pl of s.players) {
        if (pl.id === this.you) continue;
        const p = a.players.get(pl.id), q = b.players.get(pl.id);
        if (!p || !q) continue;
        const [x, y, zz, yaw] = lerp(p, q);
        pl.pos = place(pl.id, x, y, zz);
        pl.yaw = yaw;
        seen.add(pl.id);
      }
      for (const k of this.shown.keys()) if (!seen.has(k)) this.shown.delete(k);
    }
    const me = this.me();
    if (me && this.body) {
      const k = Math.exp(-dt / BLEND_SECONDS);
      this.smooth.x *= k;
      this.smooth.y *= k;
      this.smooth.z *= k;
      me.pos = { x: this.body.pos.x + this.smooth.x, y: this.body.pos.y + this.smooth.y, z: this.body.pos.z + this.smooth.z };
      me.onGround = this.body.onGround;
      if (this.lastCmd) { me.yaw = this.lastCmd.yaw; me.pitch = this.lastCmd.pitch; }
    }
  }

  /** The predicted position with no visual blending, for tests. */
  predicted() {
    return this.body?.pos;
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }
}
