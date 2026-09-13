/**
 * The mark: a horn mouth and three arcs leaving it. Drawn on an 8px grid so the strokes stay crisp
 * at nav size, and it reads as a sound source rather than a generic circle — which is the whole
 * name. The innermost arc is the only red thing in the header.
 */
export function Mark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* the horn: a wedge opening to the right */}
      <path d="M4 9.5h3.2L12 5.5v13L7.2 14.5H4z" fill="currentColor" opacity="0.9" />
      {/* three arcs, nearest one hot */}
      <path d="M15 9a4.2 4.2 0 0 1 0 6" stroke="var(--signal)" strokeWidth="1.7" />
      <path d="M17.6 6.6a7.8 7.8 0 0 1 0 10.8" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
      <path d="M20.2 4.2a11.4 11.4 0 0 1 0 15.6" stroke="currentColor" strokeWidth="1.2" opacity="0.25" />
    </svg>
  );
}
