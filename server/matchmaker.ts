export type Pings = Record<string, number>;
export interface Ticket { userId: string; username: string; pings: Pings; since: number }
export interface Group { region: string; players: Ticket[] }

export const MATCH_SIZE = 4;
/** Ping limit by time in queue (spec: 0-10 s same best region under 80 ms, then 120, then 180, then anyone). */
export function limitFor(waitMs: number) {
  if (waitMs < 10_000) return { ms: 80, sameBest: true };
  if (waitMs < 25_000) return { ms: 120, sameBest: false };
  if (waitMs < 40_000) return { ms: 180, sameBest: false };
  return { ms: Infinity, sameBest: false };
}

const best = (p: Pings) => Object.entries(p).sort((a, b) => a[1] - b[1])[0]?.[0];

/** The region with the lowest worst-player ping, among regions every player measured. */
export function pickRegion(pings: Pings[], regions: string[]): { region: string; worst: number } | null {
  let out: { region: string; worst: number } | null = null;
  for (const r of regions) {
    if (!pings.every((p) => typeof p[r] === 'number')) continue;
    const worst = Math.max(...pings.map((p) => p[r]));
    if (!out || worst < out.worst) out = { region: r, worst };
  }
  return out;
}

/**
 * One matchmaking pass. The longest-waiting player sets the rules; others join their group while the group
 * still has a region within the limit. A group starts when full, or when its oldest player has waited 40 s.
 */
export function matchmake(queue: Ticket[], regions: string[], now: number): { groups: Group[]; rest: Ticket[] } {
  const waiting = [...queue].sort((a, b) => a.since - b.since);
  const used = new Set<Ticket>();
  const groups: Group[] = [];
  for (const p of waiting) {
    if (used.has(p)) continue;
    const lim = limitFor(now - p.since);
    const home = best(p.pings);
    const group = [p];
    for (const c of waiting) {
      if (group.length >= MATCH_SIZE) break;
      if (c === p || used.has(c)) continue;
      if (lim.sameBest && best(c.pings) !== home) continue;
      const allowed = lim.sameBest && home ? [home] : regions;
      const r = pickRegion([...group, c].map((t) => t.pings), allowed);
      if (r && r.worst < lim.ms) group.push(c);
    }
    const region = pickRegion(group.map((t) => t.pings), lim.sameBest && home ? [home] : regions) ?? pickRegion([p.pings], regions);
    if ((group.length >= MATCH_SIZE || lim.ms === Infinity) && region) {
      group.forEach((t) => used.add(t));
      groups.push({ region: region.region, players: group });
    }
  }
  return { groups, rest: waiting.filter((t) => !used.has(t)) };
}
