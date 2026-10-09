import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

/**
 * Small shared primitives. Styling lives in one place so spacing, radius and
 * focus treatment stay consistent across the panels.
 */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  children: ReactNode
}

const VARIANTS: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:
    'bg-[var(--accent)] text-[var(--accent-text)] hover:bg-[var(--accent-hover)] shadow-[var(--shadow-sm)]',
  secondary:
    'bg-[var(--surface)] text-[var(--text)] border border-[var(--border)] hover:bg-[var(--surface-2)] hover:border-[var(--border-strong)]',
  ghost: 'text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
  danger:
    'bg-[var(--danger-soft)] text-[var(--danger)] hover:brightness-95 dark:hover:brightness-125',
}

const SIZES = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center rounded-xl font-medium transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] disabled:pointer-events-none disabled:opacity-45 active:scale-[0.98] ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
    >
      {children}
    </button>
  )
}

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={`rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-md)] ${className}`}
    >
      {children}
    </section>
  )
}

export function CardHeader({
  title,
  action,
  hint,
}: {
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <header className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
      <div className="min-w-0">
        <h2 className="text-[13px] font-semibold tracking-wide text-[var(--text)] uppercase">
          {title}
        </h2>
        {hint ? <p className="mt-1 text-xs text-[var(--text-muted)]">{hint}</p> : null}
      </div>
      {action}
    </header>
  )
}

/** Inline status pill used for mock-location state and search hints. */
export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'success' | 'danger' | 'accent'
  children: ReactNode
}) {
  const tones = {
    neutral: 'bg-[var(--surface-2)] text-[var(--text-muted)] border-[var(--border)]',
    success: 'bg-[var(--success-soft)] text-[var(--success)] border-transparent',
    danger: 'bg-[var(--danger-soft)] text-[var(--danger)] border-transparent',
    accent: 'bg-[var(--accent-soft)] text-[var(--accent)] border-transparent',
  } as const
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

/** A live status dot used next to badges. */
export function Dot({ active }: { active: boolean }) {
  return (
    <span className="relative flex h-1.5 w-1.5">
      {active ? (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
      ) : null}
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
    </span>
  )
}

export function PageButton({ active, label, icon }: {
  active?: boolean
  label: string
  icon: IconName
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={`relative rounded-full px-3 py-1.5 text-[11px] font-medium transition-all active:scale-95 ${active ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)]'}`}
    >
      <Icon name={icon} className="h-3.5 w-3.5 inline mr-1" />
      {label}
      <span className="absolute inset-0 rounded-full bg-[var(--accent)] opacity-0 transition-opacity" />
    </button>
  )
}

export function Input({
  value,
  onChange,
  placeholder = '',
  type = 'text',
  className = '',
  autoFocus = false,
  maxLength,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> & {
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      autoFocus={autoFocus}
      maxLength={maxLength}
      className={`h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text)] placeholder:text-[var(--text-subtle)] outline-none focus:border-[var(--accent)] transition-colors ${className}`}
      {...rest}
    />
  )
}

export function Icon({ name, className = 'h-4 w-4' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  )
}

export type IconName =
  | 'search'
  | 'star'
  | 'starFilled'
  | 'trash'
  | 'play'
  | 'stop'
  | 'locate'
  | 'globe'
  | 'settings'
  | 'sun'
  | 'moon'
  | 'check'
  | 'alert'
  | 'copy'
  | 'close'
  | 'save'
  | 'route'
  | 'plus'
  | 'minus'
  | 'pause'
  | 'up'
  | 'down'
  | 'left'
  | 'right'| 'gauge'
  | 'clock'| 'walk' | 'run' | 'bike' | 'car' | 'pulse'
  | 'lock' | 'fingerprint' | 'shield' | 'user' | 'key'

const ICON_PATHS: Record<IconName, ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  star: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />,
  starFilled: (
    <path
      d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"
      fill="currentColor"
    />
  ),
  trash: (
    <>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13M9 7V4h6v3" />
    </>
  ),
  play: <path d="M7 4.5v15l13-7.5z" fill="currentColor" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />,
  locate: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 3.8 5.8 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.8-3.8-9S9.5 5.7 12 3z" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  alert: (
    <>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </>
  ),
  close: <path d="M18 6 6 18M6 6l12 12" />,
  save: (
    <>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8M7 3v5h8" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M8.5 18h5a3.5 3.5 0 0 0 0-7h-3a3.5 3.5 0 0 1 0-7h5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  pause: <path d="M9.5 5v14M14.5 5v14" />,
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  left: <path d="M19 12H5M11 6l-6 6 6 6" />,
  right: <path d="M5 12h14M13 6l6 6-6 6" />,
  gauge: (
    <>
      <path d="M4.5 17.5a8.5 8.5 0 1 1 15 0" />
      <path d="m12 15 3.5-4.5" />
      <circle cx="12" cy="15.5" r="1.2" fill="currentColor" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  lock: <path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />,
  fingerprint: (
    <>
      <path d="M12 11c0 4-3 7.5-3 7.5S9 15 9 11s3-6.5 3-6.5S12 7 12 11z" />
      <path d="M9 11h6" />
      <circle cx="12" cy="16" r="1.2" fill="currentColor" />
    </>
  ),
  shield: <path d="M12 3l7 3v5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6z" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.2-6.5 6.5-6.5S20 17 20 21" />
    </>
  ),
  key: (
    <>
      <path d="M12 3a2 2 0 0 0-2 2v10H5a2 2 0 0 0-2 2v4l9.5 6.5L18 19l3-3z" />
      <path d="M12 11v8" />
      <path d="M9 14h6" />
    </>
  ),
  walk: (
    <>
      <circle cx="13" cy="4.4" r="1.7" />
      <path d="M13 6.4v5l-2.6 2.3-1.3 5.2" />
      <path d="M13 11.4l2.4 2.3.6 5.1" />
      <path d="M13 8.4 10 10.6M13 8.4l2.6 1.6" />
    </>
  ),
  run: (
    <>
      <circle cx="14.4" cy="4.4" r="1.7" />
      <path d="M14.4 6.6l-2.6 5.4 3 2.7-.7 4.2" />
      <path d="M11.8 12 8 13.2l-1.7 3.1" />
      <path d="M14.4 8.2l3.2 1.1M14.4 8.2l-3.1-.7" />
    </>
  ),
  bike: (
    <>
      <circle cx="6" cy="17" r="3.3" />
      <circle cx="18" cy="17" r="3.3" />
      <path d="M6 17l4.2-7.2h4.6L18 17" />
      <path d="M9.6 9.8h5.4M13.2 6.6h2.2" />
    </>
  ),
  car: (
    <>
      <path d="M3.5 16.4v-3l2-4.4a1.6 1.6 0 0 1 1.5-1h10a1.6 1.6 0 0 1 1.5 1l2 4.4v3" />
      <path d="M3.5 13.4h17" />
      <circle cx="7.6" cy="17.2" r="1.4" />
      <circle cx="16.4" cy="17.2" r="1.4" />
    </>
  ),
  /** A heartbeat line: used for the live-update self-test. */
  pulse: <path d="M2.5 12.5h4l2.2-5.5 3.1 10.5 2.4-5h7.3" />,
}