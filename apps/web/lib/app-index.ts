/**
 * The places of lib/app-places.ts as the top-bar search draws them: each
 * with the icon of its section. The list, its keywords and the matching
 * are app-places.ts's; this module only adds the icon, so that one has no
 * need of the icon set.
 */

import { ICONS } from '@/components/icons';
import { APP_PLACE_ENTRIES, matchPlaceEntries, type AppPlaceEntry } from '@/lib/app-places';

export interface AppPlace extends AppPlaceEntry {
  icon: string;
}

const SECTION_ICONS: Record<AppPlaceEntry['section'], string> = {
  Settings: ICONS.sliders,
  Connectors: ICONS.plug,
  Organization: ICONS.building,
};

const withIcon = (place: AppPlaceEntry): AppPlace => ({
  ...place,
  icon: SECTION_ICONS[place.section],
});

export const APP_PLACES: AppPlace[] = APP_PLACE_ENTRIES.map(withIcon);

/**
 * The places every word of `needle` appears in, title matches first. The
 * caller passes the needle already lower-cased.
 */
export function matchPlaces(needle: string, isOperator: boolean): AppPlace[] {
  return matchPlaceEntries(needle, isOperator).map(withIcon);
}
