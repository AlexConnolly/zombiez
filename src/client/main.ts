import { BLURBS, MAPS, mapById } from '../maps';
import { NO_INPUT, Sim, TICK, type Command, type GameEvent } from '../sim/game';
import { WEAPONS } from '../sim/weapons';
import { NetClient } from '../net/client';
import type { ServerMsg } from '../net/protocol';
import { Account } from './account';
import { Sound } from './audio';
import { initLobbyUi } from './lobby-ui';
import { Renderer, type Snap } from './render';

let map = mapById(new URLSearchParams(location.search).get('map') ?? localStorage.getItem('zombiez.map'));
/** The local player's id: 'p1' in solo, your name online. */
let localId = 'p1';
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
const bestRound = (id = map.id) => Math.max(0, ...loadScores().filter((s) => s.map === id).map((s) => s.round));

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

let menuSim = new Sim(map, 0);
renderer.load(menuSim);
/** Menu snapshots per map, taken while that map is behind the menu. */
const thumbs: Record<string, string> = {};
for (const m of MAPS) {
  renderer.load(new Sim(m, 0));
  renderer.thumbnail = null;
  renderer.frame(1.5, 1, new Map(), null, false);
  if (renderer.thumbnail) thumbs[m.id] = renderer.thumbnail;
}
renderer.load(menuSim);
renderer.thumbnail = thumbs[map.id] ?? null;

function chooseMap(id: string) {
  if (id === map.id) return;
  map = mapById(id);
  try { localStorage.setItem('zombiez.map', map.id); } catch { /* private mode */ }
  menuSim = new Sim(map, 0);
  if (app === 'menu') { sim = menuSim; renderer.load(menuSim); }
  renderer.thumbnail = null;
}
let sim: Sim = menuSim;
let mode: 'normal' | 'daily' = 'normal';
let app: 'menu' | 'playing' | 'paused' | 'over' = 'menu';
let prev = new Map<string | number, Snap>();
let startTick = 0;
let settingsBack = 'main';

/** The online session, or null in solo. The NetClient survives reconnects; only the socket is replaced. */
let online: { net: NetClient; ws: WebSocket | null; url: string; matchId: string; token: string; leaving: boolean; retryUntil: number; started: boolean } | null = null;
const account = new Account();
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
    const me = sim.player(localId);
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
  $$('.best:not([data-map])').forEach((b) => (b.textContent = best ? `Best: round ${best}` : ''));
  $$('.best[data-map]').forEach((b) => { const r = bestRound(b.dataset.map); b.textContent = r ? `Best: round ${r}` : ''; });
  if (renderer.thumbnail) thumbs[map.id] = renderer.thumbnail;
  $$('.thumb').forEach((t) => { const src = thumbs[t.dataset.map ?? map.id]; t.style.backgroundImage = src ? `url(${src})` : ''; });
  $('#confirm-name').textContent = map.name;
  $('#confirm-blurb').textContent = BLURBS[map.id] ?? '';
  $$('#map-cards .card[data-map]').forEach((c) => c.classList.toggle('sel', c.dataset.map === map.id));
  if (id === 'menu-scores') renderScores();
  const scr = id ? $(`#${id}`) : null;
  const first = scr?.querySelector<HTMLElement>('.card.sel') ?? scr?.querySelector<HTMLElement>('.card, .btn:not(:disabled), .primary, #again');
  first?.focus();
}

function go(target: string) {
  if (target === 'settings' && app === 'paused') settingsBack = 'pause';
  if (target === 'main' && settingsBack === 'pause' && app === 'paused') { settingsBack = 'main'; return show('pause'); }
  if (target === 'online') return lobbyUi.openOnline();
  if (target === 'profile') void lobbyUi.openProfile();
  if (target === 'leaderboard') void lobbyUi.openLeaderboard();
  show(`menu-${target}`);
}
$('#map-cards').insertAdjacentHTML('afterbegin', MAPS.map((m) => `
  <button class="card" data-go="confirm" data-map="${m.id}">
    <div class="thumb" data-map="${m.id}"></div>
    <div class="card-body">
      <div class="cond card-title">${m.name}</div>
      <div class="hint">${m.floors.length} floors &middot; ${m.windows.length} windows &middot; ${m.doors.length} doors</div>
      <div class="cond gold best" data-map="${m.id}"></div>
    </div>
  </button>`).join(''));
