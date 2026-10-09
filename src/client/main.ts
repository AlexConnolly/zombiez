import farmhouse from '../maps/farmhouse.json';
import { NO_INPUT, Sim, TICK, type Command, type GameEvent } from '../sim/game';
import type { MapDef } from '../sim/map';
import { WEAPONS } from '../sim/weapons';
import { Sound } from './audio';
import { Renderer, type Snap } from './render';

const map = farmhouse as MapDef;
const LOCAL = 'p1';
const DEBUG = new URLSearchParams(location.search).has('debug');
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

// ---------------------------------------------------------------- storage

const load = <T,>(key: string, fallback: T): T => {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? 'null') }; } catch { return fallback; }
};
const save = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } };

const settings = load('zombiez.settings', { sens: 1, vol: 0.8, fov: 85, invert: false, shake: false });
type Score = { map: string; round: number; kills: number; mode: string; date: string };
const loadScores = (): Score[] => { try { return JSON.parse(localStorage.getItem('zombiez.scores') ?? '[]'); } catch { return []; } };
const bestRound = () => Math.max(0, ...loadScores().filter((s) => s.map === map.id).map((s) => s.round));

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dailySeed = () => [...today()].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

// ---------------------------------------------------------------- setup

const renderer = new Renderer($('#view'));
const sound = new Sound();
renderer.setFov(settings.fov);
renderer.reduceShake = settings.shake;
sound.setVolume(settings.vol);

const menuSim = new Sim(map, 0);
renderer.load(menuSim);
let sim: Sim = menuSim;
let mode: 'normal' | 'daily' = 'normal';
let app: 'menu' | 'playing' | 'paused' | 'over' = 'menu';
let prev = new Map<string | number, Snap>();
let startTick = 0;
let settingsBack = 'main';
let overTimer: ReturnType<typeof setTimeout> | undefined;

// ---------------------------------------------------------------- input

const keys = new Set<string>();
let fire = false;
let yaw = 0;
let pitch = 0;
let swapPulse = false;
const canvas = renderer.renderer.domElement;

addEventListener('keydown', (e) => {
  // Browser shortcuts (save, print, find...) open dialogs that steal the mouse mid-game.
  if (app === 'playing' && (e.ctrlKey || e.metaKey) && e.code !== 'KeyW') e.preventDefault();
  if (e.ctrlKey || e.metaKey) return;
  keys.add(e.code);
  if (app === 'playing' && ['Digit1', 'Digit2'].includes(e.code)) {
    const me = sim.player(LOCAL);
    if (me && me.cur !== Number(e.code.slice(-1)) - 1) swapPulse = true;
  }
  if (app === 'menu') menuKeys(e);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); fire = false; });
addEventListener('mousedown', (e) => {
  if (app === 'playing' && !DEBUG && document.pointerLockElement !== canvas) return void lock();
  if (e.button === 0) fire = true;
});
addEventListener('mouseup', (e) => { if (e.button === 0) fire = false; });
let wheelAt = 0;
addEventListener('wheel', () => {
  if (app !== 'playing' || performance.now() - wheelAt < 300) return;
  wheelAt = performance.now();
  swapPulse = true;
});
addEventListener('mousemove', (e) => {
  if (app !== 'playing' || (document.pointerLockElement !== canvas && !DEBUG)) return;
  const k = 0.0022 * settings.sens;
  yaw -= e.movementX * k;
  pitch = Math.max(-1.5, Math.min(1.5, pitch - e.movementY * k * (settings.invert ? -1 : 1)));
});
addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockerror', () => {
  console.warn('[zombiez] pointer lock refused');
  $('#lockhint').classList.toggle('hidden', DEBUG);
});
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  $('#lockhint').classList.toggle('hidden', locked || DEBUG);
  if (!locked && app === 'playing' && !DEBUG) pause();
});

function command(): Command {
  const k = (c: string) => keys.has(c);
  const c: Command = {
    ...NO_INPUT,
    fwd: (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0),
    strafe: (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0),
    yaw,
    pitch,
    sprint: k('ShiftLeft') || k('ShiftRight'),
    fire,
    use: k('KeyE'),
    reload: k('KeyR'),
    swap: k('KeyQ') || swapPulse,
    melee: k('KeyV') || k('KeyF'),
  };
  swapPulse = false;
  return c;
}

