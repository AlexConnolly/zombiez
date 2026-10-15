import { MAPS, mapById } from '../maps';
import type { MapDef } from '../sim/map';
import type { NetClient } from '../net/client';
import { PartyGuest, PartyHost, cleanName, newCode } from '../net/party';
import { partyRoom } from '../net/party-room';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** How long a guest waits to hear from the host before giving up. */
const JOIN_TIMEOUT = 45_000;
const RETRY_MS = 8_000;

/**
 * Host and Join screens for peer-to-peer play. When the match starts it hands the game a NetClient,
 * exactly like an online match, plus a close function that leaves the room.
 */
export function initPartyUi(o: {
  show: (id: string) => void;
  map: () => MapDef;
  onPlay: (net: NetClient, close: () => void) => void;
  /** The host has gone: the game shows this and goes back to the menu. */
  onHostLeft: () => void;
}) {
  let host: PartyHost | null = null;
  let guest: PartyGuest | null = null;
  let code = '';
  let joinTimer: ReturnType<typeof setTimeout> | undefined;
  let playing = false;
  const nameInput = $<HTMLInputElement>('#pt-name');
  const codeInput = $<HTMLInputElement>('#pt-code');
  try { nameInput.value = localStorage.getItem('zombiez.name') ?? ''; } catch { /* private mode */ }
  const name = () => {
    const n = cleanName(nameInput.value);
    try { localStorage.setItem('zombiez.name', n); } catch { /* private mode */ }
    return n;
  };
  const err = (text: string) => ($('#pt-err').textContent = text);

  function open(prefill = '') {
    close();
    if (prefill) codeInput.value = prefill;
    err('');
    o.show('menu-party');
    (nameInput.value ? codeInput : nameInput).focus();
  }

  function close() {
    clearTimeout(joinTimer);
    host?.close();
    guest?.close();
    host = guest = null;
  }

  $('#pt-host').addEventListener('click', () => {
    close();
    code = newCode();
    host = new PartyHost(partyRoom(code), name(), o.map(), mapById, render);
    render();
    o.show('menu-party-lobby');
  });

  $('#pt-join').addEventListener('click', () => {
    const raw = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (raw.length !== 12) return err('Codes are 12 characters, like ABCD-EFGH-JKMN.');
    close();
    code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
    const until = Date.now() + JOIN_TIMEOUT;
    // Public trackers sometimes drop an introduction: if the host has not answered, join again for a fresh one.
    const attempt = () => {
      const g = new PartyGuest(partyRoom(code), name(), mapById, () => onGuest(g));
      guest = g;
      joinTimer = setTimeout(() => {
        if (guest !== g || g.names.length || g.net) return;
        g.close();
        if (Date.now() < until) return attempt();
        guest = null;
        open(code);
        err('Could not reach the host. Check the code and that the host still has the game open. Two tabs on one computer cannot connect to each other: use two devices.');
      }, RETRY_MS);
    };
    attempt();
    render();
    o.show('menu-party-lobby');
  });

  function onGuest(g: PartyGuest) {
    if (guest !== g) return;
    if (g.refused) {
      open(code);
      return void err(g.refused === 'full' ? 'That game is full (4 players).' : g.refused === 'started' ? 'That game has already started.' : 'Your game is out of date. Refresh the page.');
    }
    if (g.hostLeft) {
      guest = null;
      g.close();
      return o.onHostLeft();
    }
    if (g.net?.joined && !playing) {
      playing = true;
      o.onPlay(g.net, () => { playing = false; if (guest === g) { guest = null; g.close(); } });
      return;
    }
    render();
  }

  function render() {
    const names = host?.names ?? guest?.names ?? [];
    const mapId = host?.map.id ?? guest?.map ?? '';
    $('#pl-code').textContent = code;
    $('#pl-members').innerHTML = names.map((n, i) => `<tr><td>${i === 0 ? '&#9733; ' : ''}${esc(n)}</td><td class="hint">${i === 0 ? 'host' : ''}</td></tr>`).join('');
    $('#pl-map').innerHTML = MAPS.map((m) => `<button class="cond${m.id === mapId ? ' on' : ''}" data-pmap="${m.id}"${host ? '' : ' disabled'}>${esc(m.name)}</button>`).join('');
    $<HTMLButtonElement>('#pl-start').hidden = !host;
    $('#pl-info').textContent = host
      ? names.length > 1 ? 'Keep this tab open and in front while you play: the game runs in your browser.' : 'Send the invite link to your friends. Their names appear here when they join.'
      : names.length ? 'Waiting for the host to start.' : 'Finding the host... this can take up to 30 seconds.';
  }

  $('#pl-map').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-pmap]')?.dataset.pmap;
    if (id && host) host.setMap(id);
  });
  $('#pl-copy').addEventListener('click', () => {
    void navigator.clipboard?.writeText(`${location.origin}${location.pathname}?party=${code}`);
    $('#pl-copy').textContent = 'Copied';
    setTimeout(() => ($('#pl-copy').textContent = 'Copy invite link'), 1500);
  });
  $('#pl-start').addEventListener('click', () => {
    const h = host;
    if (!h) return;
    playing = true;
    o.onPlay(h.start(), () => { playing = false; if (host === h) { host = null; h.close(); } });
  });
  $('#pl-leave').addEventListener('click', () => open());

  // An invite link opens the join screen with the code filled in.
  const invited = new URLSearchParams(location.search).get('party');
  if (invited) {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => open(invited));
  }

  return { open };
}
