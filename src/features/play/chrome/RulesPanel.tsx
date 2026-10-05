/** Rules slide-over: the rulebook source (PDF pages or an image) plus quick-reference notes. */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { BookOpen, ExternalLink, X } from 'lucide-react';
import type { Game, SourceDoc } from '@/shared/types';
import { assetUrl } from '@/api/client';
import { Button, EmptyState, IconButton, Spinner } from '@/ui';
import { loadPdf, renderPage, type PdfDoc } from '@/lib/pdf';

function PdfPage({ doc, index, aspect, width }: { doc: PdfDoc; index: number; aspect: number; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        const px = Math.round(width * Math.min(2, window.devicePixelRatio || 1));
        renderPage(doc, index, { maxSide: Math.max(600, px / Math.min(1, aspect)) })
          .then((canvas) => {
            if (cancelled || !ref.current) return;
            ref.current.querySelector('canvas')?.remove();
            ref.current.appendChild(canvas);
            setDone(true);
          })
          .catch(() => setDone(true));
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [doc, index, width, aspect]);
  return (
    <>
      <div ref={ref} className="play-rules__page" style={done ? undefined : { aspectRatio: String(aspect) }}>
        {!done && <Spinner size={18} />}
      </div>
      <div className="play-rules__num">Page {index + 1}</div>
    </>
  );
}

function PdfPages({ url, source }: { url: string; source: SourceDoc }) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(440);
  useEffect(() => {
    let alive = true;
    loadPdf(url)
      .then((d) => alive && setDoc(d))
      .catch((e) => alive && setErr(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [url]);
  useEffect(() => {
    if (bodyRef.current) setWidth(bodyRef.current.clientWidth || 440);
  }, [doc]);
  if (err) return <EmptyState compact title="Couldn’t open the rulebook" description={err} />;
  if (!doc)
    return (
      <div className="play-loading" style={{ margin: '24px auto', width: 'max-content' }}>
        <Spinner size={16} /> Opening rulebook…
      </div>
    );
  return (
    <div ref={bodyRef}>
      {Array.from({ length: doc.numPages }, (_, i) => {
        const p = source.pages[i];
        const aspect = p && p.heightMm ? p.widthMm / p.heightMm : 210 / 297;
        return <PdfPage key={i} doc={doc} index={i} aspect={aspect} width={width} />;
      })}
    </div>
  );
}

export function RulesPanel({ game, open, onClose }: { game: Game; open: boolean; onClose: () => void }) {
  const source = game.rules?.sourceId ? game.sources.find((s) => s.id === game.rules.sourceId) : undefined;
  const asset = source ? game.assets[source.assetId] : undefined;
  const url = asset ? assetUrl(game.id, asset) : undefined;
  const notes = game.rules?.notes?.trim();
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  return (
    <aside className={`play-rules ${open ? 'is-open' : ''}`} data-ui aria-hidden={!open} aria-label="Rules" inert={!open}>
      <div className="play-rules__head">
        <BookOpen size={18} style={{ color: 'var(--accent)' }} />
        <h2>Rules</h2>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" tabIndex={open ? 0 : -1}>
            <IconButton icon={ExternalLink} label="Open the rulebook in a new tab" tooltipPlacement="bottom" />
          </a>
        )}
        <IconButton icon={X} label="Close rules" tooltipPlacement="bottom" onClick={onClose} />
      </div>
      <div className="play-rules__body">
        {notes && (
          <>
            <p className="play-rules__label">Quick reference</p>
            <div className="play-rules__notes">{notes}</div>
          </>
        )}
        {mounted && source && url && (
          <>
            {notes && <p className="play-rules__label">Rulebook</p>}
            {source.kind === 'pdf' ? (
              <PdfPages url={url} source={source} />
            ) : (
              <div className="play-rules__page">
                <img src={url} alt="Rulebook" />
              </div>
            )}
          </>
        )}
        {!notes && !source && (
          <EmptyState
            icon={BookOpen}
            title="No rules added yet"
            description="Pick the rulebook PDF or write a quick reference on the game’s Rules page, and it will show up here while you play."
            actions={
              <Link to={`/games/${game.id}/edit/rules`}>
                <Button variant="primary">Add rules</Button>
              </Link>
            }
          />
        )}
      </div>
    </aside>
  );
}
