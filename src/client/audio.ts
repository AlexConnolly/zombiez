import type { GameEvent, Sim } from '../sim/game';
import { maxBoards, v3, windowGeom, type V3 } from '../sim/map';
import type { WeaponId } from '../sim/weapons';

type Opt = { at?: V3; gain?: number; delay?: number };

/** All sounds are synthesised with Web Audio, so the game ships no audio files. */
export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private muffle!: BiquadFilterNode;
  private drone!: GainNode;
  private noise!: AudioBuffer;
  private groanAt = new Map<number, number>();
  private stepT = 0;
  private beatT = 0;
  private thunderT = 20;
  private traffic: GainNode | null = null;
  private sirenT = 30;
  private foxT = 15;
  private alarm: { at: V3; t: number; beep: number } | null = null;
  volume = 0.8;

  start() {
    if (this.ctx) return void this.ctx.resume();
    const ctx = (this.ctx = new AudioContext());
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.muffle.connect(this.master).connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // Ambient bed: wind and rain, always on.
    const wind = this.loopNoise('lowpass', 400, 0.12);
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.07;
    lfoGain.gain.value = 250;
    lfo.connect(lfoGain).connect(wind.frequency);
    lfo.start();
    this.loopNoise('highpass', 3000, 0.035);
    // Low drone that grows with the number of live zombies.
    this.drone = ctx.createGain();
    this.drone.gain.value = 0;
    const dl = ctx.createBiquadFilter();
    dl.type = 'lowpass';
    dl.frequency.value = 220;
    for (const f of [41.2, 61.7, 82.4]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(dl);
      o.start();
    }
    dl.connect(this.drone).connect(this.muffle);
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.value = v;
  }

  suspend() { void this.ctx?.suspend(); }

  private loopNoise(type: BiquadFilterType, freq: number, gain: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(this.muffle);
    src.start();
    return f;
  }

  private out(o: Opt): AudioNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = o.gain ?? 1;
    if (o.at) {
      const p = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1.5, rolloffFactor: 1.3, positionX: o.at.x, positionY: o.at.y + 1.5, positionZ: o.at.z });
      g.connect(p).connect(this.muffle);
    } else g.connect(this.muffle);
    return g;
  }

  private tone(freq: number, dur: number, type: OscillatorType, o: Opt & { to?: number; attack?: number } = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(1, t + (o.attack ?? 0.005));
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(this.out(o));
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private hiss(dur: number, type: BiquadFilterType, freq: number, o: Opt & { q?: number; to?: number; attack?: number } = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    f.Q.value = o.q ?? 0.7;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(1, t + (o.attack ?? 0.003));
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(env).connect(this.out(o));
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  private gun(w: WeaponId, at?: V3) {
    const r = 0.95 + Math.random() * 0.1;
    switch (w) {
      case 'barnburner':
        this.hiss(0.45, 'lowpass', 2200 * r, { at, gain: 1.1, to: 300 });
        this.tone(90, 0.3, 'sine', { at, gain: 0.9, to: 35 });
        this.hiss(0.08, 'bandpass', 1400, { at, gain: 0.25, delay: 0.35, q: 4 });
        break;
      case 'longshot':
        this.hiss(0.6, 'lowpass', 4000 * r, { at, gain: 1.0, to: 200 });
        this.tone(110, 0.4, 'sine', { at, gain: 0.8, to: 30 });
        break;
      case 'bucket':
        this.tone(160, 0.18, 'sine', { at, gain: 0.8, to: 60 });
        this.hiss(0.12, 'lowpass', 900, { at, gain: 0.5 });
        break;
      case 'zapper':
        this.tone(1400 * r, 0.25, 'square', { at, gain: 0.18, to: 180 });
        this.tone(700 * r, 0.3, 'sawtooth', { at, gain: 0.15, to: 90 });
        break;
      default: {
        const big = w === 'thumper';
        this.hiss(big ? 0.22 : 0.16, 'lowpass', (w === 'p9' ? 3000 : 2600) * r, { at, gain: big ? 0.8 : 0.6, to: 400 });
        this.tone(big ? 95 : 120, 0.12, 'sine', { at, gain: 0.6, to: 45 });
      }
    }
  }

  private groan(at: V3, angry = false) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const dur = 0.7 + Math.random() * 0.8;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const base = (angry ? 120 : 85) + Math.random() * 40;
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.linearRampToValueAtTime(base * (0.7 + Math.random() * 0.2), t + dur);
    const vib = ctx.createOscillator();
    const vg = ctx.createGain();
    vib.frequency.value = 5 + Math.random() * 4;
    vg.gain.value = 6;
    vib.connect(vg).connect(osc.frequency);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 500 + Math.random() * 400;
    f.Q.value = 3;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(angry ? 0.9 : 0.5, t + 0.12);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(f).connect(env).connect(this.out({ at }));
    osc.start(t);
    vib.start(t);
    osc.stop(t + dur + 0.05);
    vib.stop(t + dur + 0.05);
  }

  events(evs: GameEvent[], sim: Sim, localId: string) {
    if (!this.ctx) return;
    for (const e of evs) {
      switch (e.type) {
        case 'shot': {
          if (e.pid === localId) this.gun(e.weapon);
          else this.gun(e.weapon, e.from);
          break;
        }
        case 'hit':
          if (e.pid === localId) this.tone(e.head ? 1500 : 1900, 0.04, 'square', { gain: 0.12 });
          break;
        case 'kill':
          if (e.pid !== localId) break;
          this.tone(e.head ? 900 : 1900, e.head ? 0.08 : 0.04, 'square', { gain: e.head ? 0.2 : 0.12 });
          if (e.head) this.hiss(0.1, 'bandpass', 700, { gain: 0.6, at: e.pos, q: 2 });
          break;
        case 'empty':
          if (e.pid === localId) this.tone(2400, 0.03, 'square', { gain: 0.15 });
          break;
        case 'reload':
          if (e.pid === localId) { this.hiss(0.05, 'bandpass', 1800, { gain: 0.4, q: 5 }); this.hiss(0.05, 'bandpass', 1300, { gain: 0.4, q: 5, delay: 0.5 }); }
          break;
        case 'swap':
          if (e.pid === localId) this.hiss(0.06, 'bandpass', 1500, { gain: 0.3, q: 4 });
          break;
        case 'melee':
          if (e.pid === localId) this.hiss(0.15, 'bandpass', 2500, { gain: e.hit ? 0.5 : 0.25, to: 800 });
          break;
        case 'board': {
          const w = sim.map.windows.find((x) => x.id === e.window)!;
          const at = windowGeom(sim.map, w).center;
          if (e.torn) { this.hiss(0.25, 'bandpass', 450, { gain: 1.4, at, q: 1.5 }); this.tone(70, 0.15, 'sine', { gain: 0.6, at }); }
          // A big door: the letterbox rattles before it gives.
          if (e.torn && maxBoards(w) > 6 && e.boards <= 2) for (let i = 0; i < 6; i++) this.tone(2300 + Math.random() * 400, 0.04, 'square', { gain: 0.15, at, delay: i * 0.06 });
          else { this.tone(120, 0.12, 'sine', { gain: 0.9, at }); this.hiss(0.08, 'lowpass', 800, { gain: 0.5, at }); }
          break;
        }
        case 'zombieAttack': {
          const z = sim.state.zombies.find((x) => x.id === e.zid);
          if (z) this.groan(z.pos, true);
          break;
        }
        case 'hurt':
          if (e.pid === localId) { this.tone(80, 0.3, 'sine', { gain: 1.2, to: 40 }); this.hiss(0.2, 'lowpass', 600, { gain: 0.6 }); }
          break;
        case 'roundStart':
          for (const [f, d] of [[55, 0], [82.4, 0.1], [110, 0.2]] as const) this.tone(f, 3.5, 'sawtooth', { gain: 0.22, delay: d, attack: 0.6 });
          this.hiss(2.5, 'bandpass', 300, { gain: 0.3, attack: 0.3, q: 2 });
          break;
        case 'roundEnd':
          for (const [f, d] of [[659, 0], [988, 0.15], [1319, 0.3]] as const) this.tone(f, 1.6, 'sine', { gain: 0.25, delay: d });
          break;
        case 'door':
          this.hiss(0.9, 'lowpass', 1200, { gain: 1.2, to: 150 });
          this.tone(60, 0.5, 'sine', { gain: 0.8, to: 30 });
          break;
        case 'buy':
          if (e.pid === localId) { this.tone(1200, 0.08, 'square', { gain: 0.15 }); this.tone(1600, 0.2, 'square', { gain: 0.15, delay: 0.08 }); }
          break;
        case 'denied':
          if (e.pid === localId) this.tone(110, 0.25, 'square', { gain: 0.2 });
          break;
        case 'power':
          this.tone(50, 1.2, 'sine', { gain: 1, to: 30 });
          this.tone(60, 2.5, 'sawtooth', { gain: 0.12, to: 120, attack: 0.5, delay: 0.3 });
          break;
        case 'powerupDrop':
          for (let i = 0; i < 5; i++) this.tone(880 * 2 ** (i / 5), 0.25, 'triangle', { gain: 0.12, delay: i * 0.06 });
          break;
        case 'powerup':
          this.tone(300, 0.8, 'sawtooth', { gain: 0.2, to: 1200 });
          if (e.kind === 'nuke') { this.hiss(2.5, 'lowpass', 800, { gain: 1.5, to: 60 }); this.tone(45, 2, 'sine', { gain: 1.2, to: 25 }); }
          break;
        case 'explode':
          this.hiss(1.2, 'lowpass', 1500, { gain: 1.6, to: 80, at: e.pos });
          this.tone(60, 0.8, 'sine', { gain: 1.2, to: 25 });
          break;
        case 'boxRoll': {
          const notes = [523, 587, 659, 784, 880, 1047];
          for (let i = 0; i < 18; i++) this.tone(notes[(i * 7 + 3) % notes.length], 0.3, 'triangle', { gain: 0.12, delay: i * 0.21 });
          break;
        }
        case 'boxOffer':
          this.tone(1047, 0.6, 'triangle', { gain: 0.2 });
          break;
        case 'boxMove':
          for (let i = 0; i < 4; i++) this.tone(300 - i * 50, 0.3, 'square', { gain: 0.12, delay: i * 0.25 });
          break;
        case 'down':
          if (e.pid === localId) { this.tone(70, 1.2, 'sine', { gain: 1.2, to: 35 }); this.hiss(1, 'lowpass', 500, { gain: 0.6 }); }
          break;
        case 'revive':
          for (const [f, d] of [[523, 0], [784, 0.1]] as const) this.tone(f, 0.5, 'triangle', { gain: 0.2, delay: d });
          break;
        case 'trap':
          if (!e.fire) { this.tone(1800, 0.05, 'square', { gain: 0.2 }); this.hiss(1, 'highpass', 2500, { gain: 0.5, attack: 0.1 }); }
          else { this.hiss(1.8, 'lowpass', 1200, { gain: 1.8, to: 90, attack: 0.02 }); this.tone(50, 1.2, 'sine', { gain: 1.4, to: 28 }); }
          break;
        case 'slide':
          if (e.pid === localId) this.hiss(0.6, 'bandpass', 900, { gain: 0.6, to: 2400, q: 1.5, attack: 0.05 });
          break;
        case 'link':
          // Rope and pulley: a creaking glide.
          this.tone(180, 1.2, 'sawtooth', { gain: 0.08, to: 120, attack: 0.1 });
          this.hiss(1.2, 'bandpass', 1200, { gain: 0.3, q: 6, attack: 0.1 });
          break;
        case 'secret':
          if (e.pid === localId) for (let i = 0; i < 3; i++) this.hiss(0.08, 'bandpass', 3500, { gain: 0.35, q: 2, delay: i * 0.09 });
          break;
        case 'roof': {
          // Footsteps on slate, over the 3 s before the zombie reaches the skylight.
          const z = sim.state.zombies.find((x) => x.id === e.zid);
          if (!z) break;
          for (let i = 0; i < 7; i++) {
            const at = { x: z.pos.x, y: z.pos.y, z: z.pos.z };
            this.hiss(0.12, 'lowpass', 700, { gain: 1.3, at, delay: i * 0.42 });
            this.tone(140, 0.08, 'triangle', { gain: 0.5, at, delay: i * 0.42 + 0.02 });
          }
          break;
        }
        case 'spawn': {
          // A zombie bumping a parked car sets its alarm off now and then.
          const z = sim.state.zombies.find((x) => x.id === e.zid);
          const car = z && sim.map.props?.find((p) => p.kind === 'car' && Math.hypot(p.pos[0] - z.pos.x, p.pos[2] - z.pos.z) < 3.5);
          if (car && !this.alarm && Math.random() < 0.15) this.alarm = { at: v3(car.pos), t: 8, beep: 0 };
          break;
        }
        case 'gameOver':
          this.tone(110, 3, 'sawtooth', { gain: 0.3, to: 40, attack: 0.1 });
          break;
      }
    }
  }

  /** Per-frame: listener, groans, heartbeat, footsteps, drone. */
  update(dt: number, sim: Sim, localId: string, cam: { x: number; y: number; z: number; yaw: number }, moving: boolean, sprint: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    l.positionX.value = cam.x;
    l.positionY.value = cam.y;
    l.positionZ.value = cam.z;
    l.forwardX.value = -Math.sin(cam.yaw);
    l.forwardY.value = 0;
    l.forwardZ.value = -Math.cos(cam.yaw);
    l.upX.value = 0;
    l.upY.value = 1;
    l.upZ.value = 0;
    const s = sim.state;
    const now = ctx.currentTime;
    for (const z of s.zombies) {
      const at = this.groanAt.get(z.id);
      if (at === undefined) this.groanAt.set(z.id, now + Math.random() * 3);
      else if (now > at) {
        this.groan(z.pos);
        this.groanAt.set(z.id, now + 2 + Math.random() * 4);
      }
    }
    if (this.groanAt.size > 64) for (const id of this.groanAt.keys()) if (!s.zombies.some((z) => z.id === id)) this.groanAt.delete(id);
    this.drone.gain.setTargetAtTime(s.phase === 'active' ? (s.zombies.length / 24) * 0.05 : 0, now, 1);

    const me = sim.player(localId);
    const low = me && !(me.status !== 'alive') && me.hp < me.maxHp * 0.4;
    this.muffle.frequency.setTargetAtTime(low ? 700 : 20000, now, 0.2);
    if (low) {
      this.beatT -= dt;
      if (this.beatT <= 0) {
        this.beatT = 0.85;
        this.tone(55, 0.12, 'sine', { gain: 1.4 });
        this.tone(50, 0.12, 'sine', { gain: 1.0, delay: 0.18 });
      }
    }
    if (moving && me?.onGround) {
      this.stepT -= dt;
      if (this.stepT <= 0) {
        this.stepT = sprint ? 0.3 : 0.42;
        this.hiss(0.07, 'lowpass', 500 + Math.random() * 300, { gain: 0.35 });
      }
    }
    if (sim.map.ambience === 'city') this.city(dt);
    else {
      this.thunderT -= dt;
      if (this.thunderT <= 0) {
        this.thunderT = 25 + Math.random() * 40;
        this.hiss(4, 'lowpass', 300, { gain: 0.9, to: 60, attack: 0.4 });
      }
    }
    this.traffic?.gain.setTargetAtTime(sim.map.ambience === 'city' ? 0.07 : 0, now, 1);
  }

  /** London at night: traffic rumble, a far siren now and then, foxes, and car alarms. */
  private city(dt: number) {
    const ctx = this.ctx!;
    if (!this.traffic) {
      this.traffic = ctx.createGain();
      this.traffic.gain.value = 0;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 160;
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = 0.05;
      lg.gain.value = 60;
      lfo.connect(lg).connect(f.frequency);
      lfo.start();
      src.connect(f).connect(this.traffic).connect(this.muffle);
      src.start();
    }
    this.sirenT -= dt;
    if (this.sirenT <= 0) {
      this.sirenT = 40 + Math.random() * 60;
      for (let i = 0; i < 4; i++) this.tone(i % 2 ? 950 : 650, 1.1, 'triangle', { gain: 0.035, to: i % 2 ? 650 : 950, attack: 0.3, delay: i * 1.1 });
    }
    this.foxT -= dt;
    if (this.foxT <= 0) {
      this.foxT = 30 + Math.random() * 50;
      const at = { x: -15 + Math.random() * 40, y: -3, z: 30 + Math.random() * 10 };
      for (let i = 0; i < 3; i++) this.tone(1100 + Math.random() * 200, 0.45, 'sawtooth', { gain: 0.3, to: 600, at, delay: i * 0.7, attack: 0.05 });
    }
    const a = this.alarm;
    if (a) {
      a.t -= dt;
      a.beep -= dt;
      if (a.beep <= 0) {
        a.beep = 0.5;
        this.tone(Math.round(a.t * 2) % 2 ? 1400 : 1000, 0.3, 'square', { gain: 0.25, at: a.at });
      }
      if (a.t <= 0) this.alarm = null;
    }
  }
}
