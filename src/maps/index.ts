import type { MapDef } from '../sim/map';
import farmhouse from './farmhouse.json';
import townhouse from './townhouse.json';

export const MAPS: MapDef[] = [farmhouse as MapDef, townhouse as MapDef];
export const mapById = (id: string | null | undefined) => MAPS.find((m) => m.id === id) ?? MAPS[0];