$$('[data-go]').forEach((b) => b.addEventListener('click', () => { sound.start(); if (b.dataset.map) chooseMap(b.dataset.map); go(b.dataset.go!); }));

// The mouse moves focus, so the mouse and the keyboard never highlight two items at once.
document.addEventListener('mouseover', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.screen .btn, .screen .card');
  if (b && b !== document.activeElement && !(b as HTMLButtonElement).disabled) b.focus();
});

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

$$('[data-mode]').forEach((b) =>
  b.addEventListener('click', () => {
    mode = b.dataset.mode as typeof mode;
    $$('[data-mode]').forEach((o) => o.classList.toggle('on', o === b));
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
  localId = 'p1';
  renderer.localId = localId;
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
$('#again').addEventListener('click', () => {
  if (!online) return startGame();
  toMenu();
  lobbyUi.openOnline();
});
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

const lobbyUi = initLobbyUi({
  account,
  show: (id) => show(id),
  current: () => $$('.screen.on')[0]?.id,
  onMatch: (url, matchId, token) => startOnline(url, matchId, token),
  inGame: () => !!online,
});

/** Joins a match on a game server with a ticket from the control service. */
function startOnline(url: string, matchId: string, token: string) {
  sound.start();
  clearTimeout(overTimer);
  leaveOnline();
  const net = new NetClient(map, () => {}, () => performance.now());
  online = { net, ws: null, url, matchId, token, leaving: false, retryUntil: 0, started: false };
  status('Joining...');
  connect();
  lock();
}

function connect() {
  const o = online;
  if (!o) return;
  const ws = new WebSocket(o.url);
  o.ws = ws;
  o.net.send = (m) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  ws.onopen = () => o.net.join(o.matchId, o.token);
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as ServerMsg;
    // The server says which map the match is on; start over on that map if it is not the one we guessed.
    if (m.t === 'welcome' && m.map !== o.net.map.id && !o.started) {
      const send = o.net.send;
      o.net = new NetClient(mapById(m.map), send, () => performance.now());
    }
    o.net.receive(m);
    if (m.t === 'welcome') {
      o.retryUntil = 0;
      status('');
      if (!o.started) {
        o.started = true;
        localId = o.net.you;
        renderer.localId = localId;
        sim = o.net.sim;
        renderer.load(sim);
        startTick = sim.state.tick;
        yaw = 0;
        pitch = 0;
        acc = 0;
        app = 'playing';
        show(null);
      }
    }
    if (m.t === 'error') {
      o.leaving = true;
      status(m.reason === 'version' ? 'The game was updated. Refresh the page.' : 'Could not join that game.', true);
      if (o.started) toMenu();
      else { online = null; lobbyUi.openOnline(); }
    }
  };
  ws.onclose = async () => {
    if (online !== o || o.leaving || o.net.ended) return;
    if (!o.retryUntil) o.retryUntil = performance.now() + 60_000;
    if (performance.now() > o.retryUntil) { status('Connection lost.', true); return; }
    status('Reconnecting...', true);
    // Tickets expire after 60 s, so ask the control service for a fresh one each try.
    const t = await account.rejoin();
    if (online !== o) return;
    if (t.token && t.url && t.matchId === o.matchId) { o.token = t.token; o.url = t.url; }
    setTimeout(connect, 1000);
  };
}

function leaveOnline() {
  if (!online) return;
  online.leaving = true;
  online.net.leave();
  online.ws?.close();
  online = null;
  localId = 'p1';
  renderer.localId = localId;
}

function toMenu() {
  clearTimeout(overTimer);
  leaveOnline();
  app = 'menu';
  sim = menuSim;
  renderer.load(menuSim);
  if (document.pointerLockElement) document.exitPointerLock();
  show('menu-main');
}

function pause() {
  // Online the game keeps running; the menu only stops your input.
  app = 'paused';
  fire = false;
  keys.clear();
  $('#pause-info').textContent = `Round ${sim.state.round} · ${sim.player(localId)!.points.toLocaleString()} points${online ? ' · the game is still running' : ''}`;
  $('#quit').textContent = online ? 'Leave match' : 'Quit to menu';
  show('pause');
}

function gameOver() {
  if (sim.state.phase !== 'over') return;
  app = 'over';
  if (document.pointerLockElement) document.exitPointerLock();
  const s = sim.state;
  const me = sim.player(localId)!;
  const before = bestRound();
  if (!online) {
    const scores = loadScores();
    scores.push({ map: sim.map.id, round: s.round, kills: me.stats.kills, mode, date: today() });
    save('zombiez.scores', scores);
  }
  $('#go-round').textContent = String(s.round);
  $('#go-rounds-word').textContent = s.round === 1 ? 'round' : 'rounds';
  $('#go-best').classList.toggle('hidden', !!online || s.round <= before);
  const secs = Math.round((s.tick - startTick) * TICK);
  const opened = Object.values(s.doors).filter(Boolean).length;
  const pct = me.stats.kills ? Math.round((me.stats.headshots / me.stats.kills) * 100) : 0;
  const stat = (k: string, v: string, extra = '', cls = '') => `<div><div class="hint">${k}</div><div class="v ${cls}">${v} <span class="hint">${extra}</span></div></div>`;
  $('#go-stats').innerHTML =
    stat('Kills', String(me.stats.kills)) +
    stat('Headshots', String(me.stats.headshots), `${pct}%`) +
    stat('Points earned', me.stats.earned.toLocaleString(), '', 'gold') +
    stat('Time', `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`) +
    stat('Doors opened', `${opened} / ${sim.map.doors.length}`) +
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
const statusEl = $('#status');
let statusText = '';
function status(text: string, bad = false) {
  statusText = text;
  statusEl.textContent = text;
  statusEl.classList.toggle('bad', bad);
}
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
    if (e.type === 'points' && e.pid === localId) {
      const d = document.createElement('div');
      d.textContent = `+${e.amount}`;
      d.style.left = `${Math.random() * 20}px`;
      d.addEventListener('animationend', () => d.remove());
      hud.pops.append(d);
    }
    if ((e.type === 'hit' || e.type === 'kill') && ('pid' in e ? e.pid === localId : true)) {
      hitT = 0.15;
      hud.hit.classList.toggle('kill', e.type === 'kill');
    }
    if (e.type === 'roundStart') { hud.round.classList.remove('flash'); void hud.round.offsetWidth; hud.round.classList.add('flash'); }
    if (e.type === 'roundEnd') banner(`Round ${e.round} survived`);
    if (e.type === 'powerup') banner(PU_NAMES[e.kind]);
    if (e.type === 'power') banner('Power on');
    if (e.type === 'secret' && sim.map.secret) {
      const n = sim.map.secret.count;
      const carried = sim.state.secret.carried[e.pid] ?? 0;
      if (e.placed >= n) banner('The Anderson shelter is open');
      else if (e.pid === localId) banner(carried ? `Ration book found (${carried} carried)` : `${e.placed} of ${n} ration books in the vault`);
    }
    if (e.type === 'trap' && e.fire) banner('The gas goes up');
    if (e.type === 'gameOver') overTimer = setTimeout(gameOver, 2500);
  }
}

function updateHud(dt: number) {
  const s = sim.state;
  const me = sim.player(localId);
  if (!me) return;
  hud.points.textContent = me.points.toLocaleString();
  if (shownRound !== s.round) { hud.round.innerHTML = s.round ? tally(s.round) : ''; shownRound = s.round; }
  const w = me.weapons[me.cur];
  hud.wname.textContent = WEAPONS[w.id].name;
  hud.mag.textContent = String(w.mag);
  hud.mag.classList.toggle('low', w.mag <= WEAPONS[w.id].mag * 0.25);
  hud.reserve.textContent = ` / ${w.reserve}`;
  const it = sim.interaction(localId);
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

  // Hold progress for rebuilding and reviving.
  const holdTime = it?.kind === 'revive' ? 3 * (me.perks.includes('quick') ? 0.5 : 1) : it?.kind === 'window' ? 0.75 : 0;
  const holding = !!holdTime && keys.has('KeyE') && me.holdId === ('id' in it! ? it.id : '');
  $('#progress').classList.toggle('on', holding);
  ($('#progress').firstElementChild as HTMLElement).style.width = holding ? `${Math.min(100, (me.useT / holdTime) * 100)}%` : '0';

  // Team panel and your own state.
  const mates = s.players.filter((p) => p.id !== localId && p.status !== 'left');
  $('#team').innerHTML = mates.map((p) => {
    const state = !p.connected ? `<span class="off">reconnecting ${Math.ceil(p.graceT)}s</span>` :
      p.status === 'down' ? `<span class="downed">down ${Math.ceil(p.bleedT)}s</span>` :
      p.status === 'dead' || p.status === 'away' ? '<span class="off">out</span>' : '';
    return `<div>${p.id} ${state}<span class="pts">${p.points.toLocaleString()}</span></div>`;
  }).join('');
  if (statusText.startsWith('Reconnecting') || statusText.startsWith('Connection')) return;
  const watching = spectating();
  if (me.status === 'down') status(`You are down · ${Math.ceil(me.bleedT)}s · a teammate can revive you`, true);
  else if (watching) status(`Spectating ${watching.id} · back next round`);
  else if (statusText) status('');
}

/** While you are out, the camera follows the first teammate still standing. */
function spectating() {
  const me = sim.player(localId);
  if (!me || (me.status !== 'dead' && me.status !== 'away')) return null;
  return sim.state.players.find((p) => p.id !== localId && p.status === 'alive') ?? null;
}

// ---------------------------------------------------------------- loop

function tick(c: Command) {
  prev = new Map();
  for (const z of sim.state.zombies) prev.set(z.id, { ...z.pos, yaw: z.yaw });
  for (const p of sim.state.players) prev.set(p.id, { ...p.pos, yaw: p.yaw });
  const evs = sim.step({ [localId]: c });
  renderer.onEvents(evs, localId);
  sound.events(evs, sim, localId);
  hudEvents(evs);
}

if (DEBUG)
  Object.assign(window, {
    /** Steps the game from the console, for testing in a hidden tab. */
    advance(seconds: number, c: Partial<Command> = {}) {
      for (let i = 0; i < Math.round(seconds / TICK); i++) tick({ ...command(), ...c });
      renderer.frame(TICK, 1, prev, { id: localId, yaw, pitch }, false);
      updateHud(TICK);
    },
  });

let last = performance.now();
let acc = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (online?.started) {
    acc += dt;
    while (acc >= TICK) {
      if (!online.net.ended) online.net.tick(app === 'playing' ? command() : { ...NO_INPUT, yaw, pitch });
      acc -= TICK;
    }
    online.net.frame(dt);
    const evs = online.net.drainEvents();
    renderer.onEvents(evs, localId);
    sound.events(evs, sim, localId);
    hudEvents(evs);
  } else if (app === 'playing' && !online) {
    acc += dt;
    while (acc >= TICK) {
      tick(command());
      acc -= TICK;
    }
  }
  const watching = app === 'menu' ? null : spectating();
  const local = app === 'menu' ? null : watching ? { id: watching.id, yaw: watching.yaw, pitch: watching.pitch, spectate: true } : { id: localId, yaw, pitch };
  const moving = app === 'playing' && ['KeyW', 'KeyA', 'KeyS', 'KeyD'].some((k) => keys.has(k));
  renderer.frame(dt, app === 'playing' && !online ? acc / TICK : 1, online ? new Map() : prev, local, moving);
  const cam = renderer.camera.position;
  sound.update(dt, sim, localId, { x: cam.x, y: cam.y, z: cam.z, yaw: app === 'menu' ? 0 : yaw }, moving, keys.has('ShiftLeft'));
  if (app !== 'menu') updateHud(dt);
  if (app === 'menu' && renderer.thumbnail && !thumbs[map.id]) show($$('.screen.on')[0]?.id ?? 'menu-main');
  requestAnimationFrame(frame);
}

show('menu-main');
requestAnimationFrame(frame);

// Logged in from an earlier visit? Restore the session and drop straight back into a running match.
void account.refresh().then(async (ok) => {
  if (!ok) { if (new URLSearchParams(location.search).has('join')) lobbyUi.openOnline(); return; }
  const t = await account.rejoin();
  if (t.token && t.url && t.matchId && app === 'menu') startOnline(t.url, t.matchId, t.token);
  else if (new URLSearchParams(location.search).has('join')) lobbyUi.openOnline();
});
