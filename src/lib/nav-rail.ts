/**
 * Persistence for the desktop nav rail's expanded/collapsed state.
 *
 * P2-3 (decision 16): the rail is collapsible and defaults to collapsed
 * (62px, icons only, as today); the operator's choice is saved in
 * localStorage and restored on the next visit.
 *
 * All helpers are safe to call without a DOM (SSR / plain node tests):
 * storage access is guarded and any failure degrades to "collapsed".
 */

export const NAV_RAIL_STORAGE_KEY = 'gowa-lite:nav-rail-expanded';

type NavRailStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function readStorage(): NavRailStorage | null {
  try {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      return null;
    }
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readNavRailExpanded(storage: NavRailStorage | null = readStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(NAV_RAIL_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeNavRailExpanded(
  expanded: boolean,
  storage: NavRailStorage | null = readStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(NAV_RAIL_STORAGE_KEY, expanded ? '1' : '0');
  } catch {
    // Storage full / unavailable: the choice just does not persist.
  }
}
