import { describe, expect, it } from 'vitest';
import { Lobbies, lobbyView } from './lobbies';
import { matchmake, pickRegion, type Ticket } from './matchmaker';

const regions = ['lhr', 'iad', 'sjc'];
let n = 0;
const t = (pings: Record<string, number>, since = 0): Ticket => ({ userId: `u${++n}`, username: `p${n}`, pings, since });
const EU = { lhr: 20, iad: 90, sjc: 160 };
const US_E = { lhr: 95, iad: 15, sjc: 70 };
const US_W = { lhr: 150, iad: 70, sjc: 12 };

describe('region choice', () => {
  it('picks the region with the lowest worst-player ping', () => {
    expect(pickRegion([EU, US_E], regions)).toEqual({ region: 'iad', worst: 90 });
    expect(pickRegion([EU, EU], regions)).toEqual({ region: 'lhr', worst: 20 });
  });
});

describe('quick play', () => {
  it('4 players in the same region start at once', () => {
    const q = [t(EU), t(EU), t(EU), t(EU)];
    const r = matchmake(q, regions, 1000);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].region).toBe('lhr');
    expect(r.rest).toHaveLength(0);
  });
  it('in the first 10 s only players with the same best region under 80 ms group', () => {
    const r = matchmake([t(EU), t(EU), t(EU), t(US_E)], regions, 5_000);
    expect(r.groups).toHaveLength(0);
  });
  it('after 10 s the limit widens to 120 ms, so EU and US East can meet in iad', () => {
    const r = matchmake([t(EU), t(US_E), t(US_E), t(US_E)], regions, 12_000);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].region).toBe('iad');
  });
  it('fewer than 4 wait until 40 s, then start with whoever is grouped', () => {
    expect(matchmake([t(EU), t(EU)], regions, 39_000).groups).toHaveLength(0);
    const r = matchmake([t(EU), t(EU)], regions, 41_000);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].players).toHaveLength(2);
  });
  it('a lone player starts alone after 40 s', () => {
    expect(matchmake([t(US_W)], regions, 41_000).groups[0]).toMatchObject({ region: 'sjc' });
  });
  it('never puts more than 4 in a match', () => {
    const r = matchmake(Array.from({ length: 9 }, () => t(EU)), regions, 1000);
    expect(r.groups.map((g) => g.players.length)).toEqual([4, 4]);
    expect(r.rest).toHaveLength(1);
  });
});

describe('lobbies', () => {
  const me = (id: string, pings = EU) => ({ userId: id, username: id, pings });
  it('creates a 4-letter code with no vowels and lets 4 join', () => {
    const L = new Lobbies();
    const l = L.create(me('a'));
    expect(l.code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    for (const id of ['b', 'c', 'd']) expect(L.join(l.code.toLowerCase(), me(id))).toBe(l);
    expect(L.join(l.code, me('e'))).toBe('That lobby is full.');
  });
  it('only the host starts, and only when all are ready', () => {
    const L = new Lobbies();
    const l = L.create(me('a'));
    L.join(l.code, me('b'));
    expect(L.canStart('b')).toBe('Only the host can start.');
    L.update('a', (_, m) => (m.ready = true));
    expect(L.canStart('a')).toBe('Everyone must be ready.');
    L.update('b', (_, m) => (m.ready = true));
    expect(L.canStart('a')).toBeNull();
  });
  it('the next member becomes host when the host leaves; the last one out closes it', () => {
    const L = new Lobbies();
    const l = L.create(me('a'));
    L.join(l.code, me('b'));
    L.leave('a');
    expect(lobbyView(l, regions).host).toBe('b');
    L.leave('b');
    expect(L.get(l.code)).toBeUndefined();
  });
  it('region defaults to the lowest worst-player ping; idle lobbies close after 30 min', () => {
    let now = 0;
    const L = new Lobbies(() => now);
    const l = L.create(me('a', EU));
    L.join(l.code, me('b', US_E));
    expect(lobbyView(l, regions).region).toBe('iad');
    now = 31 * 60_000;
    expect(L.sweep()).toEqual([l]);
    expect(L.of('a')).toBeUndefined();
  });
});