// The browser refuses a lock asked for too soon after one was released; the hint asks for another click.
const lock = () => {
  $('#lockhint').classList.toggle('hidden', DEBUG);
  canvas.requestPointerLock()?.catch?.((err: unknown) => console.warn('[zombiez] pointer lock failed', err));
};

// ---------------------------------------------------------------- screens

function show(id: string | null) {
  $$('.screen').forEach((s) => s.classList.toggle('on', s.id === id));
  $('#hud').classList.toggle('hidden', app === 'menu' || app === 'over');
  const best = bestRound();
  $$('.best').forEach((b) => (b.textContent = best ? `Best: round ${best}` : ''));
  if (renderer.thumbnail) $$('.thumb').forEach((t) => (t.style.backgroundImage = `url(${renderer.thumbnail})`));
  if (id === 'menu-scores') renderScores();
  const first = id ? $(`#${id}`).querySelector<HTMLElement>('.card, .btn:not(:disabled), .primary, #again') : null;
  first?.focus();
}

function go(target: string) {
  if (target === 'settings' && app === 'paused') settingsBack = 'pause';
  if (target === 'main' && settingsBack === 'pause' && app === 'paused') { settingsBack = 'main'; return show('pause'); }
  show(`menu-${target}`);
}
$$('[data-go]').forEach((b) => b.addEventListener('click', () => { sound.start(); go(b.dataset.go!); }));

function menuKeys(e: KeyboardEvent) {
  const scr = $$('.screen.on')[0];
  if (!scr) return;
  if (e.code === 'Escape') scr.querySelector<HTMLElement>('.back')?.click();
  if (e.code === 'ArrowDown' || e.code === 'ArrowUp' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    const items = [...scr.querySelectorAll<HTMLElement>('button:not(:disabled):not(.back), input')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const d = e.code === 'ArrowDown' || e.code === 'ArrowRight' ? 1 : -1;
    items[(i + d + items.length) % items.length]?.focus();
    e.preventDefault();
  }
}

$$('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    mode = b.dataset.mode as typeof mode;
    $$('.seg button').forEach((o) => o.classList.toggle('on', o === b));
  }),
);
$('#daily-date').textContent = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function bindSetting(id: string, key: keyof typeof settings, apply: (v: never) => void) {
  const el = $<HTMLInputElement>(id);
  const isBool = typeof settings[key] === 'boolean';
  if (isBool) el.checked = settings[key] as boolean;
  else el.value = String(settings[key]);
  el.addEventListener('input', () => {
    (settings as Record<string, unknown>)[key] = isBool ? el.checked : Number(el.value);
    apply(settings[key] as never);
    save('zombiez.settings', settings);
  });
  apply(settings[key] as never);
}
bindSetting('#set-sens', 'sens', () => {});
bindSetting('#set-vol', 'vol', (v: number) => sound.setVolume(v));
bindSetting('#set-fov', 'fov', (v: number) => { renderer.setFov(v); $('#fov-val').textContent = String(v); });
bindSetting('#set-invert', 'invert', () => {});
bindSetting('#set-shake', 'shake', (v: boolean) => (renderer.reduceShake = v));

function renderScores() {
  const rows = loadScores().sort((a, b) => b.round - a.round || b.kills - a.kills).slice(0, 10);
  $('#scores').innerHTML = '<tr><th>Round</th><th>Kills</th><th>Mode</th><th>Date</th></tr>' +
    (rows.length ? rows.map((s) => `<tr><td>${s.round}</td><td>${s.kills}</td><td>${s.mode}</td><td>${s.date}</td></tr>`).join('') : '<tr><td colspan="4" class="hint">No games yet.</td></tr>');
}

// ---------------------------------------------------------------- game flow

function startGame() {
  clearTimeout(overTimer);
  sound.start();
  sim = new Sim(map, mode === 'daily' ? dailySeed() : (Math.random() * 2 ** 31) | 0);
  if (DEBUG) Object.assign(window, { sim, setLook: (y: number, p: number) => ((yaw = y), (pitch = p)) });
  renderer.load(sim);
  yaw = 0;
  pitch = 0;
  prev = new Map();
  startTick = sim.state.tick;
  app = 'playing';
  show(null);
  lock();
}
$('#start').addEventListener('click', startGame);
$('#again').addEventListener('click', startGame);
$('#to-menu').addEventListener('click', toMenu);
$('#quit').addEventListener('click', toMenu);
function resume() {
  app = 'playing';
  show(null);
  sound.start();
  lock();
}
$('#resume').addEventListener('click', resume);
$('#pause').addEventListener('click', (e) => { if (e.target === e.currentTarget) resume(); });

