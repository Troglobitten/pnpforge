import type { ReactNode } from 'react';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { Button, Dialog, ProgressBar } from '@/ui';
import type { Progress } from './make';

export type RunState =
  | { phase: 'running'; title: string; progress: Progress }
  | { phase: 'done'; title: string; description: string; previews: { url: string; aspect: number }[]; actions: ReactNode }
  | { phase: 'error'; title: string; message: string };

export function RunDialog({ state, onCancel, onClose }: { state: RunState | null; onCancel: () => void; onClose: () => void }) {
  if (!state) return null;
  if (state.phase === 'running')
    return (
      <Dialog open onClose={() => {}} dismissable={false} hideClose size="sm" title={state.title}>
        <div className="cut-run">
          <ProgressBar value={state.progress.value} />
          <div className="cut-run__row">
            <span>{state.progress.label}</span>
            <span className="cut-run__pct">{Math.round(state.progress.value * 100)}%</span>
          </div>
          <div className="cut-run__actions">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    );
  if (state.phase === 'error')
    return (
      <Dialog open onClose={onClose} size="sm" title={state.title} footer={<Button variant="primary" onClick={onClose}>OK</Button>}>
        <div className="cut-run__err">
          <TriangleAlert size={18} />
          <span>{state.message}</span>
        </div>
      </Dialog>
    );
  return (
    <Dialog open onClose={onClose} size="md" footer={state.actions} hideClose={false}>
      <div className="cut-done">
        <div className="cut-done__icon">
          <CheckCircle2 size={28} />
        </div>
        <h2 className="cut-done__title">{state.title}</h2>
        <p className="cut-done__desc">{state.description}</p>
        {state.previews.length > 0 && (
          <div className="cut-done__fan">
            {state.previews.slice(0, 7).map((p, i, arr) => {
              const mid = (arr.length - 1) / 2;
              return (
                <img
                  key={i}
                  src={p.url}
                  alt=""
                  style={{
                    aspectRatio: String(p.aspect),
                    transform: `translateY(${Math.abs(i - mid) * 6}px) rotate(${(i - mid) * 6}deg)`,
                    animationDelay: `${i * 45}ms`,
                    zIndex: i,
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
    </Dialog>
  );
}
