import { create } from 'zustand';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Portal } from './floating';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: ReactNode;
  description?: ReactNode;
  action?: { label: string; onClick: () => void };
  duration: number;
}

const useToasts = create<{ items: ToastItem[]; push: (t: ToastItem) => void; remove: (id: number) => void }>((set) => ({
  items: [],
  push: (t) => set((s) => ({ items: [...s.items.slice(-3), t] })),
  remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}));

let seq = 1;

export function toast(
  title: ReactNode,
  opts: { kind?: ToastKind; description?: ReactNode; action?: { label: string; onClick: () => void }; duration?: number } = {},
) {
  const id = seq++;
  const item: ToastItem = {
    id,
    kind: opts.kind ?? 'info',
    title,
    description: opts.description,
    action: opts.action,
    duration: opts.duration ?? (opts.action ? 6000 : 3200),
  };
  useToasts.getState().push(item);
  if (item.duration > 0) window.setTimeout(() => useToasts.getState().remove(id), item.duration);
  return id;
}
toast.success = (title: ReactNode, o: Parameters<typeof toast>[1] = {}) => toast(title, { ...o, kind: 'success' });
toast.error = (title: ReactNode, o: Parameters<typeof toast>[1] = {}) => toast(title, { ...o, kind: 'error', duration: o.duration ?? 6000 });
toast.warning = (title: ReactNode, o: Parameters<typeof toast>[1] = {}) => toast(title, { ...o, kind: 'warning' });
toast.dismiss = (id: number) => useToasts.getState().remove(id);

const ICONS = { info: Info, success: CheckCircle2, warning: AlertTriangle, error: XCircle };

/** Mount once near the app root. */
export function Toaster() {
  const { items, remove } = useToasts();
  return (
    <Portal>
      <div className="ui-toaster" aria-live="polite">
        {items.map((t) => {
          const Icon = ICONS[t.kind];
          return (
            <div key={t.id} className={`ui-toast ui-toast--${t.kind}`} role="status">
              <Icon size={18} className="ui-toast__icon" />
              <div className="ui-toast__body">
                <div className="ui-toast__title">{t.title}</div>
                {t.description && <div className="ui-toast__desc">{t.description}</div>}
              </div>
              {t.action && (
                <button
                  className="ui-toast__action"
                  onClick={() => {
                    t.action!.onClick();
                    remove(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button className="ui-toast__close" aria-label="Dismiss" onClick={() => remove(t.id)}>
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </Portal>
  );
}
