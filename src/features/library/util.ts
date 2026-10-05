/** Small helpers shared by the library and the editor (overview/rules). */

/* ---------------- filename humanising ---------------- */

/** Characters that separate tokens in a filename. */
const SEP = String.raw`[\s_\-.+()\[\]{}]`;

/**
 * Noise that may appear anywhere, including as the first token: the PnP markers
 * themselves plus version / revision / date stamps. Stripped *whole*, so
 * "v2.1" never leaves an orphan "1" behind.
 */
const NOISE_ANY = new RegExp(
  `(?<=^|${SEP})(?:` +
    [
      String.raw`pnp`,
      String.raw`p\s?&\s?p`,
      String.raw`print[\s_\-.]*(?:and|n|&)?[\s_\-.]*play`,
      String.raw`printandplay`,
      String.raw`v(?:er(?:sion)?)?[\s_\-.]?\d+(?:[._-]\d+)*[a-z]?`,
      String.raw`rev[\s_\-.]?\d+(?:[._-]\d+)*`,
      String.raw`\d{4}[-_.]\d{2}[-_.]\d{2}`,
      String.raw`\d{2}[-_.]\d{2}[-_.]\d{4}`,
    ].join('|') +
    `)(?=$|${SEP})`,
  'gi',
);

/**
 * Noise that is only noise when it *follows* something — so "Print Shop" and
 * "Final Girl" keep their first word.
 */
const NOISE_TRAILING = new RegExp(
  `(?<=${SEP})(?:` +
    [
      String.raw`printable`,
      String.raw`print`,
      String.raw`final`,
      String.raw`rules?\s?book`,
      String.raw`rulebook`,
      String.raw`rules`,
      String.raw`colou?r`,
      String.raw`b\s?&\s?w`,
      String.raw`bw`,
      String.raw`gr[ae]yscale`,
      String.raw`low[\s_\-]?ink`,
      String.raw`ink[\s_\-]?friendly`,
      String.raw`a4`,
      String.raw`us[\s_\-]?letter`,
      String.raw`letter`,
      String.raw`compressed`,
      String.raw`copy`,
    ].join('|') +
    `)(?=$|${SEP})`,
  'gi',
);

const STOP_WORDS = /^(of|the|and|a|an|in|on|to|for|at|or|vs)$/;

function titleCase(words: string[]): string {
  return words
    .map((w, i) => {
      if (/^[A-Z0-9]{2,}$/.test(w) && w.length <= 4) return w; // keep short acronyms (RPG, 18)
      const lower = w.toLowerCase();
      if (i > 0 && STOP_WORDS.test(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/** camelCase / PascalCase -> words, separators -> spaces. */
function splitWords(s: string): string[] {
  return s
    .replace(/(?<=[a-zA-Z0-9])P[nN]P(?=$|[^a-zA-Z])/g, '') // glued "…PnP"
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2')
    .replace(/[_.+\-()[\]{}]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * "Sprawlopolis_PnP_v2.1.pdf"     -> "Sprawlopolis"
 * "MiniRogue-print-and-play.pdf"  -> "Mini Rogue"
 * "Palm-Island-PNP-FINAL.pdf"     -> "Palm Island"
 *
 * Noise and version stamps are removed **before** the camelCase split, so
 * "PnP" stays one token instead of becoming "Pn P" and version digits never
 * survive as orphan numbers.
 */
export function humaniseFilename(filename: string, fallback = 'Untitled game'): string {
  const base = filename.replace(/\.[a-z0-9]{1,8}$/i, '').trim();

  // 1. strip noise on the raw string, where separators are still intact
  let stripped = base;
  for (let i = 0; i < 3; i++) {
    const next = stripped.replace(NOISE_ANY, ' ').replace(NOISE_TRAILING, ' ');
    if (next === stripped) break;
    stripped = next;
  }

  // 2. split into words, then sweep once more (the split can expose "…PnP")
  let words = splitWords(stripped);
  const resweep = words.join(' ').replace(NOISE_ANY, ' ').replace(NOISE_TRAILING, ' ');
  words = splitWords(resweep);

  // 3. if stripping ate everything, fall back to the untouched filename
  if (words.join('').length < 2) {
    const raw = splitWords(base);
    const joined = raw.join('').toLowerCase();
    if (joined.length < 2 || joined === 'pnp' || joined === 'printandplay') return fallback;
    words = raw;
  }
  if (!words.length) return fallback;

  return titleCase(words);
}

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

/** "just now", "5 minutes ago", "yesterday", "2 days ago", "3 weeks ago", "12 Mar 2026". */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (abs < 45_000) return 'just now';
  if (!rtf) return new Date(ts).toLocaleDateString();
  if (abs < hour) return rtf.format(Math.round(diff / min), 'minute');
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
  if (abs < 7 * day) return rtf.format(Math.round(diff / day), 'day');
  if (abs < 35 * day) return rtf.format(Math.round(diff / (7 * day)), 'week');
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/* ---------------- files ---------------- */

export function isArchiveFile(f: File) {
  return /\.(pnpforge|zip)$/i.test(f.name);
}
export function isPdfFile(f: File) {
  return f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
}
export function isImageFile(f: File) {
  return f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(f.name);
}
export function isSourceFile(f: File) {
  return isPdfFile(f) || isImageFile(f);
}

/** Name a new game after the most meaningful file (first PDF, else first image). */
export function nameFromFiles(files: File[]): string {
  const main = files.find(isPdfFile) ?? files[0];
  return main ? humaniseFilename(main.name) : 'Untitled game';
}

/** Trigger a browser download of a same-origin URL (server sends Content-Disposition). */
export function downloadUrl(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Open a native file picker and resolve with the chosen files (empty if cancelled). */
export function pickFiles(opts: { accept?: string; multiple?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (opts.accept) input.accept = opts.accept;
    input.multiple = !!opts.multiple;
    input.style.display = 'none';
    let done = false;
    const finish = (files: File[]) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * A dialog that opens under the pointer would otherwise eat the second half of
 * a double-click as a backdrop dismissal (click → dialog opens → click closes
 * it → nothing on screen). Swallow stray backdrop presses for a moment after
 * opening. Escape, Cancel and the close button are untouched.
 */
export function guardStrayBackdropClick(ms = 350) {
  if (typeof window === 'undefined') return;
  const until = performance.now() + ms;
  const stop = (e: Event) => {
    if (performance.now() > until) return cleanup();
    const t = e.target as HTMLElement | null;
    if (t?.classList?.contains('ui-dialog-backdrop')) {
      e.stopPropagation();
      e.preventDefault();
    }
  };
  const cleanup = () => {
    for (const type of ['pointerdown', 'mousedown', 'click'] as const) window.removeEventListener(type, stop, true);
  };
  for (const type of ['pointerdown', 'mousedown', 'click'] as const) window.addEventListener(type, stop, true);
  window.setTimeout(cleanup, ms + 60);
}

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'range', 'color', 'submit', 'reset', 'file'].includes(type);
  }
  return false;
}
