/** Minimal "vibe" waveform mark. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="2" y="9" width="3" height="6" rx="1.5" fill="currentColor" opacity="0.55" />
      <rect x="7" y="5" width="3" height="14" rx="1.5" fill="currentColor" opacity="0.8" />
      <rect x="12" y="2" width="3" height="20" rx="1.5" fill="currentColor" />
      <rect x="17" y="6" width="3" height="12" rx="1.5" fill="currentColor" opacity="0.7" />
    </svg>
  );
}
