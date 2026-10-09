export type WeaponId = 'p9' | 'ripper' | 'barnburner' | 'longshot' | 'thumper' | 'bucket' | 'zapper';

export interface WeaponDef {
  name: string;
  damage: number;
  pellets: number;
  /** Cone half-angle in radians. */
  spread: number;
  mag: number;
  reserve: number;
  /** Shots per second. */
  rate: number;
  auto: boolean;
  reload: number;
  cost: number;
  /** Projectile weapons explode with this radius in metres; 0 = hitscan. */
  splash: number;
  boxWeight: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  p9: { name: 'P9', damage: 40, pellets: 1, spread: 0.01, mag: 8, reserve: 80, rate: 6, auto: false, reload: 1.4, cost: 0, splash: 0, boxWeight: 0 },
  ripper: { name: 'Ripper', damage: 35, pellets: 1, spread: 0.035, mag: 30, reserve: 180, rate: 12, auto: true, reload: 2.2, cost: 1000, splash: 0, boxWeight: 1 },
  barnburner: { name: 'Barnburner', damage: 30, pellets: 8, spread: 0.09, mag: 6, reserve: 54, rate: 1.2, auto: false, reload: 3, cost: 1200, splash: 0, boxWeight: 1 },
  longshot: { name: 'Longshot', damage: 300, pellets: 1, spread: 0, mag: 5, reserve: 50, rate: 0.9, auto: false, reload: 2.8, cost: 1500, splash: 0, boxWeight: 1 },
  thumper: { name: 'Thumper', damage: 60, pellets: 1, spread: 0.025, mag: 30, reserve: 240, rate: 10, auto: true, reload: 2.6, cost: 0, splash: 0, boxWeight: 1.5 },
  bucket: { name: 'Bucket', damage: 400, pellets: 1, spread: 0, mag: 1, reserve: 24, rate: 1, auto: false, reload: 2.5, cost: 0, splash: 3.5, boxWeight: 1 },
  zapper: { name: 'Zapper', damage: 1000, pellets: 1, spread: 0, mag: 20, reserve: 160, rate: 3, auto: false, reload: 2.5, cost: 0, splash: 2.5, boxWeight: 0.4 },
};

export const PERKS = {
  tough: { name: 'Tough Juice', cost: 2500 },
  quick: { name: 'Quick Hands', cost: 3000 },
} as const;
export type PerkId = keyof typeof PERKS;

export const KNIFE = { damage: 150, range: 1.7, cooldown: 0.7 };
