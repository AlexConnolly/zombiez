import type { MapDef } from '../sim/map';
import campsite from './campsite.json';
import farmhouse from './farmhouse.json';
import townhouse from './townhouse.json';

export const MAPS: MapDef[] = [farmhouse as MapDef, townhouse as MapDef, campsite as MapDef];
export const mapById = (id: string | null | undefined) => MAPS.find((m) => m.id === id) ?? MAPS[0];
export const isMapId = (id: unknown) => MAPS.some((m) => m.id === id);

/** One line for the map picker. */
export const BLURBS: Record<string, string> = {
  farmhouse: 'An old farmhouse at night. The power is out. Hold the ground floor, then buy your way up.',
  townhouse: 'A London terraced house, five floors tall. Zombies come from the street, the garden and the roof.',
  campsite: 'A cult camp in the pines, left minutes ago. The fire is still warm. Where did everyone go?',
};
