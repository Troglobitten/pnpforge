import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button, ColorField, Field, NumberField, TextInput } from '@/ui';
import type { CounterComponent } from '@/shared/types';
import { DetailHeader, PanelSection, commitOnEnter, useComponentUpdate } from './common';
import { CounterWidget } from './previews';

export function CounterEditor({ counter }: { counter: CounterComponent }) {
  const up = useComponentUpdate<CounterComponent>(counter.id);
  const [value, setValue] = useState(counter.initial);
  useEffect(() => setValue(counter.initial), [counter.initial]);
  useEffect(() => setValue((v) => Math.min(counter.max, Math.max(counter.min, v))), [counter.min, counter.max]);

  const setMin = (min: number) =>
    up((c) => {
      c.min = min;
      if (c.max < min) c.max = min;
      c.initial = Math.min(c.max, Math.max(min, c.initial));
    }, 'Counter minimum');
  const setMax = (max: number) =>
    up((c) => {
      c.max = max;
      if (c.min > max) c.min = max;
      c.initial = Math.min(max, Math.max(c.min, c.initial));
    }, 'Counter maximum');

  return (
    <div className="cmp-page">
      <DetailHeader comp={counter} meta={`Counter · ${counter.min} to ${counter.max}, step ${counter.step}`} />
      <div className="cmp-split">
        <div className="cmp-stage">
          <div className="cmp-stage__center">
            <CounterWidget counter={counter} value={value} onChange={setValue} size="lg" />
            <p className="cmp-stage__hint cmp-stage__hint--static">
              Try it: this is how the counter looks and behaves on the table.
              {value !== counter.initial && (
                <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => setValue(counter.initial)}>
                  Reset
                </Button>
              )}
            </p>
          </div>
        </div>
        <aside className="cmp-side" onKeyDown={commitOnEnter}>
          <PanelSection title="Label">
            <TextInput
              value={counter.label}
              maxLength={24}
              placeholder="e.g. Health"
              aria-label="Counter label"
              onChange={(e) => up((c) => void (c.label = e.target.value), 'Counter label', 'label')}
            />
          </PanelSection>
          <PanelSection title="Values">
            <div className="cmp-row2">
              <Field label="Starts at">
                <NumberField
                  value={counter.initial}
                  onChange={(v) => up((c) => void (c.initial = v), 'Counter start')}
                  min={counter.min}
                  max={counter.max}
                  className="cmp-num"
                  aria-label="Starting value"
                />
              </Field>
              <Field label="Step">
                <NumberField value={counter.step} onChange={(v) => up((c) => void (c.step = v), 'Counter step')} min={1} max={1000} className="cmp-num" aria-label="Step" />
              </Field>
              <Field label="Minimum">
                <NumberField value={counter.min} onChange={setMin} min={-9999} max={9999} className="cmp-num" aria-label="Minimum" />
              </Field>
              <Field label="Maximum">
                <NumberField value={counter.max} onChange={setMax} min={-9999} max={9999} className="cmp-num" aria-label="Maximum" />
              </Field>
            </div>
          </PanelSection>
          <PanelSection title="Colour">
            <ColorField value={counter.color} onChange={(c) => up((x) => void (x.color = c), 'Counter colour', 'color')} />
          </PanelSection>
        </aside>
      </div>
    </div>
  );
}
