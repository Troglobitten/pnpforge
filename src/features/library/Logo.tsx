/** pnpforge logo mark: two fanned cards with a brass cut line. */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="lib-logo__mark">
      <defs>
        <linearGradient id="pnpf-brass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f6c681" />
          <stop offset="1" stopColor="#d99443" />
        </linearGradient>
      </defs>
      <rect x="4.5" y="6" width="15" height="21" rx="2.6" transform="rotate(-14 12 16.5)" fill="#3a3942" stroke="#56545e" strokeWidth="1" />
      <rect x="12" y="4.5" width="15" height="21" rx="2.6" transform="rotate(9 19.5 15)" fill="url(#pnpf-brass)" />
      <path
        d="M14.6 9.2 L25.4 11 M13.4 16.4 L24.2 18.2"
        transform="rotate(9 19.5 15)"
        stroke="#20150a"
        strokeOpacity="0.55"
        strokeWidth="1.3"
        strokeDasharray="2 1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="lib-logo">
      <LogoMark />
      <span className="lib-logo__word display">pnpforge</span>
    </span>
  );
}
