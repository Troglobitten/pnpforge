import { create } from 'zustand';
import { api } from '@/api/client';
import { DEFAULT_SETTINGS, normalizeSettings, type AppSettings, type SettingsPatch } from '@/shared/settings';
import { toast } from '@/ui';

/**
 * App-wide preferences (see src/shared/settings.ts). The server is the source of truth
 * (`data/settings.json`), so a choice made on the desktop is there on the tablet too.
 *
 *   const showNames = useSettings((s) => s.settings.showNamesPlay);
 *   useSettings.getState().set({ showNamesPlay: true });   // applies instantly, saves in the background
 *
 * The last known values are cached in localStorage so the very first paint already uses
 * them (no flash of "names on" before the server answers). Changes are optimistic; a failed
 * save keeps the local value, says so once, and retries when the tab regains focus.
 *
 * Only an explicit choice writes a setting: a switch, "Reset to defaults", or the one-time
 * migration into a server that has never stored settings. Nothing implicit (a dismissed tip,
 * an old browser's leftovers, a slow read) may change what every other device sees.
 */

const CACHE_KEY = 'pnpforge.settings.v1';
const MIGRATED_KEY = 'pnpforge.settings.migrated';
/**
 * "Got it" on the tips bar: this device has seen the tips. Deliberately per-browser — a tip
 * dismissed on the tablet must not vanish from the desktop. The global switch is `tableTips`.
 */
const TIPS_SEEN_KEY = 'pnpforge.play.coach.v1';

/** Per-browser preferences that existed before the settings system, moved in once. */
const LEGACY: { key: string; toPatch: (v: string) => SettingsPatch }[] = [
  { key: 'pnpforge.sound.muted', toPatch: (v) => (v === '1' ? { sound: false } : {}) },
  { key: 'pnpforge.setup.snap', toPatch: (v) => (v === '1' ? { snapToGrid: true } : {}) },
];

export type SettingsSync = 'saved' | 'saving' | 'error';

interface SettingsStore {
  settings: AppSettings;
  /** True once the server's values have arrived at least once. */
  loaded: boolean;
  sync: SettingsSync;
  /** This browser has dismissed the tips bar ("Got it"). Not a setting; never leaves the device. */
  tipsSeen: boolean;
  dismissTips: () => void;
  set: (patch: SettingsPatch) => void;
  reset: () => void;
  refresh: () => Promise<void>;
}

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    /* private mode / quota — the server still has it */
  }
}

function legacyPatch(): SettingsPatch {
  const out: SettingsPatch = {};
  for (const l of LEGACY) {
    const v = lsGet(l.key);
    if (v !== null) Object.assign(out, l.toPatch(v));
  }
  return out;
}

function initial(): AppSettings {
  const cached = lsGet(CACHE_KEY);
  if (cached) {
    try {
      return normalizeSettings(JSON.parse(cached));
    } catch {
      /* fall through */
    }
  }
  // First run of this build in this browser: honour the old per-browser prefs right away.
  return lsGet(MIGRATED_KEY) ? { ...DEFAULT_SETTINGS } : { ...DEFAULT_SETTINGS, ...legacyPatch() };
}

/** Local edits not yet confirmed by the server. */
let pending: SettingsPatch = {};
let flushing: Promise<void> | null = null;
let warned = false;
/** Bumped on every local change, so a read that started before it can't roll it back. */
let rev = 0;

export const useSettings = create<SettingsStore>((set, get) => {
  const apply = (settings: AppSettings, extra: Partial<SettingsStore> = {}) => {
    lsSet(CACHE_KEY, JSON.stringify(settings));
    set({ settings, ...extra });
  };

  const flush = (): Promise<void> => {
    if (flushing) return flushing;
    flushing = (async () => {
      while (Object.keys(pending).length) {
        const sending = pending;
        pending = {};
        set({ sync: 'saving' });
        try {
          const server = await api.saveSettings(sending);
          warned = false;
          // anything changed while that request was in flight still wins locally
          apply({ ...normalizeSettings(server), ...pending }, { loaded: true, sync: Object.keys(pending).length ? 'saving' : 'saved' });
        } catch {
          pending = { ...sending, ...pending };
          set({ sync: 'error' });
          if (!warned) {
            warned = true;
            toast.warning('Settings not saved to the server', {
              description: 'They apply in this browser for now and will be saved when the server is reachable.',
            });
          }
          break;
        }
      }
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  };

  return {
    settings: initial(),
    loaded: false,
    sync: 'saved',
    tipsSeen: lsGet(TIPS_SEEN_KEY) === '1',
    dismissTips: () => {
      lsSet(TIPS_SEEN_KEY, '1');
      set({ tipsSeen: true });
    },
    set: (patch) => {
      // Switching tips on is also "show them to me again" on this device.
      if (patch.tableTips === true && get().tipsSeen) {
        lsSet(TIPS_SEEN_KEY, null);
        set({ tipsSeen: false });
      }
      const cur = get().settings;
      const next = normalizeSettings({ ...cur, ...patch });
      const changed = (Object.keys(patch) as (keyof AppSettings)[]).filter((k) => next[k] !== cur[k]);
      if (!changed.length) return;
      for (const k of changed) (pending as Record<string, unknown>)[k] = next[k];
      rev++;
      apply(next);
      void flush();
    },
    reset: () => get().set({ ...DEFAULT_SETTINGS }),
    refresh: async () => {
      if (Object.keys(pending).length) return flush();
      if (flushing) return flushing;
      const at = rev;
      try {
        const server = await api.getSettings();
        // A change made (or saved) while this read was in flight is newer than what it returned.
        if (rev !== at || flushing || Object.keys(pending).length) return;
        apply(normalizeSettings(server), { loaded: true, sync: 'saved' });
        migrateOnce(server);
      } catch {
        /* offline: keep the cached values */
      }
    },
  };
});

/**
 * Move the old per-browser prefs (mute, snap) into the server once — and only into a server
 * that has never stored settings. Once any device has saved, those values are the user's
 * global choices; a browser opened weeks later with old leftovers must not overwrite them.
 */
function migrateOnce(server: { updatedAt?: number }) {
  if (lsGet(MIGRATED_KEY)) return;
  const legacy = legacyPatch();
  lsSet(MIGRATED_KEY, '1');
  for (const l of LEGACY) lsSet(l.key, null);
  if (server.updatedAt) return;
  if (Object.keys(legacy).length) useSettings.getState().set(legacy);
}

if (typeof window !== 'undefined') {
  void useSettings.getState().refresh();
  // Another device may have changed something; pick it up when this tab comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void useSettings.getState().refresh();
  });
  window.addEventListener('online', () => void useSettings.getState().refresh());
}

/** Non-React read, e.g. inside the table controller or the sound kit. */
export const getSettings = () => useSettings.getState().settings;
