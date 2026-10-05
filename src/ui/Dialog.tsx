import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { create } from 'zustand';
import { Portal } from './floating';
import { Button } from './Button';
import { TextInput } from './Fields';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** Close when clicking the backdrop (default true). */
  dismissable?: boolean;
  className?: string;
  hideClose?: boolean;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissable = true,
  className,
  hideClose,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement;
    const t = window.setTimeout(() => {
      const el = panelRef.current?.querySelector<HTMLElement>('[autofocus], [data-autofocus]')
        ?? panelRef.current?.querySelector<HTMLElement>('input, textarea, select, button:not(.ui-dialog__close)');
      (el ?? panelRef.current)?.focus();
    }, 20);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey, true);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <Portal>
      <div
        className="ui-dialog-backdrop"
        onPointerDown={(e) => {
          if (dismissable && e.target === e.currentTarget) onClose();
        }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          className={`ui-dialog ui-dialog--${size} ${className ?? ''}`}
        >
          {(title || !hideClose) && (
            <div className="ui-dialog__head">
              <div>
                {title && <h2 className="ui-dialog__title">{title}</h2>}
                {description && <p className="ui-dialog__desc">{description}</p>}
              </div>
              {!hideClose && (
                <button className="ui-dialog__close" aria-label="Close" onClick={onClose}>
                  <X size={18} />
                </button>
              )}
            </div>
          )}
          {children != null && <div className="ui-dialog__body">{children}</div>}
          {footer && <div className="ui-dialog__foot">{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}

/* ------------------------------------------------------------------ */
/* Imperative confirm() / promptText()                                 */
/* ------------------------------------------------------------------ */

interface ConfirmOpts {
  title: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}
interface PromptOpts {
  title: ReactNode;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
}

type Req =
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void };

const useDialogQueue = create<{ current: Req | null; set: (r: Req | null) => void }>((set) => ({
  current: null,
  set: (current) => set({ current }),
}));

export function confirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => useDialogQueue.getState().set({ kind: 'confirm', opts, resolve }));
}

export function promptText(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => useDialogQueue.getState().set({ kind: 'prompt', opts, resolve }));
}

/** Mount once near the app root. */
export function DialogHost() {
  const { current, set } = useDialogQueue();
  const [text, setText] = useState('');
  useEffect(() => {
    if (current?.kind === 'prompt') setText(current.opts.initial ?? '');
  }, [current]);
  if (!current) return null;

  const close = (value: any) => {
    (current.resolve as (v: unknown) => void)(value);
    set(null);
  };

  if (current.kind === 'confirm') {
    const o = current.opts;
    return (
      <Dialog
        open
        size="sm"
        title={o.title}
        onClose={() => close(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              {o.cancelLabel ?? 'Cancel'}
            </Button>
            <Button variant={o.danger ? 'danger' : 'primary'} onClick={() => close(true)} data-autofocus>
              {o.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        {o.message && <div className="ui-dialog__message">{o.message}</div>}
      </Dialog>
    );
  }

  const o = current.opts;
  return (
    <Dialog
      open
      size="sm"
      title={o.title}
      onClose={() => close(null)}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(null)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!text.trim()} onClick={() => close(text.trim())}>
            {o.confirmLabel ?? 'Save'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) close(text.trim());
        }}
      >
        {o.label && <label className="ui-field__label">{o.label}</label>}
        <TextInput
          autoFocus
          value={text}
          placeholder={o.placeholder}
          onChange={(e) => setText(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
      </form>
    </Dialog>
  );
}
