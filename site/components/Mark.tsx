/**
 * The mark: a K with its upper arm broken away — a secret in two shares, and the piece that leaves
 * is the only red thing in the header. Three strokes on a 24px grid, so it stays crisp at nav size
 * and still reads as a 16px favicon. `app/icon.svg` is the same drawing on a plate.
 */
export function Mark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <path d="M6 3v18" stroke="currentColor" strokeWidth="4" />
      <path d="M6 10.7 19 21.6" stroke="currentColor" strokeWidth="4" />
      <path d="M11.4 9.1 19.2 2.4" stroke="var(--signal)" strokeWidth="4" />
    </svg>
  );
}
