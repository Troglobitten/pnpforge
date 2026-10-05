import { useId, useState } from 'react';
import { hashString } from './util';

/**
 * A handsome generated cover for games without cover art: a fan of paper
 * cards on a deep, name-derived colour. Deterministic per name.
 */
export function GeneratedCover({ name, className }: { name: string; className?: string }) {
  const uid = useId().replace(/[^a-z0-9]/gi, '');
  const h = hashString(name || 'game');
  const hue = h % 360;
  const hue2 = (hue + 28 + ((h >> 9) % 30)) % 360;
  const cards = 3 + ((h >> 4) % 3); // 3..5
  const spread = 11 + ((h >> 7) % 6); // degrees between cards
  const pattern = (h >> 12) % 3; // 0 dots, 1 diagonal, 2 rings
  const initials = monogram(name);
  const bg1 = `hsl(${hue} 42% 30%)`;
  const bg2 = `hsl(${hue2} 46% 15%)`;
  const ink = `hsl(${hue} 45% 28%)`;
  const edge = `hsl(${hue} 30% 72%)`;
  const cw = 64;
  const ch = 90;
  const cx = 150;
  const pivotY = 188;

  return (
    <svg
      className={className}
      viewBox="0 0 300 200"
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label={`${name} cover`}
    >
      <defs>
        <linearGradient id={`g${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={bg1} />
          <stop offset="1" stopColor={bg2} />
        </linearGradient>
        <radialGradient id={`l${uid}`} cx="0.3" cy="0.15" r="0.9">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <pattern id={`p${uid}`} width="14" height="14" patternUnits="userSpaceOnUse" patternTransform={pattern === 1 ? 'rotate(45)' : undefined}>
          {pattern === 0 && <circle cx="7" cy="7" r="1.1" fill="#fff" opacity="0.09" />}
          {pattern === 1 && <rect width="1.2" height="14" fill="#fff" opacity="0.06" />}
          {pattern === 2 && <circle cx="7" cy="7" r="4.5" fill="none" stroke="#fff" strokeWidth="0.8" opacity="0.07" />}
        </pattern>
        <filter id={`s${uid}`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="3" stdDeviation="3.5" floodColor="#000" floodOpacity="0.45" />
        </filter>
        <linearGradient id={`c${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f8f3e8" />
          <stop offset="1" stopColor="#e9e0cd" />
        </linearGradient>
      </defs>
      <rect width="300" height="200" fill={`url(#g${uid})`} />
      <rect width="300" height="200" fill={`url(#p${uid})`} />
      <rect width="300" height="200" fill={`url(#l${uid})`} />
      <g filter={`url(#s${uid})`}>
        {Array.from({ length: cards }, (_, i) => {
          const a = (i - (cards - 1) / 2) * spread;
          const isTop = i === cards - 1;
          return (
            <g key={i} transform={`rotate(${a} ${cx} ${pivotY})`}>
              <rect
                x={cx - cw / 2}
                y={pivotY - ch - 44}
                width={cw}
                height={ch}
                rx="6"
                fill={isTop ? `url(#c${uid})` : i % 2 ? `hsl(${hue} 22% 84%)` : `hsl(${hue2} 18% 80%)`}
                stroke="rgba(0,0,0,0.25)"
                strokeWidth="0.6"
              />
              <rect
                x={cx - cw / 2 + 4.5}
                y={pivotY - ch - 44 + 4.5}
                width={cw - 9}
                height={ch - 9}
                rx="3.5"
                fill="none"
                stroke={isTop ? ink : edge}
                strokeOpacity={isTop ? 0.55 : 0.8}
                strokeWidth="0.9"
              />
              {isTop && (
                <>
                  <text
                    x={cx}
                    y={pivotY - 44 - ch / 2 + 9}
                    textAnchor="middle"
                    fontFamily="'Fraunces Variable', Fraunces, Georgia, serif"
                    fontWeight="600"
                    fontSize={initials.length > 1 ? 25 : 32}
                    fill={ink}
                  >
                    {initials}
                  </text>
                  <path
                    d={`M ${cx - cw / 2 + 11} ${pivotY - ch - 44 + 11} l 3.2 4.6 l -3.2 4.6 l -3.2 -4.6 z`}
                    fill={ink}
                    opacity="0.7"
                  />
                  <path
                    d={`M ${cx + cw / 2 - 11} ${pivotY - 44 - 11} l 3.2 -4.6 l -3.2 -4.6 l -3.2 4.6 z`}
                    fill={ink}
                    opacity="0.7"
                  />
                </>
              )}
              {!isTop && (
                <circle cx={cx} cy={pivotY - 44 - ch / 2} r="9" fill="none" stroke={edge} strokeWidth="0.9" opacity="0.8" />
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function monogram(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = words.filter((w) => !/^(the|a|an|of|and)$/i.test(w));
  const pick = meaningful.length ? meaningful : words;
  if (!pick.length) return '?';
  if (pick.length === 1) return pick[0].charAt(0).toUpperCase();
  return (pick[0].charAt(0) + pick[1].charAt(0)).toUpperCase();
}

/** Cover image with a generated fallback (also used if the image fails to load). */
export function GameCover({ src, name, className }: { src?: string | null; name: string; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return <GeneratedCover name={name} className={className} />;
  return (
    <img
      className={className}
      src={src}
      alt=""
      draggable={false}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(src)}
    />
  );
}
