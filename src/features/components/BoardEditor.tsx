import { useState } from 'react';
import { Link2, Link2Off, Ratio, TriangleAlert } from 'lucide-react';
import { Button, Field, IconButton, NumberField, Slider } from '@/ui';
import { useGame } from '@/state/gameStore';
import type { BoardComponent, Game, ID } from '@/shared/types';
import { fmtMm } from './lib';
import { BoardFace, fitBox } from './previews';
import { DetailHeader, ImageSlot, PanelSection, commitOnEnter, useComponentUpdate, useElementSize } from './common';

const r1 = (v: number) => Math.round(v * 10) / 10;

export function BoardEditor({ game, board }: { game: Game; board: BoardComponent }) {
  const up = useComponentUpdate<BoardComponent>(board.id);
  const [lock, setLock] = useState(true);
  const [stageRef, stage] = useElementSize<HTMLDivElement>();

  const img = board.image ? game.assets[board.image] : undefined;
  const imgAspect = img && img.width > 0 && img.height > 0 ? img.width / img.height : null;
  const aspect = board.width / board.height;
  const aspectOff = imgAspect != null && Math.abs(Math.log(aspect / imgAspect)) > 0.01;
  const dpi = img && img.width > 0 ? Math.round(img.width / (board.width / 25.4)) : null;

  const fit = fitBox(board.width, board.height, Math.max(60, stage.width - 72), Math.max(60, stage.height - 110));
  const scaleBarMm = board.width > 250 ? 100 : 50;

  const setW = (w: number) =>
    up((b) => {
      if (lock) b.height = r1(w / aspect);
      b.width = w;
    }, 'Resize board');
  const setH = (h: number) =>
    up((b) => {
      if (lock) b.width = r1(h * aspect);
      b.height = h;
    }, 'Resize board');
  const setImage = (id: ID | null) => {
    const a = id ? useGame.getState().game?.assets[id] : undefined;
    up((b) => {
      b.image = id;
      if (a && a.width > 0 && lock) b.height = r1((b.width * a.height) / a.width);
    }, id ? 'Change board image' : 'Remove board image');
  };
  const matchImage = () =>
    imgAspect &&
    up((b) => {
      b.height = r1(b.width / imgAspect);
    }, 'Match image proportions');
  const maxRadius = Math.min(30, Math.floor(Math.min(board.width, board.height) / 2));

  return (
    <div className="cmp-page">
      <DetailHeader comp={board} meta={`Board · ${fmtMm(board.width)} × ${fmtMm(board.height)} mm`} />
      <div className="cmp-split">
        <div className="cmp-stage" ref={stageRef}>
          {stage.width > 0 && (
            <div className="cmp-stage__center">
              <BoardFace game={game} board={board} width={fit.width} height={fit.height} className="cmp-lifted cmp-lifted--lg" />
              <div className="cmp-scalebar" style={{ width: scaleBarMm * fit.scale }}>
                <span>{scaleBarMm / 10} cm</span>
              </div>
            </div>
          )}
        </div>
        <aside className="cmp-side" onKeyDown={commitOnEnter}>
          <PanelSection title="Image">
            <ImageSlot
              game={game}
              assetId={board.image}
              onChange={setImage}
              role="image"
              pickerTitle="Choose the board image"
              width={Math.min(120, 120 * aspect)}
              height={Math.min(120, 120 / aspect)}
              radius={6}
            />
            {img && (
              <p className="cmp-note">
                {img.width} × {img.height} px
                {dpi != null && <> · about {dpi} dpi at this size</>}
              </p>
            )}
            {dpi != null && dpi < 110 && (
              <p className="cmp-note cmp-note--warn">
                <TriangleAlert size={14} /> Low resolution for this size, so it may look soft when zoomed in.
              </p>
            )}
          </PanelSection>

          <PanelSection
            title="Size"
            aside={
              <IconButton
                icon={lock ? Link2 : Link2Off}
                label={lock ? 'Proportions locked' : 'Proportions unlocked'}
                active={lock}
                size="sm"
                onClick={() => setLock(!lock)}
              />
            }
          >
            <div className="cmp-row2">
              <Field label="Width">
                <NumberField value={board.width} onChange={setW} min={20} max={2000} step={1} precision={1} unit="mm" className="cmp-num" aria-label="Board width" />
              </Field>
              <Field label="Height">
                <NumberField value={board.height} onChange={setH} min={20} max={2000} step={1} precision={1} unit="mm" className="cmp-num" aria-label="Board height" />
              </Field>
            </div>
            {aspectOff && (
              <div className="cmp-callout">
                <span>The image has different proportions, so it will be stretched.</span>
                <Button size="sm" icon={Ratio} onClick={matchImage}>
                  Match image
                </Button>
              </div>
            )}
          </PanelSection>

          <PanelSection title="Corners" aside={<span className="cmp-psec__value">{fmtMm(board.cornerRadius)} mm</span>}>
            <Slider
              value={board.cornerRadius}
              min={0}
              max={maxRadius}
              step={0.5}
              aria-label="Corner radius"
              onChange={(v) => up((b) => void (b.cornerRadius = v), 'Board corners', 'radius')}
            />
          </PanelSection>
        </aside>
      </div>
    </div>
  );
}
