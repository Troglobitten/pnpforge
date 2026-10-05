import { Circle, Hexagon, RectangleHorizontal, Square } from 'lucide-react';
import { ColorField, Field, NumberField, Segmented, TextInput } from '@/ui';
import type { Game, TokenComponent, TokenShape } from '@/shared/types';
import { describeComponent } from './lib';
import { TokenFace, tokenPx } from './previews';
import { DetailHeader, ImageSlot, PanelSection, commitOnEnter, useComponentUpdate, useElementSize } from './common';

export function TokenEditor({ game, token }: { game: Game; token: TokenComponent }) {
  const up = useComponentUpdate<TokenComponent>(token.id);
  const [stageRef, stage] = useElementSize<HTMLDivElement>();
  const rect = token.shape === 'rect';
  const hMm = rect ? token.height : token.width;
  const wide = stage.width > 520;
  // Both faces side by side (or stacked on narrow stages), at most 9× life size.
  const scale = Math.min(
    9,
    wide ? (stage.width - 160) / 2 / token.width : (stage.width - 80) / token.width,
    wide ? (stage.height - 130) / hMm : (stage.height - 180) / 2 / hMm,
  );
  const s = Math.max(1, scale);
  const px = tokenPx(token, s);

  const setShape = (shape: TokenShape) =>
    up((t) => {
      if (shape === 'rect' && t.shape !== 'rect' && Math.abs(t.width - t.height) < 0.1) t.height = Math.round(t.width * 0.66);
      if (shape !== 'rect') t.height = t.width;
      t.shape = shape;
    }, 'Token shape');
  const setW = (w: number) =>
    up((t) => {
      t.width = w;
      if (t.shape !== 'rect') t.height = w;
    }, 'Token size');

  const faceRadius = token.shape === 'round' ? '50%' : token.shape === 'hex' ? 0 : 10;

  return (
    <div className="cmp-page">
      <DetailHeader comp={token} meta={`Tokens · ${describeComponent(token)}`} />
      <div className="cmp-split">
        <div className="cmp-stage" ref={stageRef}>
          {stage.width > 0 && (
            <div className={`cmp-faces ${wide ? '' : 'cmp-faces--stack'}`}>
              {(['front', 'back'] as const).map((side) => (
                <figure key={side} className="cmp-faces__item">
                  <div className="cmp-faces__box" style={{ width: px.width, height: px.height }}>
                    <TokenFace game={game} token={token} side={side} scale={s} className="cmp-token--lg" />
                  </div>
                  <figcaption>{side === 'front' ? 'Front' : 'Back'}</figcaption>
                </figure>
              ))}
            </div>
          )}
          <div className="cmp-stage__hint">Shown at about {Math.round(s)}× real size</div>
        </div>
        <aside className="cmp-side" onKeyDown={commitOnEnter}>
          <PanelSection title="Shape">
            <Segmented<TokenShape>
              value={token.shape}
              onChange={setShape}
              aria-label="Token shape"
              className="cmp-seg-fill"
              options={[
                { value: 'round', icon: Circle, label: 'Round' },
                { value: 'square', icon: Square, label: 'Square' },
                { value: 'rect', icon: RectangleHorizontal, label: 'Rect' },
                { value: 'hex', icon: Hexagon, label: 'Hex' },
              ]}
            />
          </PanelSection>
          <PanelSection title="Size">
            {rect ? (
              <div className="cmp-row2">
                <Field label="Width">
                  <NumberField value={token.width} onChange={setW} min={5} max={200} step={1} precision={1} unit="mm" className="cmp-num" aria-label="Token width" />
                </Field>
                <Field label="Height">
                  <NumberField
                    value={token.height}
                    onChange={(h) => up((t) => void (t.height = h), 'Token size')}
                    min={5}
                    max={200}
                    step={1}
                    precision={1}
                    unit="mm"
                    className="cmp-num"
                    aria-label="Token height"
                  />
                </Field>
              </div>
            ) : (
              <Field label={token.shape === 'round' ? 'Diameter' : 'Width'}>
                <NumberField value={token.width} onChange={setW} min={5} max={200} step={1} precision={1} unit="mm" className="cmp-num" aria-label="Token size" />
              </Field>
            )}
          </PanelSection>
          <PanelSection title="Front">
            <ImageSlot
              game={game}
              assetId={token.front}
              onChange={(id) => up((t) => void (t.front = id), id ? 'Token front image' : 'Remove token front')}
              pickerTitle="Choose the token front"
              width={72}
              height={72}
              radius={faceRadius}
              shape={token.shape === 'hex' ? 'hex' : undefined}
              emptyLabel="Colour"
            />
          </PanelSection>
          <PanelSection title="Back">
            <ImageSlot
              game={game}
              assetId={token.back}
              onChange={(id) => up((t) => void (t.back = id), id ? 'Token back image' : 'Remove token back')}
              pickerTitle="Choose the token back"
              width={72}
              height={72}
              radius={faceRadius}
              shape={token.shape === 'hex' ? 'hex' : undefined}
              emptyLabel="Colour"
            />
          </PanelSection>
          <PanelSection title="Without an image">
            <Field label="Colour">
              <ColorField value={token.color} onChange={(c) => up((t) => void (t.color = c), 'Token colour', 'color')} />
            </Field>
            <Field label="Label" hint="Short text printed on faces that have no image.">
              <TextInput
                value={token.label ?? ''}
                maxLength={8}
                placeholder="e.g. 1, ★, Gold"
                onChange={(e) => up((t) => void (t.label = e.target.value), 'Token label', 'label')}
              />
            </Field>
          </PanelSection>
        </aside>
      </div>
    </div>
  );
}
