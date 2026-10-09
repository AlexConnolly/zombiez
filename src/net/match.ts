import { NO_INPUT, Sim, type Command, type GameEvent } from '../sim/game';
import type { MapDef } from '../sim/map';
import { PROTOCOL, encodeSnap, type ClientMsg, type ServerMsg } from './protocol';

/** At most this many inputs are applied per tick, so late inputs catch up but a client can never move faster. */
const PER_TICK = 3;
/** Inputs queued beyond this are dropped, oldest first. */
const MAX_QUEUE = 10;

interface Seat {
  send: (m: ServerMsg) => void;
  queue: { seq: number; cmd: Command }[];
  lastSeq: number;
  acked: number;
  last: Command;
  pingAt: number;
  rtt: number;
  /** Inputs the player may still apply: +1 per tick, so catching up after a stall works but over time nobody moves faster than real time. */
  budget: number;
}

/**
 * One running game on the server. Transport-agnostic: the caller passes a send function per player
 * and calls tick() 30 times a second. The sim inside is the only authority.
 */
export class Match {
  readonly sim: Sim;
  private seats = new Map<string, Seat>();
  private events: GameEvent[] = [];
  private pingId = 0;
  ended = false;

  constructor(
    readonly id: string,
    readonly map: MapDef,
    seed: number,
    players: string[],
    /** Dev matches let anyone join by name; lobby matches only admit their own players. */
    private open = false,
    private now: () => number = () => performance.now(),
  ) {
    this.sim = new Sim(map, seed, players);
  }

  /** A player connects or reconnects. Returns false if they may not join. */
  join(pid: string, send: (m: ServerMsg) => void, version = PROTOCOL): boolean {
    if (version !== PROTOCOL) {
      send({ t: 'error', reason: 'version' });
      return false;
    }
    let p = this.sim.player(pid);
    if (!p && this.open && this.sim.state.phase !== 'over') {
      this.sim.addPlayer(pid);
      p = this.sim.player(pid);
    }
    if (!p || p.status === 'left' || this.ended) {
      send({ t: 'error', reason: 'not in match' });
      return false;
    }
    if (!p.connected) this.sim.connect(pid);
    const old = this.seats.get(pid);
    const seat: Seat = { send, queue: [], lastSeq: old?.lastSeq ?? 0, acked: old?.acked ?? 0, last: { ...NO_INPUT, yaw: p.yaw, pitch: p.pitch }, pingAt: 0, rtt: 0, budget: PER_TICK };
    this.seats.set(pid, seat);
    send({ t: 'welcome', you: pid, map: this.map.id, seed: this.sim.state.seed, snap: encodeSnap(this.sim.state, this.map, seat.acked, []) });
    return true;
  }

  receive(pid: string, m: ClientMsg) {
    const seat = this.seats.get(pid);
    if (!seat) return;
    if (m.t === 'input') {
      if (!Array.isArray(m.inputs)) return;
      for (const i of m.inputs.slice(-10)) {
        if (typeof i?.seq !== 'number' || i.seq <= seat.lastSeq || typeof i.cmd !== 'object' || !i.cmd) continue;
        seat.lastSeq = i.seq;
        seat.queue.push({ seq: i.seq, cmd: sanitize(i.cmd) });
      }
      while (seat.queue.length > MAX_QUEUE) seat.queue.shift();
    } else if (m.t === 'pong') {
      if (m.id === this.pingId) seat.rtt = this.now() - seat.pingAt;
    } else if (m.t === 'leave') {
      this.seats.delete(pid);
      this.sim.leave(pid);
    }
  }

  /** The socket closed without a goodbye: start the reconnect grace period. */
  drop(pid: string, send?: (m: ServerMsg) => void) {
    const seat = this.seats.get(pid);
    // A newer connection for the same player may already have replaced this one.
    if (!seat || (send && seat.send !== send)) return;
    this.seats.delete(pid);
    this.sim.disconnect(pid);
  }

  tick() {
    if (this.ended) return;
    const cmds: Record<string, Command> = {};
    for (const [pid, seat] of this.seats) {
      seat.budget = Math.min(seat.budget + 1, MAX_QUEUE);
      const batch = seat.queue.splice(0, Math.min(PER_TICK, Math.floor(seat.budget)));
      seat.budget -= batch.length;
      if (!batch.length) {
        // Nothing arrived this tick: hold still with buttons as they were. Late inputs catch up next tick.
        cmds[pid] = { ...seat.last, fwd: 0, strafe: 0, sprint: false };
        continue;
      }
      for (const extra of batch.slice(0, -1)) this.sim.extraMove(pid, extra.cmd);
      const last = batch[batch.length - 1].cmd;
      const held = (k: 'fire' | 'use' | 'reload' | 'swap' | 'melee') => batch.some((b) => b.cmd[k]);
      seat.last = { ...last, fire: held('fire'), use: held('use'), reload: held('reload'), swap: held('swap'), melee: held('melee') };
      seat.acked = batch[batch.length - 1].seq;
      cmds[pid] = seat.last;
    }
    this.events.push(...this.sim.step(cmds));
    const s = this.sim.state;
    // 20 Hz: snapshots on 2 of every 3 ticks.
    if (s.tick % 3 !== 0 || s.phase === 'over') {
      for (const seat of this.seats.values()) seat.send({ t: 'snap', snap: encodeSnap(s, this.map, seat.acked, this.events) });
      this.events = [];
    }
    if (s.tick % 30 === 0) {
      this.pingId++;
      for (const seat of this.seats.values()) {
        seat.pingAt = this.now();
        seat.send({ t: 'ping', id: this.pingId });
      }
    }
    if (s.phase === 'over') {
      this.ended = true;
      const end: ServerMsg = { t: 'end', round: s.round, stats: Object.fromEntries(s.players.map((p) => [p.id, p.stats])) };
      for (const seat of this.seats.values()) seat.send(end);
    }
  }

  rtt(pid: string) {
    return this.seats.get(pid)?.rtt ?? 0;
  }

  connected() {
    return this.seats.size;
  }
}

/** Clamp everything a client sends; the server never trusts input ranges. */
function sanitize(c: Command): Command {
  const num = (n: unknown, lo: number, hi: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0);
  return {
    fwd: num(c.fwd, -1, 1),
    strafe: num(c.strafe, -1, 1),
    yaw: num(c.yaw, -1e6, 1e6),
    pitch: num(c.pitch, -1.5, 1.5),
    sprint: !!c.sprint,
    fire: !!c.fire,
    use: !!c.use,
    reload: !!c.reload,
    swap: !!c.swap,
    melee: !!c.melee,
    view: typeof c.view === 'number' && Number.isFinite(c.view) ? c.view : undefined,
  };
}
