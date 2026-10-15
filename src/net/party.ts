import { TICK, type GameEvent } from '../sim/game';
import type { MapDef } from '../sim/map';
import { NetClient } from './client';
import { Match } from './match';
import { PROTOCOL, type ClientMsg, type ServerMsg } from './protocol';

/**
 * Peer-to-peer play with no game server: the host's browser runs the Match, everyone else connects to it.
 * Two channels per peer: a reliable one for the lobby, welcomes and game events, and a fast one
 * (unordered, no retransmits, like UDP) for snapshots and inputs, where a lost packet is just replaced by the next.
 */
export const MAX_PLAYERS = 4;
const TICK_MS = TICK * 1000;

/** What a party room needs from the network. The real one is WebRTC through Trystero; tests use a fake. */
export interface Room {
  onPeerJoin: (peer: string) => void;
  onPeerLeave: (peer: string) => void;
  onCtl: (m: Ctl, peer: string) => void;
  onFast: (m: ServerMsg | ClientMsg, peer: string) => void;
  sendCtl: (m: Ctl, peer?: string) => void;
  sendFast: (m: ServerMsg | ClientMsg, peer: string) => void;
  leave: () => void;
}

export type Ctl =
  | { t: 'hello'; name: string; v: number }
  | { t: 'lobby'; names: string[]; map: string; you: string }
  | { t: 'refused'; reason: 'full' | 'started' | 'version' }
  | { t: 'events'; events: GameEvent[] }
  | { t: 'server'; m: ServerMsg }
  | { t: 'client'; m: ClientMsg };

/** 12 characters from 32 easy-to-read symbols (about 60 bits): far too many to guess a room. */
export function newCode(rand: () => number = Math.random) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const c = Array.from({ length: 12 }, () => abc[Math.floor(rand() * abc.length)]).join('');
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}

export const cleanName = (s: string) => s.replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 12) || 'Player';

/** Runs the lobby and then the match. The host plays through a local NetClient wired straight to the match. */
export class PartyHost {
  names: string[];
  map: MapDef;
  match: Match | null = null;
  local: NetClient | null = null;
  private peers = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly room: Room,
    readonly name: string,
    map: MapDef,
    private maps: (id: string) => MapDef,
    private onChange: () => void,
    private now: () => number = () => performance.now(),
  ) {
    this.names = [name];
    this.map = map;
    room.onPeerJoin = () => {};
    room.onPeerLeave = (peer) => this.peerLeft(peer);
    room.onCtl = (m, peer) => {
      if (m.t === 'hello') this.hello(peer, m);
      else if (m.t === 'client') this.onFast(m.m, peer);
    };
    room.onFast = (m, peer) => this.onFast(m as ClientMsg, peer);
  }

  private onFast(m: ClientMsg, peer: string) {
    const pid = this.peers.get(peer);
    if (!pid || !this.match) return;
    this.match.receive(pid, m);
    if (m.t === 'leave') this.peers.delete(peer);
  }

  private hello(peer: string, m: Extract<Ctl, { t: 'hello' }>) {
    if (m.v !== PROTOCOL) return this.room.sendCtl({ t: 'refused', reason: 'version' }, peer);
    const name = cleanName(m.name);
    // Coming back to a running match under the same name takes the old seat.
    if (this.match) {
      const p = this.match.sim.player(name);
      if (!p || p.connected || p.status === 'left' || [...this.peers.values()].includes(name)) return this.room.sendCtl({ t: 'refused', reason: 'started' }, peer);
      this.peers.set(peer, name);
      this.seat(peer, name);
      return;
    }
    if (this.names.length >= MAX_PLAYERS) return this.room.sendCtl({ t: 'refused', reason: 'full' }, peer);
    let unique = name;
    for (let i = 2; this.names.includes(unique); i++) unique = `${name.slice(0, 10)}${i}`;
    this.peers.set(peer, unique);
    this.names.push(unique);
    this.lobby();
  }

  private peerLeft(peer: string) {
    const pid = this.peers.get(peer);
    if (!pid) return;
    this.peers.delete(peer);
    if (this.match) this.match.drop(pid);
    else this.names = this.names.filter((n) => n !== pid);
    this.lobby();
  }

  setMap(id: string) {
    if (this.match) return;
    this.map = this.maps(id);
    this.lobby();
  }

  private lobby() {
    for (const [peer, you] of this.peers) this.room.sendCtl({ t: 'lobby', names: this.names, map: this.map.id, you }, peer);
    this.onChange();
  }

  /** Starts the match: seats everyone, then ticks it 30 times a second. Returns the host's own client. */
  start(seed = Math.floor(Math.random() * 2 ** 31)) {
    const match = new Match('party', this.map, seed, this.names);
    this.match = match;
    const local = new NetClient(this.map, (m) => match.receive(this.name, m), this.now);
    this.local = local;
    match.join(this.name, (m) => local.receive(m));
    for (const [peer, pid] of this.peers) this.seat(peer, pid);
    let last = this.now();
    // A timer, not animation frames, so the match keeps time while the host's tab is in the background (as far as the browser allows).
    this.timer = setInterval(() => {
      const t = this.now();
      if (t - last > 1000) last = t - TICK_MS;
      for (; t - last >= TICK_MS; last += TICK_MS) match.tick();
      if (match.ended) clearInterval(this.timer);
    }, 5);
    return local;
  }

  private seat(peer: string, pid: string) {
    this.match!.join(pid, (m) => {
      if (m.t !== 'snap') return this.room.sendCtl({ t: 'server', m }, peer);
      // Events go on the reliable channel so a lost snapshot never loses a kill or a door.
      if (m.snap.events.length) this.room.sendCtl({ t: 'events', events: m.snap.events }, peer);
      this.room.sendFast({ t: 'snap', snap: { ...m.snap, events: [] } }, peer);
    });
  }

  close() {
    clearInterval(this.timer);
    this.room.leave();
  }
}

