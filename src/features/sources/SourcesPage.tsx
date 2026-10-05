import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { cutterLink, groupsFromSource, useCutterDoc } from '@/features/cutter/provenance';
import { useNavigate, useParams } from 'react-router';
import {
  BookOpen,
  BookX,
  Camera,
  CheckCircle2,
  FileImage,
  FileText,
  MoreHorizontal,
  Pencil,
  Ruler,
  Scissors,
  Trash2,
  Upload,
  X,
  XCircle,
  Layers,
  LayoutGrid,
  Dices,
} from 'lucide-react';
import { useGame } from '@/state/gameStore';
import { takePendingUploads } from '@/state/pendingUploads';
import { api, assetUrlById } from '@/api/client';
import { Badge, Button, IconButton, MenuButton, ProgressBar, Spinner, confirm, promptText, toast, type MenuItem } from '@/ui';
import type { Game, SourceDoc } from '@/shared/types';
import { pageSizeLabel, paperName } from '@/shared/paper';
import { fmtBytes, recentSources } from './importFiles';
import { addFiles, dismissAddTask, useAddTasks, type AddTask } from '@/features/cutter/addSources';
import './sources.css';

const ACCEPT = 'application/pdf,.pdf,image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';

export default function SourcesPage() {
  const { gameId = '' } = useParams();
  const game = useGame((s) => s.game);
  const allTasks = useAddTasks((s) => s.tasks);
  const tasks = useMemo(() => allTasks.filter((t) => t.gameId === gameId), [allTasks, gameId]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const navigate = useNavigate();

  // Files dropped on the library to create this game.
  useEffect(() => {
    const files = takePendingUploads(gameId);
    if (files.length) void addFiles(gameId, files);
  }, [gameId]);

  // Accept drops anywhere in the window while this page is open.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void addFiles(gameId, files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [gameId]);

  if (!game) return null;
  const sources = game.sources;
  const browse = () => inputRef.current?.click();
  const empty = sources.length === 0;

  return (
    <div className="sources-page">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        data-testid="sources-file-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void addFiles(gameId, files);
        }}
      />

      <header className="sources-head">
        <div>
          <h1 className="sources-head__title">Sources</h1>
          <p className="sources-head__sub">Your original print-and-play files. Cut cards, boards and tokens out of them.</p>
        </div>
        <div className="sources-head__actions">
          {/* v3: the one Cutter for PDFs, scans and photos (the old cutters stay until the switch-over) */}
          <Button variant="primary" icon={Scissors} onClick={() => navigate(`/games/${gameId}/edit/cut`)} data-testid="open-cutter">
            Cutter
          </Button>
          {!empty && (
            <Button icon={Upload} onClick={browse}>
              Add files
            </Button>
          )}
        </div>
      </header>

      {empty && tasks.length === 0 && <BigDropZone onBrowse={browse} />}

      {tasks.length > 0 && (
        <section className="sources-imports" aria-label="Imports">
          {tasks.map((t) => (
            <ImportRow key={t.id} task={t} />
          ))}
        </section>
      )}

      {!empty && (
        <>
          <div className="sources-grid">
            {sources.map((s) => (
              <SourceCard key={s.id} game={game} source={s} />
            ))}
          </div>
          <button type="button" className="sources-dropstrip" onClick={browse}>
            <Upload size={18} />
            <span>
              <strong>Drop more files here</strong> or click to browse — PDF, PNG, JPG or WebP
            </span>
          </button>
        </>
      )}

      {empty && tasks.length > 0 && (
        <button type="button" className="sources-dropstrip" onClick={browse}>
          <Upload size={18} />
          <span>
            <strong>Add more files</strong> — drop them anywhere on this page
          </span>
        </button>
      )}

      {dragging && (
        <div className="sources-veil" aria-hidden>
          <div className="sources-veil__card">
            <Upload size={34} />
            <div className="sources-veil__title">Drop to add to “{game.name}”</div>
            <div className="sources-veil__sub">PDFs and images become sources you can cut up</div>
          </div>
        </div>
      )}
    </div>
  );
}

