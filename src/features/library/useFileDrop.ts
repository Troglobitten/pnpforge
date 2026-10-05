import { useEffect, useRef, useState } from 'react';

export type DragInfo = { kind: 'create' | 'import' | 'mixed' | 'unknown'; count: number };

function describe(dt: DataTransfer | null): DragInfo {
  const items = dt ? Array.from(dt.items).filter((i) => i.kind === 'file') : [];
  let source = 0;
  let archive = 0;
  for (const it of items) {
    if (it.type === 'application/pdf' || it.type.startsWith('image/')) source++;
    else if (it.type === '' || /zip/.test(it.type)) archive++;
  }
  const count = items.length;
  if (!count) return { kind: 'unknown', count: 0 };
  if (source === count) return { kind: 'create', count };
  if (archive === count) return { kind: 'import', count };
  if (source + archive === count) return { kind: 'mixed', count };
  return { kind: 'unknown', count };
}

export const dragHasFiles = (e: DragEvent | React.DragEvent) =>
  !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

/**
 * Window-wide file drop target. Returns what is currently being dragged over
 * the window (for an overlay), or null. While `enabled` is false, file drops
 * are still swallowed (so a stray PDF never navigates the tab away) but no
 * overlay is shown; element-level drop zones that call preventDefault keep
 * working.
 */
export function useWindowFileDrop(enabled: boolean, onDrop: (files: File[]) => void): DragInfo | null {
  const [drag, setDrag] = useState<DragInfo | null>(null);
  const cb = useRef(onDrop);
  cb.current = onDrop;

  useEffect(() => {
    let depth = 0;
    const onEnter = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      depth++;
      if (enabled) setDrag(describe(e.dataTransfer));
    };
    const onOver = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      const handled = e.defaultPrevented;
      e.preventDefault();
      if (e.dataTransfer && !handled) e.dataTransfer.dropEffect = enabled ? 'copy' : 'none';
    };
    const onLeave = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDrag(null);
    };
    const onDropEv = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      const handled = e.defaultPrevented;
      e.preventDefault();
      depth = 0;
      setDrag(null);
      if (!enabled || handled) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) cb.current(files);
    };
    const reset = () => {
      depth = 0;
      setDrag(null);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDropEv);
    window.addEventListener('dragend', reset);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDropEv);
      window.removeEventListener('dragend', reset);
      setDrag(null);
    };
  }, [enabled]);

  return drag;
}
