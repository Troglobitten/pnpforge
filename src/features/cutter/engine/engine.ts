/**
 * Main-thread side of the photo engine: a small pool of workers (created the
 * first time photo import is used, never before), jobs with progress and
 * cancel, and per-photo worker affinity so a photo's decoded pixels are reused.
 */
import type { Quad } from './geom';
import type { AnalyzeResult, WarpParams, WarpResult, WorkerRequest, WorkerResponse } from './engineTypes';

export class EngineError extends Error {
  constructor(
    public code: 'cancelled' | 'superseded' | 'decode' | 'heic' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

export interface Job<T> {
  id: string;
  promise: Promise<T>;
  cancel: () => void;
}

interface Pending {
  worker: Worker;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onProgress?: (value: number, label: string) => void;
}

let seq = 0;

class PhotoEngine {
  private workers: Worker[] = [];
  private load: number[] = [];
  private affinity = new Map<string, number>();
  private pending = new Map<string, Pending>();
  private next = 0;

  constructor() {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    const n = Math.max(1, Math.min(3, cores - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./photo.worker.ts', import.meta.url), { type: 'module', name: `photos-${i + 1}` });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
      w.onerror = (e) => {
        e.preventDefault();
        for (const [id, p] of this.pending)
          if (p.worker === w) {
            this.pending.delete(id);
            p.reject(new EngineError('failed', 'The photo engine stopped unexpectedly.'));
          }
      };
      this.workers.push(w);
      this.load.push(0);
    }
  }

  get size() {
    return this.workers.length;
  }

  private workerFor(photoId: string): number {
    let i = this.affinity.get(photoId);
    if (i == null) {
      // least busy worker, round-robin on ties
      let best = this.next % this.workers.length;
      for (let k = 0; k < this.workers.length; k++) {
        const c = (this.next + k) % this.workers.length;
        if (this.load[c] < this.load[best]) best = c;
      }
      this.next++;
      i = best;
      this.affinity.set(photoId, i);
    }
    return i;
  }

  private onMessage(m: WorkerResponse) {
    const p = this.pending.get(m.jobId);
    if (!p) return;
    if (m.type === 'progress') {
      p.onProgress?.(m.value, m.label);
      return;
    }
    this.pending.delete(m.jobId);
    const wi = this.workers.indexOf(p.worker);
    if (wi >= 0) this.load[wi] = Math.max(0, this.load[wi] - 1);
    if (m.type === 'done') p.resolve(m.result);
    else p.reject(new EngineError(m.code, m.message));
  }

  private run<T>(photoId: string, make: (jobId: string) => WorkerRequest, onProgress?: (value: number, label: string) => void): Job<T> {
    const id = `j${++seq}`;
    const wi = this.workerFor(photoId);
    const worker = this.workers[wi];
    this.load[wi]++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { worker, resolve: resolve as (v: unknown) => void, reject, onProgress });
    });
    worker.postMessage(make(id));
    return { id, promise, cancel: () => worker.postMessage({ type: 'cancel', jobId: id } satisfies WorkerRequest) };
  }

  analyze(photoId: string, file: Blob, onProgress?: (value: number, label: string) => void): Job<AnalyzeResult> {
    return this.run(photoId, (jobId) => ({ type: 'analyze', jobId, photoId, file }), onProgress);
  }

  /** A preview (JPEG). Newer previews for the same `coalesce` key replace queued older ones. */
  preview(photoId: string, file: Blob, params: WarpParams, coalesce?: string): Job<WarpResult> {
    return this.run(photoId, (jobId) => ({ type: 'warp', jobId, photoId, file, params, output: 'jpeg', coalesce }));
  }

  /** Full-resolution result as an ImageBitmap. */
  render(photoId: string, file: Blob, params: WarpParams): Job<WarpResult> {
    return this.run(photoId, (jobId) => ({ type: 'warp', jobId, photoId, file, params, output: 'bitmap' }));
  }

  /** White-balance gains from the paper inside these frames (null = no paper to judge by). */
  light(photoId: string, file: Blob, quads: Quad[]): Job<[number, number, number] | null> {
    return this.run(photoId, (jobId) => ({ type: 'light', jobId, photoId, file, quads }));
  }

  forget(photoId: string) {
    const i = this.affinity.get(photoId);
    if (i != null) this.workers[i].postMessage({ type: 'forget', photoId } satisfies WorkerRequest);
    this.affinity.delete(photoId);
  }
}

let engine: PhotoEngine | null = null;
/** The engine (workers start on first use, only on the photo import page). */
export function getEngine(): PhotoEngine {
  if (!engine) engine = new PhotoEngine();
  return engine;
}
export type { PhotoEngine };
