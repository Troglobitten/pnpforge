/** Messages between the photo engine (main thread) and its workers. */
import type { Quad } from './geom';

export interface CleanParams {
  /** 0..1 automatic white balance + levels. */
  color: number;
  /** 0..1 evening out uneven light. */
  flatten: number;
  /** Trimmed off every edge, in mm. */
  trimMm: number;
  /** Rounded corners filled, in mm (0 = square). */
  cornerMm: number;
}

/** A photo opened: what the screen needs. The user frames the pieces. */
export interface AnalyzeResult {
  width: number;
  height: number;
  takenAt: number | null;
  display: Blob;
  thumb: Blob;
}

export interface WarpParams {
  quad: Quad;
  wMm: number;
  hMm: number;
  clean: CleanParams;
  gains: [number, number, number] | null;
  /** Gains taken from another photo (this one shows no paper to measure the light by). */
  borrowed?: boolean;
  /** Preview: longest side in px, from the medium-resolution copy. */
  maxSide?: number;
  /** Final: resolution cap; never more than the photo really holds. */
  dpi?: number;
}

export interface WarpResult {
  blob?: Blob;
  bitmap?: ImageBitmap;
  width: number;
  height: number;
  /** 16×16 normalised greyscale, for "these look the same". */
  fp: number[];
  /** Fine structure print (see detailPrint): tells identical designs from similar layouts. */
  detail: number[];
}

export type WorkerRequest =
  | { type: 'analyze'; jobId: string; photoId: string; file: Blob }
  | { type: 'warp'; jobId: string; photoId: string; file: Blob; params: WarpParams; output: 'jpeg' | 'bitmap'; coalesce?: string }
  | { type: 'light'; jobId: string; photoId: string; file: Blob; quads: Quad[] }
  | { type: 'cancel'; jobId: string }
  | { type: 'forget'; photoId: string };

export type WorkerResponse =
  | { type: 'progress'; jobId: string; value: number; label: string }
  | { type: 'done'; jobId: string; result: unknown }
  | { type: 'error'; jobId: string; code: 'cancelled' | 'superseded' | 'decode' | 'heic' | 'failed'; message: string };
