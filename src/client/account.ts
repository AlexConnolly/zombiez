import type { ControlIn, ControlOut } from '../net/wire';

/** Control service address. Set VITE_CONTROL at build time for production. */
export const API = (import.meta.env.VITE_CONTROL as string | undefined) ?? `http://${location.hostname || 'localhost'}:8788`;
export const REGION_NAMES: Record<string, string> = { lhr: 'London', iad: 'US East', sjc: 'US West', local: 'Local' };

export interface Me { id: string; username: string }
type Listener = (m: ControlOut) => void;

/**
 * The logged-in session: a short access token kept in memory (refreshed from the HttpOnly cookie),
 * plus one WebSocket to the control service for lobby, queue and match messages.
 */
export class Account {
  me: Me | null = null;
  pings: Record<string, number> = {};
  private access = '';
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private refreshTimer = 0;
  private pingTimer = 0;

  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  private async call<T>(path: string, body?: object): Promise<T & { error?: string }> {
    try {
      const r = await fetch(API + path, {
        method: body ? 'POST' : 'GET',
        credentials: 'include',
        headers: { 'content-type': 'application/json', ...(this.access ? { authorization: `Bearer ${this.access}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return await r.json();
    } catch {
      return { error: 'Could not reach the server.' } as T & { error: string };
    }
  }

  private signedIn(r: { user: Me; access: string }) {
    this.me = r.user;
    this.access = r.access;
    clearInterval(this.refreshTimer);
    // Access tokens last 15 minutes; renew at 10.
    this.refreshTimer = window.setInterval(() => void this.refresh(), 10 * 60_000);
    this.connect();
  }

  /** Restores the session from the cookie, if there is one. */
  async refresh() {
    const r = await this.call<{ user: Me; access: string }>('/auth/refresh', {});
    if (r.error || !r.access) { this.signedOut(); return false; }
    this.signedIn(r);
    return true;
  }

  async login(username: string, password: string) {
    const r = await this.call<{ user: Me; access: string }>('/auth/login', { username, password });
    if (!r.error) this.signedIn(r);
    return r.error ?? null;
  }

  async signup(username: string, password: string): Promise<{ error?: string; codes?: string[] }> {
    const r = await this.call<{ user: Me; access: string; codes: string[] }>('/auth/signup', { username, password });
    if (!r.error) this.signedIn(r);
    return r;
  }

  async recover(username: string, code: string, password: string) {
    const r = await this.call<{ user: Me; access: string }>('/auth/recover', { username, code, password });
    if (!r.error) this.signedIn(r);
    return r.error ?? null;
  }

  async logout() {
    await this.call('/auth/logout', {});
    this.signedOut();
  }

  private signedOut() {
    this.me = null;
    this.access = '';
    clearInterval(this.refreshTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  profile() { return this.call<{ user: Me; stats: { games: number; best_round: number; total_kills: number } }>('/me'); }
  changePassword(current: string, password: string) { return this.call<object>('/me/password', { current, password }); }
  newCodes(password: string) { return this.call<{ codes: string[] }>('/me/codes', { password }); }
  async deleteAccount(password: string) {
    const r = await this.call<object>('/me/delete', { password });
    if (!r.error) this.signedOut();
    return r;
  }
  leaderboard() { return this.call<{ best: { username: string; round: number; kills: number }[]; daily: { username: string; round: number; kills: number }[] }>('/leaderboard'); }
  /** A fresh ticket for a match we are still in, if any. */
  rejoin() { return this.call<{ url?: string; matchId?: string; token?: string }>('/rejoin', {}); }

  send(m: ControlIn) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) { this.send({ t: 'auth', access: this.access }); return; }
    const ws = new WebSocket(API.replace(/^http/, 'ws') + '/ws');
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'auth', access: this.access }));
      void this.measurePings();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => void this.measurePings(), 60_000);
    };
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)) as ControlOut; this.listeners.forEach((fn) => fn(m)); };
    ws.onclose = () => { if (this.ws === ws && this.me) setTimeout(() => { if (this.ws === ws) { this.ws = null; this.connect(); } }, 2000); };
  }

  /** Median of 5 WebSocket round trips to each region's game server, sent to the control service. */
  async measurePings() {
    const regions = await this.call<{ region: string; pingUrl: string }[]>('/regions');
    if (!Array.isArray(regions)) return;
    const results = await Promise.all(regions.map(async ({ region, pingUrl }) => [region, await median(pingUrl)] as const));
    this.pings = Object.fromEntries(results.filter(([, ms]) => ms !== null)) as Record<string, number>;
    this.send({ t: 'pings', pings: this.pings });
  }
}

function median(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const times: number[] = [];
    let sent = 0;
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { resolve(null); return; }
    const done = () => { ws.close(); times.sort((a, b) => a - b); resolve(times.length ? Math.round(times[Math.floor(times.length / 2)]) : null); };
    const timeout = setTimeout(done, 3000);
    const ping = () => { sent = performance.now(); ws.send('p'); };
    ws.onopen = ping;
    ws.onmessage = () => {
      times.push(performance.now() - sent);
      if (times.length >= 5) { clearTimeout(timeout); done(); } else setTimeout(ping, 200);
    };
    ws.onerror = () => { clearTimeout(timeout); resolve(null); };
  });
}
