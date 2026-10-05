import { nanoid } from 'nanoid';

/** Short unique id for new entities / card instances. */
export const newId = () => nanoid(12);

/** Unbiased random integer in [0, n) using the platform CSPRNG when available. */
export function randomInt(n: number): number {
  if (n <= 1) return 0;
  const c = (globalThis as any).crypto as Crypto | undefined;
  if (c?.getRandomValues) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / n) * n;
    let v: number;
    do {
      c.getRandomValues(buf);
      v = buf[0];
    } while (v >= limit);
    return v % n;
  }
  return Math.floor(Math.random() * n);
}

export type Rng = (n: number) => number;
