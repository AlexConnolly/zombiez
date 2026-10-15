import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapById } from '../maps';
import { NO_INPUT } from '../sim/game';
import { MAX_PLAYERS, PartyGuest, PartyHost, newCode, type Room } from './party';

/** A fake network: every peer's messages are queued and delivered on flush, and fast packets can be dropped. */
class Hub {
  rooms = new Map<string, Room>();
  queue: (() => void)[] = [];
  loss = 0;
  private n = 0;
  private rnd = 1;

  join(): Room {
    const id = `peer${++this.n}`;
    const room: Room = {
      onPeerJoin: () => {}, onPeerLeave: () => {}, onCtl: () => {}, onFast: () => {},
      sendCtl: (m, to) => this.deliver(id, to, (r) => r.onCtl(structuredClone(m), id)),
      sendFast: (m, to) => {
        this.rnd = (this.rnd * 16807) % 2147483647;
        if (this.rnd / 2147483647 < this.loss) return;
        this.deliver(id, to, (r) => r.onFast(structuredClone(m), id));
      },
      leave: () => {
        this.rooms.delete(id);
        for (const r of this.rooms.values()) this.queue.push(() => r.onPeerLeave(id));
      },
    };
    for (const [other, r] of this.rooms) this.queue.push(() => { r.onPeerJoin(id); room.onPeerJoin(other); });
    this.rooms.set(id, room);
    return room;
  }

  /** Cuts a peer off without a goodbye, as a closed tab does. */
  vanish(room: Room) {
    const id = [...this.rooms].find(([, r]) => r === room)![0];
    this.rooms.delete(id);
    for (const r of this.rooms.values()) this.queue.push(() => r.onPeerLeave(id));
  }

  private deliver(from: string, to: string | undefined, f: (r: Room) => void) {
    for (const [id, r] of this.rooms) if (id !== from && (!to || to === id)) this.queue.push(() => this.rooms.has(id) && f(r));
  }

  flush() {
    for (let i = 0; i < 10000 && this.queue.length; i++) this.queue.shift()!();
  }
}

const maps = (id: string) => mapById(id);
const now = () => Date.now();

describe('party play (peer to peer)', () => {
  let hub: Hub;
  beforeEach(() => { hub = new Hub(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  function party(...guests: string[]) {
    const host = new PartyHost(hub.join(), 'Alex', mapById('campsite'), maps, () => {}, now);
    const gs = guests.map((n) => new PartyGuest(hub.join(), n, maps, () => {}, now));
    hub.flush();
    return { host, gs };
  }

  /** Runs the host's clock and every guest's 30 Hz input for a while. */
  function play(ms: number, gs: PartyGuest[], cmd = NO_INPUT) {
    for (let t = 0; t < ms; t += 33) {
      vi.advanceTimersByTime(33);
      for (const g of gs) g.net?.tick(cmd);
      hub.flush();
    }
  }

  it('room codes are 12 random characters: XXXX-XXXX-XXXX', () => {
    const code = newCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(new Set(Array.from({ length: 200 }, () => newCode())).size).toBe(200);
  });

  it('guests show up in the lobby; a repeated name gets a number', () => {
    const { host, gs } = party('Sam', 'Sam');
    expect(host.names).toEqual(['Alex', 'Sam', 'Sam2']);
    expect(gs[1].you).toBe('Sam2');
    expect(gs[0].names).toEqual(['Alex', 'Sam', 'Sam2']);
    expect(gs[0].map).toBe('campsite');
    host.setMap('townhouse');
    hub.flush();
    expect(gs[1].map).toBe('townhouse');
  });

  it(`a full room (${MAX_PLAYERS} players) turns the next one away`, () => {
    const { host, gs } = party('B', 'C', 'D', 'E');
    expect(host.names).toHaveLength(MAX_PLAYERS);
    expect(gs[3].refused).toBe('full');
  });

  it('start: every guest is welcomed and gets snapshots; events come on the reliable channel', () => {
    const { host, gs } = party('Sam');
    const local = host.start(42);
    hub.flush();
    expect(local.joined).toBe(true);
    expect(gs[0].net?.joined).toBe(true);
    expect(gs[0].net?.you).toBe('Sam');
    play(5000, gs);
    expect(gs[0].net!.sim.state.round).toBe(1);
    expect(gs[0].net!.drainEvents()).toContainEqual({ type: 'roundStart', round: 1 });
  });

  it('a guest moves on the host by sending inputs over the fast channel', () => {
    const { host, gs } = party('Sam');
    host.start(42);
    hub.flush();
    const sam = host.match!.sim.player('Sam')!;
    const from = { ...sam.pos };
    play(1000, gs, { ...NO_INPUT, fwd: 1 });
    expect(Math.hypot(sam.pos.x - from.x, sam.pos.z - from.z)).toBeGreaterThan(2);
  });

  it('with 20% of fast packets lost, the guest still follows the game', () => {
    const { host, gs } = party('Sam');
    host.start(42);
    hub.flush();
    hub.loss = 0.2;
    play(6000, gs, { ...NO_INPUT, fwd: 1 });
    const there = host.match!.sim.player('Sam')!.pos;
    const here = gs[0].net!.predicted()!;
    expect(gs[0].net!.sim.state.round).toBe(host.match!.sim.state.round);
    expect(Math.hypot(here.x - there.x, here.z - there.z)).toBeLessThan(1.5);
  });

  it('a guest who leaves is out; one who drops can come back to the same seat', () => {
    const { host, gs } = party('Sam', 'Kim');
    host.start(42);
    hub.flush();
    gs[0].close();
    hub.flush();
    expect(host.match!.sim.player('Sam')!.status).toBe('left');

    hub.vanish(gs[1].room);
    hub.flush();
    expect(host.match!.sim.player('Kim')!.connected).toBe(false);
    const back = new PartyGuest(hub.join(), 'Kim', maps, () => {}, now);
    hub.flush();
    expect(back.net?.joined).toBe(true);
    expect(host.match!.sim.player('Kim')!.connected).toBe(true);
  });

  it('strangers cannot join a running game', () => {
    const { host } = party('Sam');
    host.start(42);
    hub.flush();
    const late = new PartyGuest(hub.join(), 'Bob', maps, () => {}, now);
    hub.flush();
    expect(late.refused).toBe('started');
  });

  it('when the host leaves, guests are told', () => {
    const { host, gs } = party('Sam');
    host.start(42);
    hub.flush();
    host.close();
    hub.flush();
    expect(gs[0].hostLeft).toBe(true);
  });
});