function toMenu() {
  clearTimeout(overTimer);
  app = 'menu';
  sim = menuSim;
  renderer.load(menuSim);
  if (document.pointerLockElement) document.exitPointerLock();
  show('menu-main');
}

function pause() {
  app = 'paused';
  fire = false;
  keys.clear();
  $('#pause-info').textContent = `Round ${sim.state.round} · ${sim.player(LOCAL)!.points.toLocaleString()} points`;
  show('pause');
}

function gameOver() {
  if (sim.state.phase !== 'over') return;
  app = 'over';
  if (document.pointerLockElement) document.exitPointerLock();
  const s = sim.state;
  const me = sim.player(LOCAL)!;
  const before = bestRound();
  const scores = loadScores();
  scores.push({ map: map.id, round: s.round, kills: me.stats.kills, mode, date: today() });
  save('zombiez.scores', scores);
  $('#go-round').textContent = String(s.round);
  $('#go-rounds-word').textContent = s.round === 1 ? 'round' : 'rounds';
  $('#go-best').classList.toggle('hidden', s.round <= before);
  const secs = Math.round((s.tick - startTick) * TICK);
  const opened = Object.values(s.doors).filter(Boolean).length;
  const pct = me.stats.kills ? Math.round((me.stats.headshots / me.stats.kills) * 100) : 0;
  const stat = (k: string, v: string, extra = '', cls = '') => `<div><div class="hint">${k}</div><div class="v ${cls}">${v} <span class="hint">${extra}</span></div></div>`;
  $('#go-stats').innerHTML =
    stat('Kills', String(me.stats.kills)) +
    stat('Headshots', String(me.stats.headshots), `${pct}%`) +
    stat('Points earned', me.stats.earned.toLocaleString(), '', 'gold') +
    stat('Time', `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`) +
    stat('Doors opened', `${opened} / ${map.doors.length}`) +
    stat('Boards rebuilt', String(me.stats.boards));
  $('#go-share').textContent = mode === 'daily' ? `Zombiez daily ${today()}: round ${s.round}, ${me.stats.kills} kills` : '[Enter] Again    [Esc] Main menu';
  show('gameover');
}
addEventListener('keydown', (e) => {
  if (app !== 'over') return;
  if (e.code === 'Escape') toMenu();
});

// ---------------------------------------------------------------- HUD

const hud = {
  points: $('#points'), pops: $('#pops'), round: $('#round'), mag: $('#mag'), reserve: $('#reserve'), wname: $('#wname'),
  prompt: $('#prompt'), perks: $('#perks'), damage: $('#damage'), effects: $('#effects'), hit: $('#hitmarker'), banner: $('#banner'),
};
let shownRound = -1;
let hitT = 0;
let bannerT = 0;

function tally(n: number) {
  if (n > 5) return String(n);
  const marks = ['M14 12 Q17 50 12 88', 'M40 10 Q43 52 38 90', 'M66 14 Q64 50 68 86', 'M92 10 Q95 48 90 88'];
  const paths = marks.slice(0, Math.min(n, 4)).map((d) => `<path d="${d}"/>`).join('') + (n === 5 ? '<path d="M2 70 Q50 40 104 22"/>' : '');
  return `<svg width="110" height="100" viewBox="0 0 110 100"><g stroke="#c2161b" stroke-width="9" stroke-linecap="round" fill="none">${paths}</g></svg>`;
}

function banner(text: string) {
  hud.banner.textContent = text;
  hud.banner.classList.add('on');
  bannerT = 2.5;
}

const PU_NAMES = { maxAmmo: 'Max Ammo', instaKill: 'Insta-Kill', doublePoints: 'Double Points', nuke: 'Nuke' };

function hudEvents(evs: GameEvent[]) {
  for (const e of evs) {
    if (e.type === 'points' && e.pid === LOCAL) {
      const d = document.createElement('div');
      d.textContent = `+${e.amount}`;
      d.style.left = `${Math.random() * 20}px`;
      d.addEventListener('animationend', () => d.remove());
      hud.pops.append(d);
    }
    if ((e.type === 'hit' || e.type === 'kill') && ('pid' in e ? e.pid === LOCAL : true)) {
      hitT = 0.15;
      hud.hit.classList.toggle('kill', e.type === 'kill');
    }
    if (e.type === 'roundStart') { hud.round.classList.remove('flash'); void hud.round.offsetWidth; hud.round.classList.add('flash'); }
    if (e.type === 'roundEnd') banner(`Round ${e.round} survived`);
    if (e.type === 'powerup') banner(PU_NAMES[e.kind]);
    if (e.type === 'power') banner('Power on');
    if (e.type === 'gameOver') overTimer = setTimeout(gameOver, 2500);
  }
}

