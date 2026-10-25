// Line icons, drawn on a 24-unit grid in the current text colour.

type P = { size?: number; className?: string };

const svg = (path: React.ReactNode, { size = 16, className }: P, fill = false) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill ? "currentColor" : "none"}
    stroke={fill ? "none" : "currentColor"}
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {path}
  </svg>
);

export const Sparkle = (p: P) => svg(<path d="M12 1.5c.5 5.6 4.9 10 10.5 10.5-5.6.5-10 4.9-10.5 10.5C11.5 16.9 7.1 12.5 1.5 12 7.1 11.5 11.5 7.1 12 1.5Z" />, p, true);
export const GitHub = (p: P) =>
  svg(
    <path d="M12 1.8a10.2 10.2 0 0 0-3.2 19.9c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.6 1 1.6 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.3-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.5-1.3.1-2.7 0 0 .9-.3 2.8 1a9.6 9.6 0 0 1 5.1 0c2-1.3 2.8-1 2.8-1 .6 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10.2 10.2 0 0 0 12 1.8Z" />,
    p,
    true,
  );
export const Search = (p: P) => svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>, p);
export const Refresh = (p: P) => svg(<><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>, p);
export const Clock = (p: P) => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>, p);
export const Arrow = (p: P) => svg(<><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>, p);
export const Chevron = (p: P) => svg(<path d="m6 9 6 6 6-6" />, p);
export const Play = (p: P) => svg(<path d="M7 4.5v15a.8.8 0 0 0 1.2.7l12-7.5a.8.8 0 0 0 0-1.4l-12-7.5A.8.8 0 0 0 7 4.5Z" />, p, true);
export const Chat = (p: P) => svg(<path d="M4 12a8 8 0 1 1 3.4 6.6L3.5 20l1.2-3.6A8 8 0 0 1 4 12Z" />, p);
export const Plus = (p: P) => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>, p);
export const List = (p: P) => svg(<path d="M4 6h16M4 12h16M4 18h10" />, p);
export const Close = (p: P) => svg(<path d="M6 6l12 12M18 6 6 18" />, p);
export const External = (p: P) => svg(<><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>, p);
export const Expand = (p: P) => svg(<><path d="M14 4h6v6" /><path d="M10 20H4v-6" /><path d="M20 4l-7 7M4 20l7-7" /></>, p);
export const Collapse = (p: P) => svg(<><path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="M10 14l-7 7M14 10l7-7" /></>, p);
export const Doc = (p: P) => svg(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>, p);
export const Link = (p: P) => svg(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>, p);
export const Branch = (p: P) => svg(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10M18 10c0 4-6 3-12 7" /></>, p);
export const Pointer = (p: P) => svg(<><rect x="6" y="3" width="12" height="18" rx="6" /><path d="M12 7v4" /></>, p);
export const Constellation = (p: P) =>
  svg(
    <>
      <path d="M5 6l6 4 7-5M11 10l-3 8M11 10l7 6" strokeWidth={1.2} />
      <circle cx="5" cy="6" r="1.8" fill="currentColor" />
      <circle cx="11" cy="10" r="2.2" fill="currentColor" />
      <circle cx="18" cy="5" r="1.6" fill="currentColor" />
      <circle cx="8" cy="18" r="1.6" fill="currentColor" />
      <circle cx="18" cy="16" r="1.8" fill="currentColor" />
    </>,
    p,
  );