function BigDropZone({ onBrowse }: { onBrowse: () => void }) {
  const [over, setOver] = useState(false);
  const on = (e: ReactDragEvent) => {
    e.preventDefault();
    setOver(e.type === 'dragenter' || e.type === 'dragover');
  };
  return (
    <div className="sources-empty">
      <button
        type="button"
        className={`sources-drop ${over ? 'is-over' : ''}`}
        onClick={onBrowse}
        onDragEnter={on}
        onDragOver={on}
        onDragLeave={() => setOver(false)}
        onDrop={() => setOver(false)}
      >
        <div className="sources-drop__art" aria-hidden>
          <div className="sources-drop__sheet sources-drop__sheet--back" />
          <div className="sources-drop__sheet">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <div className="sources-drop__scissors">
            <Scissors size={22} />
          </div>
        </div>
        <div className="sources-drop__title display">Drop your print-and-play PDF here</div>
        <div className="sources-drop__sub">
          or <u>click to choose files</u> · PDF, PNG, JPG or WebP · several at once is fine
        </div>
      </button>
      <ol className="sources-steps">
        <li>
          <span className="sources-steps__n">1</span>
          <FileText size={18} />
          <div>
            <strong>Add the PDF</strong>
            <span>Your files stay on this computer’s server.</span>
          </div>
        </li>
        <li>
          <span className="sources-steps__n">2</span>
          <Scissors size={18} />
          <div>
            <strong>Cut out the pieces</strong>
            <span>Cards, boards and tokens — we find the grid for you.</span>
          </div>
        </li>
        <li>
          <span className="sources-steps__n">3</span>
          <Dices size={18} />
          <div>
            <strong>Set up and play</strong>
            <span>Lay out the table and start a game.</span>
          </div>
        </li>
      </ol>
    </div>
  );
}

function ImportRow({ task }: { task: AddTask }) {
  const Icon = task.kind === 'image' ? FileImage : FileText;
  const busy = !task.error;
  return (
    <div className={`sources-import ${task.error ? 'is-error' : 'is-uploading'}`}>
      <div className="sources-import__icon">
        <Icon size={18} />
      </div>
      <div className="sources-import__main">
        <div className="sources-import__top">
          <span className="sources-import__name" title={task.label}>
            {task.label}
          </span>
          <span className="sources-import__size">{fmtBytes(task.bytes)}</span>
        </div>
        {task.error ? <div className="sources-import__error">{task.error}</div> : <div className="sources-import__stage">{task.detail}</div>}
        {busy && <ProgressBar value={null} />}
      </div>
      {!busy && <IconButton icon={X} label="Dismiss" size="sm" onClick={() => dismissAddTask(task.id)} />}
    </div>
  );
}

function sizeSummary(s: SourceDoc) {
  const labels = [...new Set(s.pages.map((p) => pageSizeLabel(p)))];
  if (labels.length === 1) return labels[0];
  const names = [...new Set(s.pages.map((p) => paperName(p.widthMm, p.heightMm) ?? 'custom'))];
  return `Mixed sizes (${names.join(', ')})`;
}

