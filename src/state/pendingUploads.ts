import type { ID } from '@/shared/types';

/**
 * In-memory hand-off for files the user dropped somewhere else (e.g. a PDF
 * dropped on the library to create a new game). The Sources page consumes
 * them on mount and imports them with its normal progress UI.
 */
const pending = new Map<ID, File[]>();

export function setPendingUploads(gameId: ID, files: File[]) {
  pending.set(gameId, [...(pending.get(gameId) ?? []), ...files]);
}

export function takePendingUploads(gameId: ID): File[] {
  const files = pending.get(gameId) ?? [];
  pending.delete(gameId);
  return files;
}
