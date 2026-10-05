import { useState } from 'react';
import { Dices, ImagePlus, Images, X } from 'lucide-react';
import { Button, ColorField, Field, MenuButton, NumberField, Segmented, Spinner, TextInput, type MenuItem } from '@/ui';
import type { DieComponent, Game, ID } from '@/shared/types';
import { dieLabel, fmtMm, pickFiles, urlOf } from './lib';
import { Die3D, DieFaceView } from './previews';
import { DetailHeader, PanelSection, commitOnEnter, useComponentUpdate, useElementSize, useUploader } from './common';
import { pickAsset } from './AssetPicker';

const PRESETS = [4, 6, 8, 10, 12, 20];

export function DieEditor({ game, die }: { game: Game; die: DieComponent }) {
  const up = useComponentUpdate<DieComponent>(die.id);
  const [face, setFace] = useState(0);
  const [spins, setSpins] = useState(0);
  const [stageRef, stage] = useElementSize<HTMLDivElement>();
  const n = die.faces.length;
  const shown = Math.min(face, n - 1);
  const size = Math.max(120, Math.min(260, stage.width - 80, stage.height - 250));

  const setCount = (count: number) =>
    up((d) => {
      if (count < d.faces.length) d.faces.length = count;
      else for (let i = d.faces.length; i < count; i++) d.faces.push({ value: i + 1 });
    }, 'Number of faces');

  const roll = () => {
    setSpins((s) => s + 1);
    setFace(Math.floor(Math.random() * n));
  };

  return (
    <div className="cmp-page">
      <DetailHeader comp={die} meta={`Die · ${dieLabel(die)} · ${fmtMm(die.size)} mm`} />
      <div className="cmp-split">
        <div className="cmp-stage cmp-stage--die" ref={stageRef}>
          <div className="cmp-die-stage">
            <button type="button" className="cmp-die-stage__die" onClick={roll} aria-label="Roll the die">
              <Die3D game={game} die={die} size={size} face={shown} spins={spins} />
            </button>
            <Button icon={Dices} onClick={roll}>
              Roll
            </Button>
            <div className="cmp-die-strip" role="listbox" aria-label="Faces">
              {die.faces.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  role="option"
                  aria-selected={i === shown}
                  aria-label={`Show face ${i + 1}`}
                  className={`cmp-die-strip__item ${i === shown ? 'is-on' : ''}`}
                  onClick={() => setFace(i)}
                >
                  <DieFaceView game={game} die={die} index={i} size={40} />
                </button>
              ))}
            </div>
          </div>
        </div>
        <aside className="cmp-side" onKeyDown={commitOnEnter}>
          <PanelSection title="Faces">
            <Segmented<string>
              value={PRESETS.includes(n) ? `d${n}` : 'custom'}
              onChange={(v) => v !== 'custom' && setCount(Number(v.slice(1)))}
              aria-label="Die type"
              className="cmp-seg-fill"
              options={[...PRESETS.map((p) => ({ value: `d${p}`, label: `d${p}` })), ...(PRESETS.includes(n) ? [] : [{ value: 'custom', label: `${n}` }])]}
            />
            <Field label="Number of faces" inline>
              <NumberField value={n} onChange={setCount} min={2} max={100} step={1} aria-label="Number of faces" />
            </Field>
          </PanelSection>
          <PanelSection title="Look">
            <Field label="Size (edge)" inline>
              <NumberField value={die.size} onChange={(v) => up((d) => void (d.size = v), 'Die size')} min={6} max={60} step={1} unit="mm" aria-label="Die size" />
            </Field>
            <Field label="Body colour">
              <ColorField value={die.color} onChange={(c) => up((d) => void (d.color = c), 'Die colour', 'color')} />
            </Field>
            <Field label="Ink colour">
              <ColorField value={die.inkColor} onChange={(c) => up((d) => void (d.inkColor = c), 'Die ink colour', 'ink')} />
            </Field>
          </PanelSection>
          <PanelSection title="Face by face" aside={<span className="cmp-psec__value">value · label · image</span>}>
            <ol className="cmp-facelist">
              {die.faces.map((f, i) => (
                <li key={i} className={`cmp-facelist__row ${i === shown ? 'is-on' : ''}`} onFocusCapture={() => setFace(i)}>
                  <button type="button" className="cmp-facelist__prev" onClick={() => setFace(i)} aria-label={`Show face ${i + 1}`}>
                    <DieFaceView game={game} die={die} index={i} size={36} />
                  </button>
                  <NumberField
                    size="sm"
                    value={f.value ?? i + 1}
                    onChange={(v) => up((d) => void (d.faces[i].value = v), 'Face value')}
                    step={1}
                    aria-label={`Face ${i + 1} value`}
                    className="cmp-facelist__val"
                  />
                  <TextInput
                    className="cmp-facelist__label"
                    value={f.label ?? ''}
                    placeholder="Label"
                    maxLength={6}
                    aria-label={`Face ${i + 1} label`}
                    onChange={(e) => up((d) => void (d.faces[i].label = e.target.value || undefined), 'Face label', `label${i}`)}
                  />
                  <FaceImage game={game} image={f.image ?? null} index={i} onChange={(id) => up((d) => void (d.faces[i].image = id), 'Face image')} />
                </li>
              ))}
            </ol>
          </PanelSection>
        </aside>
      </div>
    </div>
  );
}

function FaceImage({ game, image, index, onChange }: { game: Game; image: ID | null; index: number; onChange: (id: ID | null) => void }) {
  const { upload, busy } = useUploader();
  const url = urlOf(game, image);
  const items: MenuItem[] = [
    { type: 'label', label: `Face ${index + 1} image` },
    {
      label: 'Upload an image…',
      icon: ImagePlus,
      onSelect: async () => {
        const f = await pickFiles({ multiple: false });
        const [a] = await upload(f, 'image');
        if (a) onChange(a.id);
      },
    },
    {
      label: 'Choose from game images…',
      icon: Images,
      onSelect: async () => {
        const id = await pickAsset({ title: `Image for face ${index + 1}`, current: image });
        if (id) onChange(id);
      },
    },
    ...(image ? [{ type: 'separator' as const }, { label: 'Remove image', icon: X, danger: true, onSelect: () => onChange(null) }] : []),
  ];
  return (
    <MenuButton items={items} placement="bottom-end" minWidth={230}>
      <button
        type="button"
        className={`cmp-facelist__img ${url ? 'has-image' : ''}`}
        aria-label={url ? `Change face ${index + 1} image` : `Add an image to face ${index + 1}`}
        title={url ? 'Change image' : 'Add image'}
        disabled={busy}
      >
        {busy ? <Spinner size={14} /> : url ? <img src={url} alt="" draggable={false} /> : <ImagePlus size={15} />}
      </button>
    </MenuButton>
  );
}
