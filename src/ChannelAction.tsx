type IconName = 'text' | 'diagnose' | 'image' | 'recharge' | 'probe' | 'edit' | 'switch'

// Original outline icons on a consistent 24px grid.
const paths: Record<IconName, string> = {
  switch: 'M3 7h16m-4-4 4 4-4 4M21 17H5m4-4-4 4 4 4',
  text: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2ZM7 9h10M7 13h6',
  diagnose: 'M2 12h4l3-8 6 16 3-8h4',
  image: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM3 16l5-5 5 5 3-3 5 5M15 7h.01',
  recharge: 'M20 8V5H6a3 3 0 0 0 0 6h15v9H6a3 3 0 0 1-3-3V8M21 13h-5v4h5M17 15h.01',
  probe: 'M20 10a8 8 0 0 0-14-5L3 8M3 3v5h5M4 14a8 8 0 0 0 14 5l3-3M21 21v-5h-5',
  edit: 'm16 3 5 5-12 12-6 1 1-6ZM13 6l5 5',
}

export function ChannelAction({ icon, label, busyLabel, busy = false, onClick }: {
  icon: IconName; label: string; busyLabel?: string; busy?: boolean; onClick: () => void
}) {
  const name = busy ? busyLabel || label : label
  return <button type="button" className="channel-action" title={name} aria-label={name} aria-busy={busy} disabled={busy} onClick={(event) => { event.stopPropagation(); onClick() }}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={busy ? 'action-spinner' : undefined}>
      <path d={busy ? 'M21 12a9 9 0 1 1-9-9' : paths[icon]} />
    </svg>
  </button>
}