function updateHud(dt: number) {
  const s = sim.state;
  const me = sim.player(LOCAL);
  if (!me) return;
  hud.points.textContent = me.points.toLocaleString();
  if (shownRound !== s.round) { hud.round.innerHTML = s.round ? tally(s.round) : ''; shownRound = s.round; }
  const w = me.weapons[me.cur];
  hud.wname.textContent = WEAPONS[w.id].name;
  hud.mag.textContent = String(w.mag);
  hud.mag.classList.toggle('low', w.mag <= WEAPONS[w.id].mag * 0.25);
  hud.reserve.textContent = ` / ${w.reserve}`;
  const it = sim.interaction(LOCAL);
  const cost = it && 'cost' in it ? it.cost : 0;
  hud.prompt.innerHTML = !it ? '' : it.kind === 'info' ? it.label : `<span class="key">E</span>${it.label}${cost ? ` <span class="cost">${cost.toLocaleString()}</span>` : ''}`;
  hud.prompt.classList.toggle('poor', cost > me.points);
  hud.perks.innerHTML = me.perks.map((p) => `<div class="${p}">${p === 'tough' ? 'T' : 'Q'}</div>`).join('');
  hud.damage.style.opacity = me.hp < me.maxHp ? String(Math.min(0.9, (1 - me.hp / me.maxHp) * 1.1)) : '0';
  const fx = (on: number, icon: string, name: string) => on > 0 ? `<div class="fx"><div class="icon">${icon}</div><div class="barwrap"><div class="barfill" style="width:${(on / 30) * 100}%"></div></div><div class="name">${name} ${Math.ceil(on)}s</div></div>` : '';
  hud.effects.innerHTML = fx(s.doublePoints, 'x2', 'Double points') + fx(s.instaKill, '&#9760;', 'Insta-kill');
  hitT -= dt;
  hud.hit.classList.toggle('on', hitT > 0);
  bannerT -= dt;
  if (bannerT <= 0) hud.banner.classList.remove('on');
}

// ---------------------------------------------------------------- loop

function tick(c: Command) {
  prev = new Map();
  for (const z of sim.state.zombies) prev.set(z.id, { ...z.pos, yaw: z.yaw });
  for (const p of sim.state.players) prev.set(p.id, { ...p.pos, yaw: p.yaw });
  const evs = sim.step({ [LOCAL]: c });
  renderer.onEvents(evs, LOCAL);
  sound.events(evs, sim, LOCAL);
  hudEvents(evs);
}

if (DEBUG)
  Object.assign(window, {
    /** Steps the game from the console, for testing in a hidden tab. */
    advance(seconds: number, c: Partial<Command> = {}) {
      for (let i = 0; i < Math.round(seconds / TICK); i++) tick({ ...command(), ...c });
      renderer.frame(TICK, 1, prev, { id: LOCAL, yaw, pitch }, false);
      updateHud(TICK);
    },
  });

let last = performance.now();
let acc = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (app === 'playing') {
    acc += dt;
    while (acc >= TICK) {
      tick(command());
      acc -= TICK;
    }
  }
  const local = app === 'menu' ? null : { id: LOCAL, yaw, pitch };
  const moving = app === 'playing' && ['KeyW', 'KeyA', 'KeyS', 'KeyD'].some((k) => keys.has(k));
  renderer.frame(dt, app === 'playing' ? acc / TICK : 1, prev, local, moving);
  const cam = renderer.camera.position;
  sound.update(dt, sim, LOCAL, { x: cam.x, y: cam.y, z: cam.z, yaw: app === 'menu' ? 0 : yaw }, moving, keys.has('ShiftLeft'));
  if (app !== 'menu') updateHud(dt);
  if (app === 'menu' && renderer.thumbnail && !$('.thumb').style.backgroundImage) show($$('.screen.on')[0]?.id ?? 'menu-main');
  requestAnimationFrame(frame);
}

show('menu-main');
requestAnimationFrame(frame);
