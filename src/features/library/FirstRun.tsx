import { useState } from 'react';
import { FileUp, PackageOpen, Plus } from 'lucide-react';
import { Button } from '@/ui';
import { dragHasFiles } from './useFileDrop';
import { pickFiles } from './util';

/**
 * The first thing a brand-new user sees: what pnpforge does, the 3-step flow,
 * and one big obvious place to drop their PnP PDF.
 */
export function FirstRun({
  onFiles,
  onNewGame,
  onImport,
}: {
  onFiles: (files: File[]) => void;
  onNewGame: () => void;
  onImport: () => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <section className="lib-first">
      <div className="lib-first__intro">
        <p className="lib-first__eyebrow">Welcome to your workshop</p>
        <h1 className="lib-first__title display">
          Turn a print-and-play PDF into a game you can play <em>tonight</em>.
        </h1>
        <p className="lib-first__lede">
          No printer, no scissors, no glue. Bring the files, mark out the pieces once, and play on a tactile virtual table
          that remembers where you left off.
        </p>
      </div>

      <div
        className={`lib-first__drop ${over ? 'is-over' : ''}`}
        onDragEnter={(e) => dragHasFiles(e) && setOver(true)}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
        }}
        onDrop={() => setOver(false)}
      >
        <div className="lib-first__drop-icon">
          <FileUp size={26} />
        </div>
        <div className="lib-first__drop-text">
          <strong>Drop a print-and-play PDF anywhere on this page</strong>
          <span>We’ll name the game after the file and take you straight to cutting out the pieces.</span>
        </div>
        <div className="lib-first__drop-actions">
          <Button
            variant="primary"
            size="lg"
            icon={FileUp}
            onClick={async () => {
              const files = await pickFiles({ accept: 'application/pdf,image/*', multiple: true });
              if (files.length) onFiles(files);
            }}
          >
            Choose PnP files
          </Button>
          <Button variant="secondary" size="lg" icon={Plus} onClick={onNewGame}>
            Start from scratch
          </Button>
        </div>
      </div>

      <h2 className="lib-first__how">How it works</h2>
      <ol className="lib-steps">
        <li className="lib-step">
          <StepArt n={1} />
          <div className="lib-step__num">1</div>
          <h3 className="lib-step__title">Add your PnP files</h3>
          <p className="lib-step__desc">Drop in the PDF or images you downloaded — card sheets, boards, the rulebook.</p>
        </li>
        <li className="lib-step">
          <StepArt n={2} />
          <div className="lib-step__num">2</div>
          <h3 className="lib-step__title">Cut out the pieces</h3>
          <p className="lib-step__desc">Mark the card grid on each page. pnpforge slices every card, token and board for you.</p>
        </li>
        <li className="lib-step">
          <StepArt n={3} />
          <div className="lib-step__num">3</div>
          <h3 className="lib-step__title">Play</h3>
          <p className="lib-step__desc">Shuffle, draw, flip and roll on a felt table. Your game saves as you go.</p>
        </li>
      </ol>

      <p className="lib-first__foot">
        Have a <code>.pnpforge</code> file from a friend or another machine?{' '}
        <button type="button" className="lib-link" onClick={onImport}>
          <PackageOpen size={14} /> Import it
        </button>
      </p>
    </section>
  );
}

/** Small hand-drawn-ish illustrations for the 3 steps. */
function StepArt({ n }: { n: 1 | 2 | 3 }) {
  if (n === 1)
    return (
      <svg className="lib-step__art" viewBox="0 0 160 96" aria-hidden>
        <rect x="46" y="12" width="52" height="70" rx="4" fill="#e9e1cf" transform="rotate(-8 72 47)" opacity="0.55" />
        <rect x="56" y="8" width="52" height="70" rx="4" fill="#f3ede1" />
        <path d="M94 8 h14 v14 z" fill="#d8cdb4" />
        <rect x="63" y="20" width="18" height="24" rx="2" fill="#c98f46" opacity="0.85" />
        <rect x="84" y="20" width="18" height="24" rx="2" fill="#5f8fa8" opacity="0.8" />
        <rect x="63" y="48" width="18" height="24" rx="2" fill="#6f9a5f" opacity="0.8" />
        <rect x="84" y="48" width="18" height="24" rx="2" fill="#a85c4d" opacity="0.8" />
        <circle cx="116" cy="70" r="15" fill="var(--accent)" />
        <path d="M116 77 v-13 M110 69 l6 -6 l6 6" stroke="#20150a" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (n === 2)
    return (
      <svg className="lib-step__art" viewBox="0 0 160 96" aria-hidden>
        <rect x="40" y="8" width="60" height="80" rx="4" fill="#f3ede1" />
        <g stroke="#c98f46" strokeWidth="1.4" strokeDasharray="3 2.4" fill="none">
          <rect x="46" y="15" width="22" height="31" rx="2" />
          <rect x="72" y="15" width="22" height="31" rx="2" />
          <rect x="46" y="50" width="22" height="31" rx="2" />
        </g>
        <rect x="72" y="50" width="22" height="31" rx="2" fill="#dcd2bd" />
        <g transform="translate(104 38) rotate(-14)">
          <rect x="0" y="0" width="26" height="36" rx="3" fill="#f3ede1" stroke="rgba(0,0,0,0.2)" />
          <rect x="3" y="3" width="20" height="30" rx="2" fill="#a85c4d" opacity="0.85" />
          <path d="M13 12 l4 6 l-4 6 l-4 -6 z" fill="#f3ede1" opacity="0.9" />
        </g>
        <g transform="translate(96 22) rotate(35)" fill="none" stroke="var(--text-2)" strokeWidth="2.2" strokeLinecap="round">
          <circle cx="0" cy="0" r="4.5" />
          <circle cx="0" cy="13" r="4.5" />
          <path d="M3.5 3 L18 10 M3.5 10 L18 3" />
        </g>
      </svg>
    );
  return (
    <svg className="lib-step__art" viewBox="0 0 160 96" aria-hidden>
      <rect x="18" y="10" width="124" height="78" rx="12" fill="#2f5b44" />
      <rect x="18" y="10" width="124" height="78" rx="12" fill="url(#lib-felt-glow)" />
      <defs>
        <radialGradient id="lib-felt-glow" cx="0.5" cy="0.4" r="0.7">
          <stop offset="0" stopColor="#fff" stopOpacity="0.14" />
          <stop offset="1" stopColor="#000" stopOpacity="0.25" />
        </radialGradient>
      </defs>
      {[-16, -5, 6, 17].map((a, i) => (
        <g key={i} transform={`rotate(${a} 72 96)`}>
          <rect x="62" y="30" width="22" height="31" rx="2.5" fill="#f3ede1" stroke="rgba(0,0,0,0.25)" strokeWidth="0.6" />
          <rect x="65" y="33" width="16" height="25" rx="1.5" fill={['#c98f46', '#5f8fa8', '#6f9a5f', '#a85c4d'][i]} opacity="0.85" />
        </g>
      ))}
      <g transform="translate(112 42) rotate(12)">
        <rect x="0" y="0" width="18" height="18" rx="4" fill="#f3ede1" />
        <circle cx="5" cy="5" r="1.8" fill="#2a241c" />
        <circle cx="9" cy="9" r="1.8" fill="#2a241c" />
        <circle cx="13" cy="13" r="1.8" fill="#2a241c" />
      </g>
      <rect x="30" y="54" width="20" height="26" rx="2.5" fill="#22303f" stroke="rgba(255,255,255,0.2)" transform="rotate(-6 40 67)" />
    </svg>
  );
}
