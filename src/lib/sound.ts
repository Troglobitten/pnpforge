/**
 * Tiny WebAudio sound kit for the table — everything is synthesised, no files.
 *
 *   import { playSound, setMuted, useSoundMuted } from '@/lib/sound';
 *   playSound('place');
 *
 * On/off is the app-wide `sound` setting. Sounds are quiet and short on purpose. The AudioContext is only created
 * after the page has received a user gesture (no autoplay warnings).
 */
import { useSettings } from '@/state/settings';

export type SoundName = 'pickup' | 'place' | 'flip' | 'shuffle' | 'dice' | 'clink' | 'tap' | 'slide';

// On/off lives in the app settings (server-persisted, see src/state/settings.ts).
let ctx: AudioContext | null = null;
let out: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
const lastPlayed = new Map<SoundName, number>();

export function isMuted() {
  return !useSettings.getState().settings.sound;
}

export function setMuted(v: boolean) {
  useSettings.getState().set({ sound: !v });
}

export function useSoundMuted(): [boolean, (v: boolean) => void] {
  return [!useSettings((s) => s.settings.sound), setMuted];
}

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const ua = (navigator as any).userActivation as { hasBeenActive?: boolean } | undefined;
  if (!ctx) {
    if (ua && !ua.hasBeenActive) return null;
    const C: typeof AudioContext | undefined = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    out = ctx.createGain();
    out.gain.value = 0.5;
    out.connect(comp).connect(ctx.destination);
    const len = Math.floor(ctx.sampleRate * 1.2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

// Build the AudioContext (and its noise buffer) at idle right after the first user gesture, so
// the first sound — typically a dice roll — doesn't pay for it inside the frame that plays it.
if (typeof window !== 'undefined') {
  const warm = () => {
    window.removeEventListener('pointerdown', warm, true);
    window.removeEventListener('keydown', warm, true);
    const run = () => {
      if (!isMuted()) audio();
    };
    const ric = (window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(run, { timeout: 1500 });
    else window.setTimeout(run, 200);
  };
  window.addEventListener('pointerdown', warm, true);
  window.addEventListener('keydown', warm, true);
}

interface NoiseOpts {
  type?: BiquadFilterType;
  f?: number;
  f2?: number;
  q?: number;
  gain?: number;
  attack?: number;
}
function noise(c: AudioContext, t0: number, dur: number, o: NoiseOpts) {
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const filt = c.createBiquadFilter();
  filt.type = o.type ?? 'bandpass';
  filt.frequency.setValueAtTime(o.f ?? 2000, t0);
  if (o.f2) filt.frequency.exponentialRampToValueAtTime(o.f2, t0 + dur);
  filt.Q.value = o.q ?? 1;
  const g = c.createGain();
  const peak = Math.max(0.0002, o.gain ?? 0.1);
  const a = o.attack ?? 0.003;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(a + 0.005, dur));
  src.connect(filt).connect(g).connect(out!);
  src.start(t0, Math.random() * 0.8);
  src.stop(t0 + dur + 0.03);
}

interface ToneOpts {
  type?: OscillatorType;
  f: number;
  f2?: number;
  gain?: number;
  attack?: number;
}
function tone(c: AudioContext, t0: number, dur: number, o: ToneOpts) {
  const osc = c.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.f, t0);
  if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t0 + dur);
  const g = c.createGain();
  const a = o.attack ?? 0.002;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain ?? 0.05), t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(out!);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

const r = (a: number, b: number) => a + Math.random() * (b - a);

