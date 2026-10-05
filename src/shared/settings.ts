/**
 * App-wide preferences — not tied to any game. Stored once per pnpforge server in
 * `data/settings.json` (GET/PUT /api/settings) so they follow the user to every browser
 * and device on their instance. Shared by the server (validation) and the client store.
 *
 * Adding a setting: add the key + default below. Old files simply lack the key and get
 * the default; unknown keys from newer builds are kept on disk but never returned.
 */

export interface AppSettings {
  /** Play: always show zone labels, stack names and supply names. Off → names on demand. */
  showNamesPlay: boolean;
  /** Table setup editor: same, while arranging a table. A designer wants them by default. */
  showNamesSetup: boolean;
  /** Table sounds (card flips, dice…). */
  sound: boolean;
  /** Play: the one-line "drag / double-tap / long-press" tips bar when a table opens. */
  tableTips: boolean;
  /** Table setup editor: snap moved pieces and drawn zones to a 5 mm grid. */
  snapToGrid: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  showNamesPlay: false,
  showNamesSetup: true,
  sound: true,
  tableTips: true,
  snapToGrid: false,
};

export type SettingsPatch = Partial<AppSettings>;

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];

/** Keep only known keys whose value has the right type. Never throws. */
export function sanitizeSettingsPatch(raw: unknown): SettingsPatch {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out as SettingsPatch;
  const r = raw as Record<string, unknown>;
  for (const k of KEYS) {
    if (k in r && typeof r[k] === typeof DEFAULT_SETTINGS[k]) out[k] = r[k];
  }
  return out as SettingsPatch;
}

/** Defaults, overlaid with whatever valid values `raw` carries. */
export function normalizeSettings(raw: unknown): AppSettings {
  return { ...DEFAULT_SETTINGS, ...sanitizeSettingsPatch(raw) };
}
