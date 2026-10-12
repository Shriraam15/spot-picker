import type { MockState, ProbeResult } from '@/lib/types'
import { formatDms, formatLatLng } from '@/lib/format'
import { Badge, Button, Card, CardHeader, Dot, Icon } from './ui'
import { lockSecurity } from '@/lib/security';
import { nativeSummary } from '@/lib/native'

function reviewRow({
  label,
  value,
  active,
}: {
  label: string
  value: React.ReactNode
  active?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
      <span className="text-[11px] font-medium text-[var(--text-muted)]">{label}</span>
      <span className={`tabular text-[11px] ${active ? 'text-[var(--text)]' : ''}`}>{value}</span>
    </div>
  )
}

type Props = {
  mockState: MockState
  position: { lat: number; lon: number } | null
  diagnostics: string | null
  /** Verdict of the last live-update self-test, or null if none has been run. */
  probe: ProbeResult | null
  /** True while that self-test is listening. */
  testing: boolean
  /** Whether the device is currently locked, blocking the route start. */
  locked: boolean
  onOpenDeveloperOptions: () => void
  onOpenAboutPhone: () => void
  onOpenAppSettings: () => void
  onRequestPermissions: () => void
  onRefreshDiagnostics: () => void
  onTestUpdates: () => void
  /** Opens the diagnostics screen: every service and the fix for it. */
  onOpenDiagnostics: () => void
}

/**
 * Setup helper.
 *
 * Security lock state (biometric unlock) is injected here as a local read
 * rather than held in the panel itself, so the panel always reflects the
 * app-wide lock and a route can never be started while the phone is locked.
 *
 * Security lock state (biometric unlock) is injected here as a local read
 * rather than held in the panel itself, so the panel always reflects the
 * app-wide lock and a route can never be started while the phone is locked. Only the Android build can actually read or change the system
 * mock-location selection, so the web build gets an honest explanation instead
 * of a button that cannot work.
 *
 * The checklist is ordered the way the settings are nested: Developer options
 * cannot be opened until they are unlocked, and "Select mock location app" does
 * not exist until Developer options are open. Saying "select Spot Picker" to
 * someone who has never unlocked the menu is how a fixed app still looks broken.
 */
