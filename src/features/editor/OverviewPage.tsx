import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  ArrowRight,
  Check,
  Copy,
  Download,
  ImagePlus,
  Images,
  Play,
  Trash2,
} from 'lucide-react';
import { api, assetUrlById } from '@/api/client';
import type { Game, TableTheme } from '@/shared/types';
import { useGame } from '@/state/gameStore';
import { Button, Field, IconButton, ProgressBar, Switch, TextArea, TextInput, confirm, toast } from '@/ui';
import { GameCover } from '@/features/library/CoverArt';
import { dragHasFiles } from '@/features/library/useFileDrop';
import { downloadUrl, formatBytes, isImageFile, pickFiles, plural, relativeTime } from '@/features/library/util';
import { getChecklist, type ChecklistStep } from './checklist';
import { CoverPicker } from './CoverPicker';
import { ProgressRing } from './EditorShell';
import { useSessions } from './sessions';
import { TABLE_THEMES, getTableThemeStyle } from '@/features/play/table/theme';
import { TagInput } from './TagInput';
import './overview.css';

export default function OverviewPage() {
  const game = useGame((s) => s.game);
  const sessions = useSessions(game?.id);
  if (!game) return null;
  return (
    <div className="ov">
      <header className="ov-head">
        <h1 className="ov-head__title display">Overview</h1>
        <p className="ov-head__sub">Details, progress and sharing for this game.</p>
      </header>
      <Checklist game={game} sessionCount={sessions?.length} />
      <div className="ov-grid">
        <DetailsCard game={game} />
        <div className="ov-side">
          <MaterialCard game={game} />
          <StatsCard game={game} sessionCount={sessions?.length} />
          <ShareCard game={game} sessionCount={sessions?.length ?? 0} />
          <DangerCard game={game} sessionCount={sessions?.length ?? 0} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Getting-started checklist                                            */
/* ------------------------------------------------------------------ */

function Checklist({ game, sessionCount }: { game: Game; sessionCount: number | undefined }) {
  const navigate = useNavigate();
  const { steps, next, doneCount, total } = getChecklist(game, sessionCount);
  const [expanded, setExpanded] = useState(false);

  const go = async (e: React.MouseEvent, step: ChecklistStep) => {
    if (step.id !== 'play') return;
    e.preventDefault();
    await useGame.getState().flush();
    navigate(step.to);
  };

  if (sessionCount === undefined) return <div className="ov-check ov-check--loading" aria-hidden />;

  if (!next && !expanded) {
    return (
      <section className="ov-ready">
        <ProgressRing value={1} size={38} />
        <div className="ov-ready__text">
          <strong>Ready to play</strong>
          <span>Files added, pieces cut, table arranged — and it’s been played. Nice work.</span>
        </div>
        <Button variant="ghost" onClick={() => setExpanded(true)}>
          Show steps
        </Button>
        <Button variant="primary" icon={Play} onClick={(e) => void go(e, steps[3])}>
          Play
        </Button>
      </section>
    );
  }

  return (
    <section className="ov-check" aria-labelledby="ov-check-title">
      <div className="ov-check__head">
        <div>
          <h2 id="ov-check-title" className="ov-check__title">
            {next ? 'Getting started' : 'All steps done'}
          </h2>
          <p className="ov-check__sub">
            {next ? `${doneCount} of ${total} done · Next: ${next.title}` : 'Everything is set up.'}
          </p>
        </div>
        <div className="ov-check__bar">
          <ProgressBar value={doneCount / total} />
        </div>
        {!next && (
          <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>
            Hide
          </Button>
        )}
      </div>
      <ol className="ov-steps">
        {steps.map((s) => {
          const state = s.done ? 'done' : s === next ? 'next' : 'todo';
          return (
            <li key={s.id}>
              <Link to={s.to} className={`ov-step is-${state}`} onClick={(e) => void go(e, s)}>
                <span className="ov-step__badge">{s.done ? <Check size={15} strokeWidth={3} /> : s.n}</span>
                <span className="ov-step__title">{s.title}</span>
                <span className="ov-step__desc">{s.done ? s.summary : s.desc}</span>
                <span className="ov-step__cta">
                  {state === 'next' ? (
                    <span className="ui-btn ui-btn--primary ui-btn--sm">
                      {s.cta} <ArrowRight size={14} />
                    </span>
                  ) : (
                    <span className="ov-step__link">
                      {s.done ? 'Open' : s.cta} <ArrowRight size={13} />
                    </span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Details: cover + fields                                              */
/* ------------------------------------------------------------------ */

const PLAY_TIMES = ['5–10 min', '10–15 min', '15–20 min', '20–30 min', '30–45 min', '45–60 min', '60–90 min', '90+ min'];

function DetailsCard({ game }: { game: Game }) {
  const update = useGame((s) => s.update);
  return (
    <section className="ov-card ov-details">
      <h2 className="ov-card__title">Details</h2>
      <div className="ov-details__layout">
        <CoverEditor game={game} />
        <div className="ov-fields">
          <Field label="Name" htmlFor="ov-name">
            <TextInput
              id="ov-name"
              value={game.name}
              maxLength={120}
              onChange={(e) => update((g) => void (g.name = e.target.value), 'Rename game', { coalesceKey: 'name' })}
              onBlur={() => {
                if (!game.name.trim()) update((g) => void (g.name = 'Untitled game'), 'Rename game', { coalesceKey: 'name' });
              }}
            />
          </Field>
          <div className="ov-fields__row">
            <Field label="Designer" htmlFor="ov-designer">
              <TextInput
                id="ov-designer"
                value={game.designer}
                placeholder="Who made it?"
                onChange={(e) => update((g) => void (g.designer = e.target.value), 'Edit designer', { coalesceKey: 'designer' })}
              />
            </Field>
            <Field label="Play time" htmlFor="ov-playtime">
              <TextInput
                id="ov-playtime"
                value={game.playTime}
                placeholder="e.g. 20–30 min"
                list="ov-playtimes"
                onChange={(e) => update((g) => void (g.playTime = e.target.value), 'Edit play time', { coalesceKey: 'playTime' })}
              />
              <datalist id="ov-playtimes">
                {PLAY_TIMES.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </Field>
          </div>
          <Field label="Description" htmlFor="ov-desc">
            <TextArea
              id="ov-desc"
              rows={4}
              value={game.description}
              placeholder="What’s the game about? A line or two helps future-you pick it off the shelf."
              onChange={(e) => update((g) => void (g.description = e.target.value), 'Edit description', { coalesceKey: 'description' })}
            />
          </Field>
          <Field label="Tags" htmlFor="ov-tags">
            <TagInput id="ov-tags" value={game.tags} onChange={(tags) => update((g) => void (g.tags = tags), 'Edit tags')} />
          </Field>
        </div>
      </div>
    </section>
  );
}

function CoverEditor({ game }: { game: Game }) {
  const update = useGame((s) => s.update);
  const addAssets = useGame((s) => s.addAssets);
  const [progress, setProgress] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [picker, setPicker] = useState(false);
  const url = assetUrlById(game, game.cover);

  const upload = async (files: File[]) => {
    const file = files.find(isImageFile);
    if (!file) {
      if (files.length) toast.warning('Covers need to be an image', { description: 'Use a PNG, JPG or WebP file.' });
      return;
    }
    setProgress(0);
    try {
      const [asset] = await api.uploadAssets(game.id, [file], { role: 'cover', onProgress: setProgress });
      addAssets([asset]);
      update((g) => void (g.cover = asset.id), 'Change cover');
      setPicker(false);
    } catch (e: any) {
      toast.error('Couldn’t upload the cover', { description: e?.message });
    } finally {
      setProgress(null);
    }
  };

  const browse = async () => upload(await pickFiles({ accept: 'image/*' }));

  return (
    <div className="ov-cover">
      <div
        className={`ov-cover__frame ${over ? 'is-over' : ''}`}
        onDragEnter={(e) => {
          if (!dragHasFiles(e)) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragOver={(e) => {
          if (!dragHasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
        }}
        onDrop={(e) => {
          if (!dragHasFiles(e)) return;
          e.preventDefault();
          setOver(false);
          void upload(Array.from(e.dataTransfer.files));
        }}
      >
        <button type="button" className="ov-cover__hit" onClick={() => setPicker(true)} aria-label="Change cover">
          <GameCover src={url} name={game.name} className="ov-cover__img" />
          <span className="ov-cover__hover">
            <Images size={18} /> Change cover
          </span>
        </button>
        {!url && <span className="ov-cover__tag">Generated cover</span>}
        {over && (
          <div className="ov-cover__drop">
            <ImagePlus size={24} />
            Drop to use as cover
          </div>
        )}
        {progress != null && (
          <div className="ov-cover__progress">
            <ProgressBar value={progress} />
          </div>
        )}
      </div>
      <div className="ov-cover__side">
        <div className="ov-cover__actions">
          <Button size="sm" icon={ImagePlus} onClick={browse} loading={progress != null}>
            Upload
          </Button>
          <Button size="sm" icon={Images} onClick={() => setPicker(true)}>
            Choose
          </Button>
          {game.cover && (
            <IconButton
              size="sm"
              icon={Trash2}
              label="Remove cover"
              variant="danger"
              onClick={() => update((g) => void (g.cover = null), 'Remove cover')}
            />
          )}
        </div>
        <p className="ov-cover__hint">This is how the game looks on your shelf. Drop an image here, or pick a card or board from the game.</p>
      </div>
      <CoverPicker
        open={picker}
        game={game}
        onClose={() => setPicker(false)}
        onUpload={browse}
        onPick={(id) => {
          update((g) => void (g.cover = id), 'Change cover');
          setPicker(false);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Side cards                                                           */
/* ------------------------------------------------------------------ */

function MaterialCard({ game }: { game: Game }) {
  const update = useGame((s) => s.update);
  const current = game.table?.theme ?? 'felt-green';
  const set = (id: TableTheme) => update((g) => void (g.table = { ...g.table, theme: id }), 'Change table material');
  return (
    <section className="ov-card">
      <h2 className="ov-card__title">Table material</h2>
      <p className="ov-card__sub">The surface you play on.</p>
      <div className="ov-materials" role="radiogroup" aria-label="Table material">
        {TABLE_THEMES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={current === m.id}
            className={`ov-material ${current === m.id ? 'is-on' : ''}`}
            onClick={() => set(m.id)}
          >
            <span className="ov-material__swatch" style={getTableThemeStyle(m.id, 160)}>
              <span className="ov-material__card" />
              <span className="ov-material__card ov-material__card--2" />
              {current === m.id && (
                <span className="ov-material__check">
                  <Check size={12} strokeWidth={3} />
                </span>
              )}
            </span>
            <span className="ov-material__label">{m.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function StatsCard({ game, sessionCount }: { game: Game; sessionCount: number | undefined }) {
  const pages = game.sources.reduce((n, s) => n + s.pageCount, 0);
  const cards = game.components.reduce((n, c) => (c.kind === 'deck' ? n + c.cards.reduce((m, cd) => m + (cd.count ?? 1), 0) : n), 0);
  const pieces = Object.keys(game.setup.entities).length;
  const bytes = Object.values(game.assets).reduce((n, a) => n + (a.bytes ?? 0), 0);
  const stats: [string, number | string][] = [
    ['Files', game.sources.length],
    ['Pages', pages],
    ['Components', game.components.length],
    ['Cards', cards],
    ['On the table', pieces],
    ['Saved games', sessionCount ?? '–'],
  ];
  return (
    <section className="ov-card">
      <h2 className="ov-card__title">At a glance</h2>
      <dl className="ov-stats">
        {stats.map(([label, v]) => (
          <div key={label} className="ov-stat">
            <dd className="ov-stat__value display">{typeof v === 'number' ? v.toLocaleString() : v}</dd>
            <dt className="ov-stat__label">{label}</dt>
          </div>
        ))}
      </dl>
      <p className="ov-card__foot">
        Created {new Date(game.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · edited{' '}
        {relativeTime(game.updatedAt)} · {formatBytes(bytes)}
      </p>
    </section>
  );
}

function ShareCard({ game, sessionCount }: { game: Game; sessionCount: number }) {
  const navigate = useNavigate();
  const [withSaves, setWithSaves] = useState(false);
  const [busy, setBusy] = useState<'export' | 'dup' | null>(null);

  const doExport = async () => {
    setBusy('export');
    try {
      await useGame.getState().flush();
      downloadUrl(api.exportUrl(game.id, withSaves && sessionCount > 0));
      toast.success('Export started', { description: `“${game.name}.pnpforge” is downloading.` });
    } finally {
      setBusy(null);
    }
  };
  const duplicate = async () => {
    setBusy('dup');
    try {
      await useGame.getState().flush();
      const copy = await api.duplicateGame(game.id);
      toast.success(`Made a copy: “${copy.name}”`, {
        action: { label: 'Open copy', onClick: () => navigate(`/games/${copy.id}/edit/overview`) },
      });
    } catch (e: any) {
      toast.error('Couldn’t duplicate the game', { description: e?.message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="ov-card">
      <h2 className="ov-card__title">Share &amp; back up</h2>
      <p className="ov-card__sub">
        Export everything as a single <code>.pnpforge</code> file — import it from the library on any pnpforge.
      </p>
      <div className="ov-share__switch">
        <Switch
          checked={withSaves && sessionCount > 0}
          disabled={sessionCount === 0}
          onChange={setWithSaves}
          label={sessionCount ? `Include ${plural(sessionCount, 'saved game')}` : 'No saved games to include'}
        />
      </div>
      <div className="ov-share__actions">
        <Button variant="secondary" icon={Download} onClick={doExport} loading={busy === 'export'}>
          Export
        </Button>
        <Button variant="ghost" icon={Copy} onClick={duplicate} loading={busy === 'dup'}>
          Duplicate
        </Button>
      </div>
    </section>
  );
}

function DangerCard({ game, sessionCount }: { game: Game; sessionCount: number }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    const ok = await confirm({
      title: `Delete “${game.name}”?`,
      message: `${sessionCount ? `The game, its files and ${plural(sessionCount, 'saved game')}` : 'The game and its files'} will be removed from your library. This can’t be undone from the app — export it first if you might want it back.`,
      confirmLabel: 'Delete game',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await useGame.getState().flush();
      await api.deleteGame(game.id);
      navigate('/', { replace: true });
      useGame.getState().unload();
      toast.success(`Deleted “${game.name}”`);
    } catch (e: any) {
      toast.error('Couldn’t delete the game', { description: e?.message });
      setBusy(false);
    }
  };
  return (
    <section className="ov-card ov-danger">
      <h2 className="ov-card__title">Delete game</h2>
      <p className="ov-card__sub">Removes the game and everything in it from your library.</p>
      <Button variant="danger" icon={Trash2} onClick={remove} loading={busy}>
        Delete this game…
      </Button>
    </section>
  );
}
