import { useState } from 'react';
import { Palette, RotateCcw, RotateCw } from 'lucide-react';
import { Button, ColorField, Field, IconButton, NumberField, Segmented, toast } from '@/ui';
import { useGame } from '@/state/gameStore';
import type { Game, PieceComponent, PieceMaterial, PieceShape } from '@/shared/types';
import { PieceView } from '@/features/play/pieces/PieceView';
import { PIECE_MATERIALS, PIECE_SHAPES, PLAYER_COLORS, colorName, lookOf, pieceFrame } from '@/features/play/pieces/model';
import { getTableThemeStyle } from '@/features/play/table/theme';
import { describeComponent, pieceBaseName, pieceColourVariants, plural } from './lib';
import { DetailHeader, PanelSection, commitOnEnter, undoToast, useComponentUpdate, useElementSize } from './common';

const THUMB = 52;

export function PieceEditor({ game, piece }: { game: Game; piece: PieceComponent }) {
  const up = useComponentUpdate<PieceComponent>(piece.id);
  const update = useGame((s) => s.update);
  const [stageRef, stage] = useElementSize<HTMLDivElement>();
  const [yaw, setYaw] = useState(0);
  const look = lookOf(piece);
  const single = pieceFrame(look, false);
  const bowl = pieceFrame(look, true);
  const wide = stage.width > 560;
  // the piece large, its supply bowl beside it at the same scale when there is room
  const avail = wide ? Math.min((stage.width - 120) / (single.D + bowl.D * 0.9), (stage.height - 150) / Math.max(single.D, bowl.D)) : Math.min((stage.width - 60) / single.D, (stage.height - 190) / single.D);
  const scale = Math.max(3, Math.min(26, avail));
  const shapeMeta = PIECE_SHAPES.find((s) => s.id === piece.shape) ?? PIECE_SHAPES[0];
  const variants = pieceColourVariants(game, piece);

  const makeVariants = () => {
    const list = pieceColourVariants(useGame.getState().game ?? game, piece);
    if (!list.length) return;
    const own = colorName(piece.color);
    update((g) => {
      // name the original after its colour too, so the set reads "Meeple (Red)", "Meeple (Blue)"…
      const orig = g.components.find((c) => c.id === piece.id);
      if (orig && own && !orig.name.toLowerCase().includes(own.toLowerCase())) orig.name = `${pieceBaseName(piece)} (${own})`;
      g.components.push(...list);
    }, 'Make colour variants');
    toast.success(`Added ${plural(list.length, 'colour variant')}`, { description: list.map((c) => colorName(c.color)).join(', '), action: undoToast() });
  };

  const optLook = (patch: Partial<PieceComponent>) => lookOf({ ...piece, ...patch, size: 12 });

  return (
    <div className="cmp-page">
      <DetailHeader comp={piece} meta={`Game piece · ${describeComponent(piece)}`} />
      <div className="cmp-split">
        <div className="cmp-stage cmp-stage--piece" ref={stageRef}>
          {stage.width > 0 && (
            <div className="cmp-piece-table" style={getTableThemeStyle(game.table?.theme ?? 'felt-green')}>
              <figure className="cmp-piece-fig">
                <PieceView look={look} scale={scale} yaw={yaw} />
                <figcaption>One piece</figcaption>
              </figure>
              {wide && (
                <figure className="cmp-piece-fig">
                  <PieceView look={look} scale={scale * 0.9} yaw={yaw} supply />
                  <figcaption>As an infinite supply</figcaption>
                </figure>
              )}
            </div>
          )}
          <div className="cmp-piece-turn">
            <IconButton icon={RotateCcw} label="Turn left" onClick={() => setYaw((y) => y - 45)} />
            <span className="cmp-stage__hint">On {game.table?.theme ? 'your table' : 'the table'} · about {Math.round(scale / 4)}× real size</span>
            <IconButton icon={RotateCw} label="Turn right" onClick={() => setYaw((y) => y + 45)} />
          </div>
        </div>
        <aside className="cmp-side" onKeyDown={commitOnEnter}>
          <PanelSection title="Shape">
            <div className="cmp-piece-opts cmp-piece-opts--5" role="radiogroup" aria-label="Shape">
              {PIECE_SHAPES.map((s) => {
                const l = optLook({ shape: s.id as PieceShape });
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="radio"
                    aria-checked={piece.shape === s.id}
                    className={`cmp-piece-opt ${piece.shape === s.id ? 'is-on' : ''}`}
                    onClick={() =>
                      up((p) => {
                        if (p.shape !== s.id) {
                          p.shape = s.id;
                          p.size = s.defaultSize;
                        }
                      }, 'Piece shape')
                    }
                  >
                    <span className="cmp-piece-opt__art">
                      <PieceView look={l} scale={THUMB / pieceFrame(l, false).D} />
                    </span>
                    <span>{s.label}</span>
                  </button>
                );
              })}
            </div>
            {piece.shape === 'meeple' && (
              <Field label="Pose" inline>
                <Segmented<string>
                  value={piece.lying === false ? 'standing' : 'lying'}
                  onChange={(v) => up((p) => void (p.lying = v === 'lying'), 'Meeple pose')}
                  aria-label="Meeple pose"
                  options={[
                    { value: 'lying', label: 'Lying down' },
                    { value: 'standing', label: 'Standing' },
                  ]}
                />
              </Field>
            )}
          </PanelSection>
          <PanelSection title="Material">
            <div className="cmp-piece-opts cmp-piece-opts--3" role="radiogroup" aria-label="Material">
              {PIECE_MATERIALS.map((m) => {
                const l = optLook({ material: m.id as PieceMaterial });
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={piece.material === m.id}
                    title={m.hint}
                    className={`cmp-piece-opt ${piece.material === m.id ? 'is-on' : ''}`}
                    onClick={() => up((p) => void (p.material = m.id), 'Piece material')}
                  >
                    <span className="cmp-piece-opt__art is-table" style={getTableThemeStyle(game.table?.theme ?? 'felt-green')}>
                      <PieceView look={l} scale={THUMB / pieceFrame(l, false).D} />
                    </span>
                    <span>{m.label}</span>
                  </button>
                );
              })}
            </div>
          </PanelSection>
          <PanelSection title="Colour" aside={<span className="cmp-psec__value">{colorName(piece.color) ?? 'Custom'}</span>}>
            <ColorField value={piece.color} swatches={PLAYER_COLORS.map((c) => c.hex)} onChange={(c) => up((p) => void (p.color = c), 'Piece colour', 'color')} />
            <Button icon={Palette} onClick={makeVariants} disabled={!variants.length} className="cmp-piece-variants">
              {variants.length ? `Make it in every player colour (+${variants.length})` : 'Every player colour exists'}
            </Button>
          </PanelSection>
          <PanelSection title="Size">
            <Field label={shapeMeta.sizeLabel} inline>
              <NumberField value={piece.size} onChange={(v) => up((p) => void (p.size = v), 'Piece size')} min={5} max={60} step={1} precision={1} unit="mm" aria-label="Piece size" />
            </Field>
          </PanelSection>
        </aside>
      </div>
    </div>
  );
}