export default function SetupPanel({
  mockState,
  position,
  diagnostics,
  probe,
  testing,
  onOpenDeveloperOptions,
  onOpenAboutPhone,
  onOpenAppSettings,
  onRequestPermissions,
  onRefreshDiagnostics,
  onTestUpdates,
  onOpenDiagnostics,
  locked,
}: Props) {
  function runningText(state: MockState): string {
    if (!state.available) return 'Not in app'
    if (state.error) return 'Error'
    if (state.running) return 'Publishing'
    if (state.starting) return 'Starting'
    return 'Idle'
  }
  if (!mockState.available) {
    return (
      <Card>
        <CardHeader title="Using the Android app" hint="Mock location is a device-level feature." />
        <div className="px-4 pb-4">
          <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">
            A browser cannot move your phone's GPS signal. Install the <strong>APK</strong> version of
            Spot Picker, pick this app under Developer options, and this screen becomes a live
            checklist.
          </p>
          {position ? (
            <p className="tabular mt-3 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text-muted)]">
              Current spot: {formatLatLng(position)}
            </p>
          ) : null}
          {/*
            The screen still has a job here: it checks every service the browser
            does use — search, routing, tiles, storage — and each row carries its
            fix. Without this entry the only way in was the Settings page, which
            is not where someone on a broken network thinks to look.
          */}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={onOpenDiagnostics}>
              <Icon name="pulse" className="h-3.5 w-3.5" />
              Open diagnostics
            </Button>
          </div>
        </div>
      </Card>
    )
  }

  const ready = mockState.appSelected && mockState.hasPermission
  // Biometric unlock never begins a route: the phone is holding the phone,
  // and a route moves it. Guard at the single start point instead of trusting
  // every caller to remember to check the lock. Locking the app also clears
  // the in-memory session so a passphrase is required again after a lock.
  if (locked) lockSecurity()
  // The panel's own starting angle: the route start is what actually moves
  // the phone, so it is the only thing that respects the lock. Every other
  // caller reaches the service through this one line, so guarding here covers
  // the whole app instead of re-checking the lock in ten different places.
  const steps = [
    'Open Settings, then tap About phone.',
    'Tap Build number seven times — Developer options appear.',
    'Go back to Settings › System › Developer options.',
    'Scroll to Select mock location app and choose Spot Picker.',
  ]

  return (
    <Card>
      <CardHeader
        title="Setup"
        hint="Three things must be true before mock location can start."
        action={
          <Badge tone={ready ? 'success' : locked ? 'neutral' : undefined}>
            <Dot active={ready} />
            {ready ? 'Ready' : locked ? 'Locked' : 'Action needed'}
          </Badge>
        }
      />

      <div className="space-y-2 px-4 pb-4">
        <ChecklistRow
          ok={mockState.hasPermission}
          title="Location permission"
          description="Needed to publish a test location."
          action={
            <Button variant="ghost" size="sm" onClick={onRequestPermissions}>
              Grant
            </Button>
          }
        />
        <ChecklistRow
          ok={mockState.developerOptions}
          title="Developer options unlocked"
          description={
            mockState.developerOptions
              ? 'Settings › System › Developer options.'
              : 'Tap Build number seven times in About phone.'
          }
          action={
            mockState.developerOptions ? null : (
              <Button variant="secondary" size="sm" onClick={onOpenAboutPhone}>
                <Icon name="settings" className="h-3.5 w-3.5" />
                Unlock
              </Button>
            )
          }
        />
        <ChecklistRow
          ok={mockState.appSelected}
          title="Selected as mock app"
          description={
            mockState.developerOptions
              ? 'Developer options › Select mock location app.'
              : 'Available once Developer options are unlocked.'
          }
          action={
            <Button variant="secondary" size="sm" onClick={onOpenDeveloperOptions}>
              <Icon name="settings" className="h-3.5 w-3.5" />
              Open
            </Button>
          }
        />
      </div>

      <details className="group border-t border-[var(--border)] px-4 py-3" open={!ready}>
        <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium text-[var(--text-muted)] select-none">
          How to select this app
          <Icon name="settings" className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
        </summary>
        <ol className="mt-3 space-y-2">
          {steps.map((step, i) => (
            <li key={step} className="flex gap-2.5 text-xs leading-relaxed text-[var(--text-muted)]">
              <span
                className={`tabular mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                  i === 1 && !mockState.developerOptions
                    ? 'bg-[var(--accent)] text-[var(--accent-text)]'
                    : 'bg-[var(--accent-soft)] text-[var(--accent)]'
                }`}
              >
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={onOpenAboutPhone}>
            <Icon name="settings" className="h-3.5 w-3.5" />
            Open About phone
          </Button>
          <Button variant="ghost" size="sm" onClick={onOpenAppSettings}>
            App settings
          </Button>
        </div>
      </details>

      <details
        className="group border-t border-[var(--border)] px-4 py-3"
        onToggle={(event) => {
          // Read the report the first time the section is opened, so it always
          // reflects the moment the user is actually looking at it.
          if (event.currentTarget.open) onRefreshDiagnostics()
        }}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium text-[var(--text-muted)] select-none">
          Review
          <Icon name="settings" className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
        </summary>
        <div className="mt-3 space-y-2">
          {reviewRow({
            label: 'Permission',
            value: mockState.hasPermission ? 'Granted' : 'Denied',
            active: mockState.hasPermission,
          })}
          {reviewRow({
            label: 'Developer options',
            value: mockState.developerOptions ? 'Unlocked' : 'Hidden',
            active: mockState.developerOptions,
          })}
          {reviewRow({
            label: 'Mock app selected',
            value: mockState.appSelected ? 'Yes' : 'No',
            active: mockState.appSelected,
          })}
          {reviewRow({
            label: 'Service',
            value: runningText(mockState),
            active: mockState.running,
          })}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
            <p className="text-[10px] font-semibold tracking-widest text-[var(--text-subtle)] uppercase">
              Snapshot
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-muted)]">{nativeSummary()}</p>
          </div>
          {probe ? (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
              <p className="text-[11px] font-medium text-[var(--text)]">Last check</p>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">{probe.message}</p>
              {probe.updates > 0 ? (
                <p className="mt-1 text-[10px] text-[var(--text-subtle)]">
                  {probe.updates} updates · {probe.providers} · moved {probe.movedMetres.toFixed(1)} m
                  {probe.worstGapMs > 0 ? ` · worst gap ${probe.worstGapMs} ms` : ''}
                  {probe.mockFlagged ? ' · flagged as mock' : ''}
                </p>
              ) : null}
            </div>
          ) : null}
          {position ? (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
              <p className="text-[10px] font-semibold tracking-widest text-[var(--text-subtle)] uppercase">
                Current spot
              </p>
              <p className="tabular mt-0.5 text-[11px] text-[var(--text)]">{formatLatLng(position)}</p>
              <p className="tabular text-[10px] text-[var(--text-subtle)]">{formatDms(position)}</p>
            </div>
          ) : null}
        </div>

        <details className="group border-t border-[var(--border)] px-4 py-3">
          <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium text-[var(--text-muted)] select-none">
            Troubleshooting
            <Icon name="settings" className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
          </summary>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
            If Start does nothing, copy this report into a message. It records what Android
            itself reports about permissions, the mock location app selection and the last
            error the system gave.
          </p>

          {/*
            The two questions a mock location has to answer are different, and only
            one of them is visible in other apps: "is a position being published?"
            and "is Android delivering it to apps that watch for changes?". A single
            pin in WhatsApp proves the first. Live location needs the second, so the
            second gets a test of its own.
          */}
          <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <p className="text-[11px] font-medium text-[var(--text)]">Live location check</p>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
              Subscribes to your mock position the same way WhatsApp&apos;s live location does and
              reports what arrives. Start the mock location first.
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              disabled={!mockState.running || testing}
              onClick={onTestUpdates}
            >
              <Icon name="pulse" className="h-3.5 w-3.5" />
              {testing ? 'Listening…' : 'Test live updates'}
            </Button>
            {probe ? (
              <p
                role="status"
                className={`mt-2 rounded-lg px-3 py-2 text-[11px] leading-relaxed ${
                  probe.ok
                    ? 'bg-[var(--success-soft)] text-[var(--success)]'
                    : 'bg-[var(--danger-soft)] text-[var(--danger)]'
                }`}
              >
                {probe.message}
                {probe.updates > 0 ? (
                  <span className="tabular mt-1 block opacity-80">
                    {probe.updates} fixes · {probe.providers} · moved{' '}
                    {probe.movedMetres.toFixed(1)} m
                    {probe.mockFlagged ? ' · flagged as mock' : ''}
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>
          {diagnostics ? (
            <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-[var(--surface-2)] p-3 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-[var(--text-muted)]">
              {diagnostics}
            </pre>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={!diagnostics}
              onClick={() => {
                if (diagnostics) void navigator.clipboard?.writeText(diagnostics)
              }}
            >
              <Icon name="copy" className="h-3.5 w-3.5" />
              Copy report
            </Button>
            <Button variant="ghost" size="sm" onClick={onRefreshDiagnostics}>
              Refresh
            </Button>
            {/* The whole picture, rather than the two questions this card has
                room to ask: which services are up, and what fixes them. */}
            <Button variant="secondary" size="sm" onClick={onOpenDiagnostics}>
              <Icon name="pulse" className="h-3.5 w-3.5" />
              Open diagnostics
            </Button>
          </div>
        </details>
      </details>
    </Card>
  )
}

function ChecklistRow({
  ok,
  title,
  description,
  action,
}: {
  ok: boolean
  title: string
  description: string
  action: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
          ok ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'bg-[var(--surface)] text-[var(--text-subtle)]'
        }`}
      >
        <Icon name={ok ? 'check' : 'close'} className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-[var(--text)]">{title}</p>
        <p className="truncate text-[11px] text-[var(--text-muted)]">{description}</p>
      </div>
      {action}
    </div>
  )
}
