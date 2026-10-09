import type { Player } from '../sim/game';

/** Messages between the browser, the control service and game servers (game traffic itself is in protocol.ts). */

export interface LobbyView {
  code: string;
  mode: 'normal' | 'daily';
  region: string | null;
  regionChosen: boolean;
  host: string | undefined;
  members: { username: string; ready: boolean; ping: number | null }[];
}

export type ControlIn =
  | { t: 'auth'; access: string }
  | { t: 'pings'; pings: Record<string, number> }
  | { t: 'queue' }
  | { t: 'unqueue' }
  | { t: 'lobby.create' }
  | { t: 'lobby.join'; code: string }
  | { t: 'lobby.leave' }
  | { t: 'lobby.ready'; ready: boolean }
  | { t: 'lobby.mode'; mode: 'normal' | 'daily' }
  | { t: 'lobby.region'; region: string | null }
  | { t: 'lobby.start' };

export type ControlOut =
  | { t: 'lobby'; lobby: LobbyView | null }
  | { t: 'queue'; status: { seconds: number; waiting: number; regions: number } | null }
  | { t: 'match'; url: string; matchId: string; token: string }
  | { t: 'error'; reason: string };

export type GameToControl =
  | { t: 'hello'; secret: string; region: string; url: string }
  | { t: 'created'; matchId: string }
  | { t: 'load'; matches: number; players: number }
  | { t: 'ended'; matchId: string; map: string; round: number; result: 'over' | 'abandoned'; stats: Record<string, Player['stats']> };

export type ControlToGame = { t: 'create'; matchId: string; seed: number; mode: 'normal' | 'daily'; players: { userId: string; username: string }[] };
