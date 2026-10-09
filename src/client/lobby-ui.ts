import type { LobbyView } from '../net/wire';
import { REGION_NAMES, type Account } from './account';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const regionName = (r: string | null) => (r ? REGION_NAMES[r] ?? r : 'no region');

/**
 * Screens between the main menu and a match: login, recovery codes, online menu, queue, lobby,
 * profile and leaderboard. Game screens stay in main.ts.
 */
export function initLobbyUi(o: {
  account: Account;
  show: (id: string) => void;
  current: () => string | undefined;
  onMatch: (url: string, matchId: string, token: string) => void;
  inGame: () => boolean;
}) {
  const { account } = o;
  let lobby: LobbyView | null = null;
  let tab: 'login' | 'signup' | 'recover' = 'login';
  let codes: string[] = [];
  let afterCodes: () => void = () => openOnline();
  const pendingJoin = new URLSearchParams(location.search).get('join');

  // ---------------------------------------------------------------- login

  function setTab(t: typeof tab) {
    tab = t;
    $('#menu-login').dataset.tab = t;
    document.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    $('#au-go').textContent = t === 'login' ? 'Log in' : t === 'signup' ? 'Create account' : 'Reset password';
    $<HTMLInputElement>('#au-pass').autocomplete = t === 'login' ? 'current-password' : 'new-password';
    $('#au-err').textContent = '';
  }
  document.querySelectorAll<HTMLElement>('button[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab as typeof tab)));
  setTab('login');

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $<HTMLInputElement>('#au-name').value.trim();
    const pass = $<HTMLInputElement>('#au-pass').value;
    const btn = $<HTMLButtonElement>('#au-go');
    btn.disabled = true;
    $('#au-err').textContent = '';
    let err: string | null = null;
    if (tab === 'login') err = await account.login(name, pass);
    else if (tab === 'recover') err = await account.recover(name, $<HTMLInputElement>('#au-code').value, pass);
    else {
      const r = await account.signup(name, pass);
      err = r.error ?? null;
      if (r.codes) { showCodes(r.codes, () => openOnline()); btn.disabled = false; $<HTMLInputElement>('#au-pass').value = ''; return; }
    }
    btn.disabled = false;
    if (err) { $('#au-err').textContent = err; return; }
    $<HTMLInputElement>('#au-pass').value = '';
    openOnline();
  });

  // ---------------------------------------------------------------- recovery codes

  function showCodes(list: string[], then: () => void) {
    codes = list;
    afterCodes = then;
    $('#codes').innerHTML = list.map((c) => `<div>${c}</div>`).join('');
    $<HTMLInputElement>('#codes-ok').checked = false;
    $<HTMLButtonElement>('#codes-done').disabled = true;
    o.show('menu-codes');
  }
  const codesText = () => `Zombiez recovery codes for ${account.me?.username}\nEach code works once.\n\n${codes.join('\n')}\n`;
  $('#codes-copy').addEventListener('click', () => void navigator.clipboard?.writeText(codesText()));
  $('#codes-save').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([codesText()], { type: 'text/plain' }));
    a.download = 'zombiez-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#codes-ok').addEventListener('change', () => ($<HTMLButtonElement>('#codes-done').disabled = !$<HTMLInputElement>('#codes-ok').checked));
  $('#codes-done').addEventListener('click', () => afterCodes());

  // ---------------------------------------------------------------- online menu

  function openOnline() {
    if (!account.me) { o.show('menu-login'); return; }
    if (lobby) { renderLobby(); o.show('menu-lobby'); return; }
    $('#on-who').textContent = `Logged in as ${account.me.username}`;
    $('#on-err').textContent = '';
    renderPings();
    o.show('menu-online');
    if (pendingJoin) { account.send({ t: 'lobby.join', code: pendingJoin }); history.replaceState(null, '', location.pathname); }
  }
  function renderPings() {
    const p = Object.entries(account.pings).sort((a, b) => a[1] - b[1]);
    $('#on-pings').textContent = p.length ? p.map(([r, ms]) => `${regionName(r)} ${ms} ms`).join(' · ') : 'Measuring ping...';
  }
  setInterval(() => { if (o.current() === 'menu-online') renderPings(); }, 1000);

  $('#on-quick').addEventListener('click', () => {
    account.send({ t: 'pings', pings: account.pings });
    account.send({ t: 'queue' });
    $('#q-found').textContent = '1';
    $('#q-info').textContent = 'Looking for players near you...';
    o.show('menu-queue');
  });
  $('#q-cancel').addEventListener('click', () => { account.send({ t: 'unqueue' }); openOnline(); });
  $('#on-create').addEventListener('click', () => account.send({ t: 'lobby.create' }));
  $('#on-join').addEventListener('click', () => account.send({ t: 'lobby.join', code: $<HTMLInputElement>('#on-code').value.trim() }));
  $('#on-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#on-join').click(); });

  // ---------------------------------------------------------------- lobby

  function renderLobby() {
    if (!lobby || !account.me) return;
    const host = lobby.host === account.me.username;
    const mine = lobby.members.find((m) => m.username === account.me!.username);
    $('#lb-code').textContent = lobby.code;
    $('#lb-region').textContent = `Server: ${regionName(lobby.region)}`;
    $('#lb-members').innerHTML = lobby.members.map((m) =>
      `<tr><td>${m.username === lobby!.host ? '&#9733; ' : ''}${esc(m.username)}</td><td class="hint">${m.ping ?? '?'} ms</td><td class="${m.ready ? 'ready' : 'hint'}">${m.ready ? 'Ready' : 'Not ready'}</td></tr>`).join('');
    document.querySelectorAll<HTMLButtonElement>('[data-lmode]').forEach((b) => { b.classList.toggle('on', b.dataset.lmode === lobby!.mode); b.disabled = !host; });
    $('#lb-ready').textContent = mine?.ready ? 'Not ready' : 'Ready';
    const start = $<HTMLButtonElement>('#lb-start');
    start.hidden = !host;
    start.disabled = !lobby.members.every((m) => m.ready);
  }
  $('#lb-ready').addEventListener('click', () => {
    const mine = lobby?.members.find((m) => m.username === account.me?.username);
    account.send({ t: 'lobby.ready', ready: !mine?.ready });
  });
  $('#lb-start').addEventListener('click', () => account.send({ t: 'lobby.start' }));
  $('#lb-leave').addEventListener('click', () => { account.send({ t: 'lobby.leave' }); lobby = null; openOnline(); });
  document.querySelectorAll<HTMLButtonElement>('[data-lmode]').forEach((b) => b.addEventListener('click', () => account.send({ t: 'lobby.mode', mode: b.dataset.lmode as 'normal' | 'daily' })));
  $('#lb-copy').addEventListener('click', () => void navigator.clipboard?.writeText(`${location.origin}${location.pathname}?join=${lobby?.code}`));

  // ---------------------------------------------------------------- profile and leaderboard

  async function openProfile() {
    $('#pf-name').textContent = account.me?.username ?? '';
    $('#pf-msg').textContent = '';
    const r = await account.profile();
    if (r.stats) $('#pf-stats').textContent = `${r.stats.games} games · best round ${r.stats.best_round} · ${r.stats.total_kills} kills`;
  }
  const pf = () => [$<HTMLInputElement>('#pf-pass').value, $<HTMLInputElement>('#pf-new').value] as const;
  const pfMsg = (t: string) => ($('#pf-msg').textContent = t);
  $('#pf-change').addEventListener('click', async () => {
    const [cur, next] = pf();
    const r = await account.changePassword(cur, next);
    pfMsg(r.error ?? 'Password changed. Other devices were logged out.');
  });
  $('#pf-codes').addEventListener('click', async () => {
    const r = await account.newCodes(pf()[0]);
    if (r.error || !r.codes) pfMsg(r.error ?? 'Could not make new codes.');
    else showCodes(r.codes, () => o.show('menu-profile'));
  });
  $('#pf-logout').addEventListener('click', async () => { await account.logout(); lobby = null; o.show('menu-main'); });
  $('#pf-delete').addEventListener('click', async () => {
    if ($('#pf-delete').dataset.armed !== '1') { $('#pf-delete').dataset.armed = '1'; pfMsg('Click Delete account again to delete it for good.'); return; }
    const r = await account.deleteAccount(pf()[0]);
    $('#pf-delete').dataset.armed = '';
    if (r.error) pfMsg(r.error);
    else { lobby = null; o.show('menu-main'); }
  });

  async function openLeaderboard() {
    const r = await account.leaderboard();
    const rows = (list?: { username: string; round: number; kills: number }[]) =>
      list?.length ? list.map((x, i) => `<tr><td class="hint">${i + 1}</td><td>${esc(x.username)}</td><td>Round ${x.round}</td><td class="hint">${x.kills} kills</td></tr>`).join('') : '<tr><td class="hint">No games yet.</td></tr>';
    $('#lbd-best').innerHTML = rows(r.best);
    $('#lbd-daily').innerHTML = rows(r.daily);
  }

  // ---------------------------------------------------------------- control messages

  account.on((m) => {
    if (m.t === 'lobby') {
      const was = lobby;
      lobby = m.lobby;
      if (o.inGame()) return;
      if (lobby) { renderLobby(); if (o.current() !== 'menu-lobby') o.show('menu-lobby'); }
      else if (was && o.current() === 'menu-lobby') openOnline();
    }
    if (m.t === 'queue' && m.status && o.current() === 'menu-queue') {
      $('#q-found').textContent = String(m.status.waiting);
      $('#q-info').textContent = `${m.status.seconds}s · ${m.status.seconds < 40 ? 'waiting for a full team' : 'starting with who we have'}`;
    }
    if (m.t === 'match') { lobby = null; o.onMatch(m.url, m.matchId, m.token); }
    if (m.t === 'error') {
      const el = { 'menu-lobby': '#lb-err', 'menu-online': '#on-err', 'menu-queue': '#q-info' }[o.current() ?? ''];
      if (el) $(el).textContent = m.reason;
    }
  });

  return {
    /** Multiplayer from the main menu: log in first if needed. */
    openOnline,
    openProfile,
    openLeaderboard,
  };
}