/** A guest: says hello, follows the lobby, then plays through a NetClient made when the welcome arrives. */
export class PartyGuest {
  names: string[] = [];
  map = '';
  you = '';
  refused: Extract<Ctl, { t: 'refused' }>['reason'] | null = null;
  hostLeft = false;
  net: NetClient | null = null;
  private host = '';

  constructor(
    readonly room: Room,
    readonly name: string,
    private maps: (id: string) => MapDef,
    private onChange: () => void,
    private now: () => number = () => performance.now(),
  ) {
    const hello = (peer?: string) => room.sendCtl({ t: 'hello', name, v: PROTOCOL }, peer);
    room.onPeerJoin = (peer) => hello(peer);
    room.onPeerLeave = (peer) => {
      if (peer !== this.host) return;
      this.hostLeft = true;
      this.onChange();
    };
    room.onCtl = (m, peer) => {
      if (m.t === 'lobby') {
        this.host = peer;
        Object.assign(this, { names: m.names, map: m.map, you: m.you });
        this.onChange();
      } else if (m.t === 'refused') {
        this.refused = m.reason;
        this.onChange();
      } else if (peer === this.host || !this.host) {
        if (m.t === 'server') this.server(m.m, peer);
        else if (m.t === 'events') this.net?.addEvents(m.events);
      }
    };
    room.onFast = (m, peer) => { if (peer === this.host && 't' in m && m.t === 'snap') this.net?.receive(m as ServerMsg); };
  }

  private server(m: ServerMsg, peer: string) {
    if (m.t === 'welcome') {
      this.host = peer;
      // A new client per welcome: the first game, or a seat taken back after dropping out.
      // Inputs go fast; leaving and pongs go reliably, so a lost packet never leaves a ghost seat.
      if (!this.net || this.net.map.id !== m.map) this.net = new NetClient(this.maps(m.map), (c) => (c.t === 'input' ? this.room.sendFast(c, this.host) : this.room.sendCtl({ t: 'client', m: c }, this.host)), this.now);
    }
    this.net?.receive(m);
    this.onChange();
  }

  close() {
    this.net?.leave();
    this.room.leave();
  }
}