function SourceCard({ game, source }: { game: Game; source: SourceDoc }) {
  const navigate = useNavigate();
  const update = useGame((s) => s.update);
  const removeAssetsLocal = useGame((s) => s.removeAssetsLocal);
  const isRules = game.rules.sourceId === source.id;
  const cutterDoc = useCutterDoc(game.id);
  // what the Cutter has made from this file
  const targets = [...new Set(groupsFromSource(cutterDoc, source.id).map((g) => g.name))];
  const isSet = source.kind === 'images';
  const thumbs = source.pages.slice(0, 3).map((p) => assetUrlById(game, p.thumb ?? (isSet ? (p.assetId ?? null) : null)));
  const [fresh] = useState(() => recentSources.delete(source.id));
  const openOld = () => navigate(`/games/${game.id}/edit/sources/${source.id}`);
  const open = () => navigate(cutterLink(game.id, { source: source.id }));
  const first = source.pages[0];
  const aspect = first ? (isSet ? (first.px ? first.px.w / first.px.h : 0.75) : first.widthMm / first.heightMm) : 0.707;
  const photos = isSet ? source.pages.filter((p) => p.photo).length : 0;

  const rename = async () => {
    const name = await promptText({ title: 'Rename source', label: 'Name', initial: source.name, confirmLabel: 'Rename' });
    if (!name || name === source.name) return;
    update((g) => {
      const s = g.sources.find((x) => x.id === source.id);
      if (s) s.name = name;
    }, 'Rename source');
  };

  const toggleRules = () => {
    update((g) => {
      g.rules.sourceId = isRules ? null : source.id;
    }, isRules ? 'Stop using rulebook' : 'Use as rulebook');
    if (isRules) toast('No rulebook set');
    else
      toast.success(`“${source.name}” is now the rulebook`, {
        action: { label: 'Open rules', onClick: () => navigate(`/games/${game.id}/edit/rules`) },
      });
  };

  const setDpi = async () => {
    const asset = game.assets[source.assetId];
    if (!asset?.width) return;
    const cur = Math.round((asset.width / source.pages[0].widthMm) * 25.4);
    const v = await promptText({ title: 'Print resolution', label: 'Pixels per inch (DPI) this image was made for', initial: String(cur), confirmLabel: 'Apply' });
    const dpi = v ? parseFloat(v) : NaN;
    if (!Number.isFinite(dpi) || dpi < 30 || dpi > 2400) {
      if (v) toast.error('Enter a number between 30 and 2400');
      return;
    }
    update((g) => {
      const s = g.sources.find((x) => x.id === source.id);
      if (!s) return;
      s.pages[0].widthMm = Math.round((asset.width / dpi) * 25.4 * 100) / 100;
      s.pages[0].heightMm = Math.round((asset.height / dpi) * 25.4 * 100) / 100;
    }, 'Change print resolution');
    toast.success(`Image is now ${Math.round((asset.width / dpi) * 25.4)} × ${Math.round((asset.height / dpi) * 25.4)} mm`);
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete “${source.name}”?`,
      message:
        'The original file and its page previews will be deleted. Cards, boards and tokens you already cut from it stay in your game.',
      confirmLabel: 'Delete source',
      danger: true,
    });
    if (!ok) return;
    const ids = [source.assetId, ...source.pages.map((p) => p.thumb).filter((t): t is string => !!t)];
    update((g) => {
      g.sources = g.sources.filter((s) => s.id !== source.id);
      if (g.rules.sourceId === source.id) g.rules.sourceId = null;
    }, 'Delete source');
    try {
      await api.deleteAssets(game.id, ids);
      removeAssetsLocal(ids);
      toast.success(`Deleted “${source.name}”`);
    } catch {
      toast.error('The source was removed, but its files could not be deleted from disk.');
    }
  };

  const items: MenuItem[] = [
    { label: 'Open in the Cutter', icon: Scissors, onSelect: open },
    ...(isSet ? [] : [{ label: 'Cut with the old slicer', icon: LayoutGrid, onSelect: openOld, hint: 'Until the Cutter replaces it' } as MenuItem]),
    { label: 'Rename…', icon: Pencil, onSelect: rename },
    isRules
      ? { label: 'Stop using as rulebook', icon: BookX, onSelect: toggleRules }
      : { label: 'Use as rulebook', icon: BookOpen, onSelect: toggleRules, hint: 'Readable during play' },
    ...(source.kind === 'image' ? [{ label: 'Print resolution…', icon: Ruler, onSelect: setDpi, hint: 'Sets the size in mm' } as MenuItem] : []),
    { type: 'separator' },
    { label: 'Delete…', icon: Trash2, danger: true, onSelect: remove },
  ];

  return (
    <article className={`sources-card ${fresh ? 'is-fresh' : ''}`}>
      <button type="button" className="sources-card__thumbs" onClick={open} aria-label={`Cut components from ${source.name}`}>
        <div className="sources-card__stack" style={{ ['--aspect' as any]: aspect }}>
          {thumbs
            .slice()
            .reverse()
            .map((url, ri) => {
              const i = thumbs.length - 1 - ri;
              return (
                <div key={i} className={`sources-card__sheet sources-card__sheet--${i}`}>
                  {url ? <img src={url} alt="" loading="lazy" draggable={false} /> : <FileText size={28} />}
                </div>
              );
            })}
        </div>
        <span className="sources-card__count">
          {source.kind === 'pdf' ? <Layers size={13} /> : <FileImage size={13} />}
          {isSet ? (source.pageCount === 1 ? '1 image' : `${source.pageCount} images`) : source.pageCount === 1 ? '1 page' : `${source.pageCount} pages`}
        </span>
      </button>
      <div className="sources-card__body">
        <div className="sources-card__titlerow">
          <h3 className="sources-card__title" title={source.name}>
            {source.name}
          </h3>
          <MenuButton items={items} placement="bottom-end">
            <IconButton icon={MoreHorizontal} label="More actions" size="sm" />
          </MenuButton>
        </div>
        <div className="sources-card__meta">
          {isSet ? `Images · ${photos === source.pageCount ? 'photos' : photos ? `${photos} photos, ${source.pageCount - photos} scans` : 'flat scans'}` : `${source.kind === 'pdf' ? 'PDF' : 'Image'} · ${sizeSummary(source)}`}
        </div>
        <div className="sources-card__badges">
          {isRules && (
            <Badge tone="info">
              <BookOpen size={11} /> Rulebook
            </Badge>
          )}
          {targets.length > 0 ? (
            <Badge tone="success" data-testid="source-cut-to">
              <LayoutGrid size={11} /> Cut → {targets.slice(0, 2).join(', ')}
              {targets.length > 2 ? ` +${targets.length - 2}` : ''}
            </Badge>
          ) : (
            <Badge>Not cut yet</Badge>
          )}
        </div>
        <Button variant="primary" icon={Scissors} onClick={open} block data-testid="source-open-cutter">
          Open in the Cutter
        </Button>
      </div>
    </article>
  );
}