/** Play a sound. `volume` scales it (0..1.5). Rapid repeats are throttled. */
export function playSound(name: SoundName, opts: { volume?: number; delay?: number; count?: number } = {}) {
  if (isMuted()) return;
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? 0) < 28) return;
  lastPlayed.set(name, now);
  const c = audio();
  if (!c || !out || !noiseBuf) return;
  const v = opts.volume ?? 1;
  const t = c.currentTime + 0.005 + (opts.delay ?? 0);
  switch (name) {
    case 'pickup':
      noise(c, t, 0.15, { f: 900, f2: 2800, q: 0.9, gain: 0.07 * v, attack: 0.035 });
      break;
    case 'slide':
      noise(c, t, 0.22, { f: 700, f2: 1900, q: 0.7, gain: 0.06 * v, attack: 0.05 });
      break;
    case 'place':
      noise(c, t, 0.05, { type: 'lowpass', f: 1500, q: 0.6, gain: 0.2 * v });
      tone(c, t, 0.07, { f: 160, f2: 85, gain: 0.12 * v });
      break;
    case 'flip':
      noise(c, t, 0.035, { type: 'highpass', f: 2400, q: 0.7, gain: 0.1 * v });
      noise(c, t + 0.055, 0.05, { f: 1700, q: 1.2, gain: 0.08 * v });
      break;
    case 'shuffle': {
      let tt = t + 0.03;
      for (let i = 0; i < 28; i++) {
        noise(c, tt, 0.02, { f: r(2600, 4200), q: 2.2, gain: r(0.035, 0.07) * v });
        tt += 0.0165 * (1 - i / 70);
      }
      noise(c, tt + 0.04, 0.06, { type: 'lowpass', f: 1200, gain: 0.16 * v });
      tone(c, tt + 0.04, 0.07, { f: 140, f2: 80, gain: 0.09 * v });
      break;
    }
    case 'dice': {
      const count = Math.max(1, Math.floor(opts.count ?? 1));
      if (count > 1) {
        // A handful: each die lands on its own clock (the table tumble bounces at ~30/52/66% of
        // ~0.8 s), with quieter die-on-die clicks while they fly. Capped so thirty dice stay a
        // rattle, not a roar. The ~50 audio nodes are built just after the throw's commit task
        // (the first clack is ~0.1 s away), not inside the frame that starts thirty tumbles.
        const extra = (opts.delay ?? 0) - 0.02;
        window.setTimeout(() => {
          const t1 = c.currentTime + Math.max(0, extra);
          const voices = Math.min(count, 7);
          const per = 1 / Math.sqrt(voices);
          for (let k = 0; k < voices; k++) {
            const d = r(0.72, 0.86);
            [0.3, 0.52, 0.66].forEach((h, i) => {
              const at = t1 + d * h + r(-0.02, 0.03);
              const g = (i === 0 ? 1 : i === 1 ? 0.55 : 0.3) * per * v;
              noise(c, at, 0.035, { f: r(1400, 2900), q: 3, gain: 0.22 * g });
              tone(c, at, 0.045, { type: 'triangle', f: r(800, 1400), gain: 0.05 * g });
            });
          }
          const clicks = Math.min(count + 1, 6);
          for (let k = 0; k < clicks; k++) {
            const at = t1 + r(0.1, 0.4);
            noise(c, at, 0.02, { f: r(3000, 4600), q: 4, gain: 0.07 * v });
            tone(c, at, 0.03, { f: r(1900, 2700), gain: 0.02 * v });
          }
        }, 20);
        break;
      }
      const hits = [0, 0.14, 0.25, 0.33, 0.39, 0.435, 0.47];
      hits.forEach((h, i) => {
        const g = (1 - i / (hits.length + 1)) * v;
        noise(c, t + h, 0.035, { f: r(1500, 3000), q: 3, gain: 0.2 * g });
        tone(c, t + h, 0.045, { type: 'triangle', f: r(850, 1450), gain: 0.05 * g });
      });
      break;
    }
    case 'clink':
      tone(c, t, 0.12, { f: r(2300, 2500), gain: 0.04 * v });
      tone(c, t + 0.004, 0.08, { f: r(3600, 3900), gain: 0.022 * v });
      noise(c, t, 0.012, { type: 'highpass', f: 3800, gain: 0.05 * v });
      break;
    case 'tap':
      noise(c, t, 0.016, { f: 2600, q: 1.5, gain: 0.07 * v });
      tone(c, t, 0.03, { f: 1350, gain: 0.025 * v });
      break;
  }
}
