import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  FileText,
  Image as ImageIcon,
  Maximize2,
  NotebookPen,
  Sparkles,
  TriangleAlert,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { api, assetUrl } from '@/api/client';
import type { Game, SourceDoc } from '@/shared/types';
import { useGame } from '@/state/gameStore';
import { getPageSizesMm, loadPdf, renderPage, type PdfDoc } from '@/lib/pdf';
import { Button, EmptyState, IconButton, MenuButton, ProgressBar, Segmented, Spinner, TextArea, toast, type MenuItem } from '@/ui';
import { dragHasFiles } from '@/features/library/useFileDrop';
import { isPdfFile, pickFiles, plural } from '@/features/library/util';
import { newId } from './ids';
import './rules.css';

export default function RulesPage() {
  const game = useGame((s) => s.game);
  const [tab, setTab] = useState<'book' | 'notes'>('book');
  const { upload, progress } = useRulesUpload(game);
  if (!game) return null;
  const source = game.sources.find((s) => s.id === game.rules.sourceId) ?? null;

  return (
    <div className="rules-wrap">
      <div className="rules" data-tab={tab}>
        <div className="rules-tabs">
          <Segmented
            value={tab}
            onChange={setTab}
            aria-label="Rules view"
            options={[
              { value: 'book', label: 'Rulebook', icon: BookOpen },
              { value: 'notes', label: 'Quick reference', icon: NotebookPen },
            ]}
          />
        </div>
        <section className="rules-book" aria-label="Rulebook">
          {source ? (
            <RulebookReader key={source.id} game={game} source={source} onUpload={upload} uploading={progress} />
          ) : (
            <RulebookEmpty game={game} onUpload={upload} progress={progress} />
          )}
        </section>
        <aside className="rules-notes" aria-label="Quick reference">
          <NotesEditor game={game} />
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Uploading a rules PDF                                                */
/* ------------------------------------------------------------------ */

function useRulesUpload(game: Game | null) {
  const [progress, setProgress] = useState<number | null>(null);
  const upload = useCallback(
    async (files: File[]) => {
      if (!game) return;
      const file = files.find(isPdfFile);
      if (!file) {
        if (files.length) toast.warning('Rulebooks need to be a PDF', { description: 'For images, add them on the Sources page and pick them here.' });
        return;
      }
      setProgress(0);
      try {
        // Parse first so a broken file fails fast, before uploading.
        const doc = await loadPdf(new Uint8Array(await file.arrayBuffer()));
        const sizes = await getPageSizesMm(doc);
        void doc.cleanup();
        const [asset] = await api.uploadAssets(game.id, [file], { role: 'source', onProgress: setProgress });
        const st = useGame.getState();
        st.addAssets([asset]);
        const src: SourceDoc = {
          id: newId(),
          name: file.name.replace(/\.pdf$/i, ''),
          kind: 'pdf',
          assetId: asset.id,
          pageCount: sizes.length,
          pages: sizes.map((s, index) => ({ index, widthMm: s.widthMm, heightMm: s.heightMm })),
          createdAt: Date.now(),
        };
        st.update((g) => {
          g.sources.push(src);
          g.rules.sourceId = src.id;
        }, 'Add rulebook');
        toast.success('Rulebook added', { description: `${src.name} · ${plural(src.pageCount, 'page')}` });
      } catch (e: any) {
        toast.error('Couldn’t add the rulebook', { description: e?.message ?? 'The PDF could not be read.' });
      } finally {
        setProgress(null);
      }
    },
    [game?.id],
  );
  return { upload, progress };
}

function useDropTarget(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragEnter: (e: React.DragEvent) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        setOver(true);
      },
      onDragOver: (e: React.DragEvent) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      },
      onDrop: (e: React.DragEvent) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        setOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Empty state                                                          */
/* ------------------------------------------------------------------ */

function RulebookEmpty({ game, onUpload, progress }: { game: Game; onUpload: (f: File[]) => void; progress: number | null }) {
  const update = useGame((s) => s.update);
  const drop = useDropTarget(onUpload);
  const browse = async () => onUpload(await pickFiles({ accept: 'application/pdf' }));
  return (
    <div className="rules-empty-wrap">
      <div className="rules-empty">
        <div className="rules-empty__icon">
          <BookOpen size={28} strokeWidth={1.6} />
        </div>
        <h2 className="rules-empty__title display">Add the rulebook</h2>
        <p className="rules-empty__desc">
          Keep the rules one tap away — here while you set things up, and beside the table while you play.
        </p>

        {game.sources.length > 0 && (
          <div className="rules-empty__section">
            <h3 className="rules-empty__label">Use one of your files</h3>
            <div className="rules-srclist">
              {game.sources.map((s) => {
                const Icon = s.kind === 'pdf' ? FileText : ImageIcon;
                return (
                  <button
                    key={s.id}
                    type="button"
                    className="rules-src"
                    onClick={() => update((g) => void (g.rules.sourceId = s.id), 'Choose rulebook')}
                  >
                    <span className="rules-src__icon">
                      <Icon size={18} />
                    </span>
                    <span className="rules-src__text">
                      <span className="rules-src__name">{s.name}</span>
                      <span className="rules-src__meta">{plural(s.pageCount, 'page')}</span>
                    </span>
                    <span className="rules-src__use">Use</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className={`rules-drop ${drop.over ? 'is-over' : ''}`} {...drop.props}>
          {progress != null ? (
            <div className="rules-drop__progress">
              <span>Adding rulebook…</span>
              <ProgressBar value={progress || null} />
            </div>
          ) : (
            <button type="button" className="rules-drop__hit" onClick={browse}>
              <span className="rules-drop__icon">
                <Upload size={20} />
              </span>
              <span className="rules-drop__text">
                <strong>{game.sources.length ? 'Or upload a separate rules PDF' : 'Upload the rules PDF'}</strong>
                <span>Drop it here or click to browse</span>
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reader                                                               */
/* ------------------------------------------------------------------ */

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
const PAD = 24;
const GAP = 16;
const MAX_FIT = 880;

type Size = { widthMm: number; heightMm: number };

function RulebookReader({
  game,
  source,
  onUpload,
  uploading,
}: {
  game: Game;
  source: SourceDoc;
  onUpload: (f: File[]) => void;
  uploading: number | null;
}) {
  const update = useGame((s) => s.update);
  const asset = game.assets[source.assetId];
  const url = asset ? assetUrl(game.id, asset) : undefined;
  const isImage = source.kind === 'image' || (asset && asset.mime.startsWith('image/'));

  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [sizes, setSizes] = useState<Size[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** An image rulebook can be a *set* of image sources, one per page. */
  const extraIds = game.rules.sourceIds ?? [];
  const imagePages = useMemo(() => {
    if (!isImage) return [];
    const docs = [source, ...extraIds.map((id) => game.sources.find((s) => s.id === id)).filter((s): s is SourceDoc => !!s)];
    return docs.map((s) => {
      const a = game.assets[s.assetId];
      const page = s.pages[0];
      return {
        id: s.id,
        name: s.name,
        url: a ? assetUrl(game.id, a) : undefined,
        widthMm: page?.widthMm || a?.width || 210,
        heightMm: page?.heightMm || a?.height || 297,
        /** natural pixel width — an image page is never blown up past it */
        naturalPx: a?.width || 0,
      };
    });
  }, [isImage, source.id, extraIds.join(','), game.sources, game.assets]);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError(null);
    if (!url || !asset) {
      setError('The file for this rulebook is missing.');
      return;
    }
    if (isImage) {
      setSizes(imagePages.map((p) => ({ widthMm: p.widthMm, heightMm: p.heightMm })));
      return;
    }
    const known = source.pages.length === source.pageCount && source.pageCount > 0 ? source.pages : null;
    if (known) setSizes(known.map((p) => ({ widthMm: p.widthMm, heightMm: p.heightMm })));
    loadPdf(url)
      .then(async (d) => {
        if (cancelled) return;
        setDoc(d);
        if (!known) {
          const s = await getPageSizesMm(d);
          if (!cancelled) setSizes(s);
        }
      })
      .catch((e) => !cancelled && setError(e?.message ?? 'Could not open the PDF'));
    return () => {
      cancelled = true;
    };
  }, [url, imagePages]);

  /* ---- viewport + zoom ---- */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [zoom, setZoom] = useState(1);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setView({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [error]);

  const fitW = Math.max(200, Math.min(view.w - PAD * 2, MAX_FIT));
  const pageW = Math.round(fitW * zoom);
  const layout = useMemo(() => {
    const tops: number[] = [];
    const heights: number[] = [];
    const widths: number[] = [];
    let y = PAD;
    (sizes ?? []).forEach((s, i) => {
      // Images stop at their natural size — a 63 mm card must not be blown up
      // to the width of the reader.
      const cap = isImage ? Math.max(120, Math.round((imagePages[i]?.naturalPx || 0) * Math.max(1, zoom))) : Infinity;
      const w = Math.min(pageW, cap || Infinity);
      const h = Math.round((w * s.heightMm) / Math.max(1, s.widthMm));
      tops.push(y);
      heights.push(h);
      widths.push(w);
      y += h + GAP;
    });
    return { tops, heights, widths, total: y - GAP + PAD };
  }, [sizes, pageW, isImage, imagePages, zoom]);
  const innerW = Math.max(view.w, (layout.widths.length ? Math.max(...layout.widths) : pageW) + PAD * 2);

  // keep the reading position when zoom/width changes
  const prev = useRef<{ total: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && prev.current && prev.current.total > 0 && prev.current.total !== layout.total) {
      el.scrollTop = (prev.current.top / prev.current.total) * layout.total;
      el.scrollLeft = Math.max(0, (innerW - view.w) / 2);
    }
    prev.current = { total: layout.total, top: el?.scrollTop ?? 0 };
  }, [layout.total]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setScrollTop(el.scrollTop);
        prev.current = { total: prev.current?.total ?? 0, top: el.scrollTop };
      });
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => stepZoom(z, e.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      cancelAnimationFrame(raf);
    };
  }, [error]);

  const count = sizes?.length ?? source.pageCount;
  let current = 0;
  for (let i = 0; i < layout.tops.length; i++) if (layout.tops[i] <= scrollTop + view.h * 0.35) current = i;
  const margin = view.h * 1.2;
  const isVisible = (i: number) => layout.tops[i] < scrollTop + view.h + margin && layout.tops[i] + layout.heights[i] > scrollTop - margin;

  const goTo = (i: number) => {
    const el = scrollRef.current;
    if (!el || layout.tops[i] == null) return;
    el.scrollTo({ top: layout.tops[i] - PAD / 2, behavior: 'smooth' });
  };

  /* ---- menu ---- */
  const otherImages = isImage ? game.sources.filter((s) => s.kind === 'image' && s.id !== source.id) : [];
  const toggleExtra = (id: string) =>
    update((g) => {
      const cur = g.rules.sourceIds ?? [];
      g.rules.sourceIds = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    }, 'Change rulebook pages');

  const menuItems = (): MenuItem[] => [
    { type: 'label', label: 'Rulebook file' },
    ...game.sources.map<MenuItem>((s) => ({
      label: s.name,
      hint: plural(s.pageCount, 'page'),
      checked: s.id === source.id,
      icon: s.kind === 'pdf' ? FileText : ImageIcon,
      onSelect: () =>
        s.id !== source.id &&
        update((g) => {
          g.rules.sourceId = s.id;
          g.rules.sourceIds = [];
        }, 'Choose rulebook'),
    })),
    ...(otherImages.length
      ? [
          { type: 'separator' } as MenuItem,
          { type: 'label', label: 'Extra pages' } as MenuItem,
          ...otherImages.map<MenuItem>((s) => ({
            label: s.name,
            icon: ImageIcon,
            hint: extraIds.includes(s.id) ? `Page ${extraIds.indexOf(s.id) + 2}` : 'Add as a page',
            checked: extraIds.includes(s.id),
            onSelect: () => toggleExtra(s.id),
          })),
        ]
      : []),
    { type: 'separator' },
    { label: 'Upload a PDF…', icon: Upload, onSelect: async () => onUpload(await pickFiles({ accept: 'application/pdf' })) },
    {
      label: 'Stop using as rulebook',
      icon: X,
      onSelect: () =>
        update((g) => {
          g.rules.sourceId = null;
          g.rules.sourceIds = [];
        }, 'Remove rulebook'),
    },
  ];

  const drop = useDropTarget(onUpload);

  return (
    <div className="rules-reader" {...drop.props}>
      <div className="rules-bar">
        <MenuButton items={menuItems} placement="bottom-start" minWidth={260}>
          <button type="button" className="rules-bar__source" aria-label="Change rulebook">
            <BookOpen size={16} className="rules-bar__source-icon" />
            <span className="rules-bar__source-name">{source.name}</span>
            <ChevronDown size={14} />
          </button>
        </MenuButton>
        {uploading != null && <Spinner size={16} />}
        <div className="rules-bar__spacer" />
        {count > 0 && (
          <PageJump current={current} count={count} onGo={goTo} />
        )}
        <span className="rules-bar__sep" />
        <IconButton icon={ZoomOut} label="Zoom out" shortcut="Ctrl+Scroll" tooltipPlacement="bottom" disabled={zoom <= ZOOMS[0]} onClick={() => setZoom((z) => stepZoom(z, -1))} />
        <button type="button" className="rules-bar__zoom" onClick={() => setZoom(1)} title="Fit to width">
          {Math.round(zoom * 100)}%
        </button>
        <IconButton icon={ZoomIn} label="Zoom in" shortcut="Ctrl+Scroll" tooltipPlacement="bottom" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom((z) => stepZoom(z, 1))} />
        <IconButton icon={Maximize2} label="Fit to width" tooltipPlacement="bottom" active={zoom === 1} onClick={() => setZoom(1)} />
      </div>

      <div className="rules-scroll" ref={scrollRef} tabIndex={0} aria-label="Rulebook pages">
        {error ? (
          <div className="rules-center">
            <EmptyState
              icon={TriangleAlert}
              title="Couldn’t open this rulebook"
              description={error}
              actions={
                <Button icon={Upload} onClick={async () => onUpload(await pickFiles({ accept: 'application/pdf' }))}>
                  Upload a different PDF
                </Button>
              }
            />
          </div>
        ) : !sizes || view.w === 0 ? (
          <div className="rules-center">
            <Spinner size={22} />
          </div>
        ) : (
          <div className="rules-pages" style={{ width: innerW, height: layout.total }}>
            {layout.tops.map((top, i) => (
              <div
                key={i}
                className="rules-page"
                style={{ top, left: (innerW - layout.widths[i]) / 2, width: layout.widths[i], height: layout.heights[i] }}
              >
                {isImage ? (
                  <>
                    <img
                      className="rules-page__img"
                      src={imagePages[i]?.url}
                      alt={imagePages[i]?.name ?? source.name}
                      draggable={false}
                    />
                    {layout.tops.length > 1 && <span className="rules-page__num">{i + 1}</span>}
                  </>
                ) : (
                  <PdfPageView doc={doc} index={i} width={layout.widths[i]} visible={isVisible(i)} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {drop.over && (
        <div className="rules-dropover">
          <Upload size={26} />
          Drop a PDF to use it as the rulebook
        </div>
      )}
    </div>
  );
}

function stepZoom(z: number, dir: 1 | -1) {
  if (dir > 0) return ZOOMS.find((v) => v > z + 0.001) ?? ZOOMS[ZOOMS.length - 1];
  return [...ZOOMS].reverse().find((v) => v < z - 0.001) ?? ZOOMS[0];
}

function PageJump({ current, count, onGo }: { current: number; count: number; onGo: (i: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="rules-jump">
      <span className="sr-only">Page</span>
      <input
        className="rules-jump__input"
        inputMode="numeric"
        value={draft ?? String(current + 1)}
        onFocus={(e) => {
          setDraft(String(current + 1));
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const n = Math.min(count, Math.max(1, parseInt(draft ?? '', 10) || current + 1));
            onGo(n - 1);
            e.currentTarget.blur();
          } else if (e.key === 'Escape') e.currentTarget.blur();
        }}
        aria-label={`Page ${current + 1} of ${count}`}
      />
      <span className="rules-jump__of">of {count}</span>
    </label>
  );
}

/** One PDF page, rendered lazily once it's near the viewport and re-rendered after zoom settles. */
function PdfPageView({ doc, index, width, visible }: { doc: PdfDoc | null; index: number; width: number; visible: boolean }) {
  const holder = useRef<HTMLDivElement>(null);
  const [renderedPx, setRenderedPx] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!visible || !doc) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const target = Math.min(3000, Math.round(width * dpr));
    if (renderedPx && Math.abs(renderedPx - target) / target < 0.12) return;
    let cancelled = false;
    const t = window.setTimeout(
      async () => {
        try {
          const page = await doc.getPage(index + 1);
          const base = page.getViewport({ scale: 1 });
          const canvas = await renderPage(doc, index, { dpi: (72 * target) / base.width });
          if (cancelled || !holder.current) return;
          canvas.className = 'rules-page__canvas';
          holder.current.replaceChildren(canvas);
          setRenderedPx(target);
        } catch {
          if (!cancelled) setFailed(true);
        }
      },
      renderedPx ? 220 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [visible, doc, width, index, renderedPx]);

  return (
    <>
      <div ref={holder} className="rules-page__holder" />
      {!renderedPx && (
        <div className="rules-page__placeholder">{failed ? <TriangleAlert size={20} /> : <Spinner size={18} />}</div>
      )}
      <span className="rules-page__num">{index + 1}</span>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Quick reference notes                                                */
/* ------------------------------------------------------------------ */

const TEMPLATE = [
  'Setup',
  '• ',
  '',
  'On your turn',
  '1. ',
  '2. ',
  '3. ',
  '',
  'End of the game',
  '• ',
  '',
  'Scoring',
  '• ',
].join('\n');

function NotesEditor({ game }: { game: Game }) {
  const update = useGame((s) => s.update);
  const ref = useRef<HTMLTextAreaElement>(null);
  const notes = game.rules.notes ?? '';
  const words = notes.trim() ? notes.trim().split(/\s+/).length : 0;
  const set = (v: string) => update((g) => void (g.rules.notes = v), 'Edit quick reference', { coalesceKey: 'rules-notes' });
  return (
    <div className="rules-notes__inner">
      <div className="rules-notes__head">
        <h2 className="rules-notes__title">Quick reference</h2>
        <p className="rules-notes__sub">Shown beside the table while you play — turn order, scoring, the rules you always forget.</p>
      </div>
      <TextArea
        ref={ref}
        className="rules-notes__area"
        value={notes}
        onChange={(e) => set(e.target.value)}
        placeholder={'e.g.\nOn your turn\n1. Draw a card\n2. Play or discard one\n3. Check for a match…'}
        aria-label="Quick reference notes"
        spellCheck
      />
      <div className="rules-notes__foot">
        {!notes.trim() ? (
          <Button
            size="sm"
            variant="subtle"
            icon={Sparkles}
            onClick={() => {
              set(TEMPLATE);
              requestAnimationFrame(() => {
                const el = ref.current;
                if (!el) return;
                el.focus();
                const pos = TEMPLATE.indexOf('• ') + 2;
                el.setSelectionRange(pos, pos);
              });
            }}
          >
            Start from a template
          </Button>
        ) : (
          <span />
        )}
        <span className="rules-notes__count">{plural(words, 'word')}</span>
      </div>
    </div>
  );
}
