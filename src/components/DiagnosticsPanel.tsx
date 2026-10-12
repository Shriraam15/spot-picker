import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MockState, ProbeResult, RouteModeId } from '@/lib/types'
import type { MapStyleId } from '@/lib/map-style'
import { mapStyle } from '@/lib/map-style'
import { copyText } from '@/lib/clipboard'
import {
  IDLE_ACCURACY,
  accuracyChecks,
  deliveryChecks,
  deviceChecks,
  formatLatency,
  lockCheck,
  probeServices,
  reportText,
  storageCheck,
  summarise,
  watchDeviceAccuracy,
  type DeviceAccuracy,
  type ServiceCheck,
  type ServiceStatus,
} from '@/lib/diagnostics'
import { Badge, Button, Card, CardHeader, Icon, type IconName } from './ui'

type Props = {
  mockState: MockState
  /** Verdict of the last live-update self-test, or null if none has run. */
  probe: ProbeResult | null
  testing: boolean
  mode: RouteModeId
  /** The basemap in force, whose provider and bundled tiles are both checked. */
  style: MapStyleId
  /** What the app has saved, so the storage row can say what is at stake. */
  counts: { favorites: number; trips: number; recent: number }
  /** The lock's own state: the one thing here that is not about a service. */
  lock: {
    passphraseSet: boolean
    unlocked: boolean
    fingerprintAvailable: boolean
    fingerprintReason?: string
  }
  /** The Android report, when there is one to show. */
  nativeReport: string | null
  onRefreshNativeReport: () => void
  onTestUpdates: () => void
  onOpenDeveloperOptions: () => void
  onOpenAboutPhone: () => void
  onOpenAppSettings: () => void
  onRequestPermissions: () => void
  onBack: () => void
}

/** The sections, in the order a failure is worth looking at them. */
const SECTIONS: { id: ServiceCheck['group']; title: string; hint: string; icon: IconName }[] = [
  {
    id: 'device',
    title: 'Mock location provider',
    hint: 'What Android requires before this app may publish a position.',
    icon: 'shield',
  },
  {
    id: 'delivery',
    title: 'Provider fixes',
    hint: 'Whether the fixes reach apps that watch the position, which a one-shot read cannot tell you.',
    icon: 'pulse',
  },
  {
    id: 'accuracy',
    title: 'GPS accuracy',
    hint: 'What this app claims with every fix, and what the phone\u2019s own receiver reports.',
    icon: 'gauge',
  },
  {
    id: 'services',
    title: 'Services',
    hint: 'Everything the app fetches, each row with the fix for it.',
    icon: 'globe',
  },
  {
    id: 'app',
    title: 'This app',
    hint: 'Local state, readable with no network at all.',
    icon: 'save',
  },
]

const PILLS: Record<ServiceStatus, { tone: 'success' | 'danger' | 'accent' | 'neutral'; label: string }> = {
  ok: { tone: 'success', label: 'Working' },
  warn: { tone: 'accent', label: 'Check' },
  fail: { tone: 'danger', label: 'Broken' },
  // "Untested" would sound like an accusation; this says the screen has not
  // measured it, which is what the row means.
  unknown: { tone: 'neutral', label: 'No reading' },
}

/**
 * The diagnostics screen.
 *
 * It exists because the failures this app has are mostly invisible: a mock that
 * publishes but is never delivered, tiles that stop arriving on one network, a
 * router that is rate-limited for an hour. None of them throw, and all of them
 * look like "it doesn't work". So every row says what it measured, and any row
 * that is not working carries the fix for it right there, next to the buttons
 * that can act on it.
 *
 * The checks are run on opening rather than on a timer — a diagnostics screen
 * is looked at when something is wrong, and a poll would have the radios and the
 * Nominatim rate limit busy the whole time it is open.
 */
export default function DiagnosticsPanel({
  mockState,
  probe,
  testing,
  mode,
  style,
  counts,
  lock,
  nativeReport,
  onRefreshNativeReport,
  onTestUpdates,
  onOpenDeveloperOptions,
  onOpenAboutPhone,
  onOpenAppSettings,
  onRequestPermissions,
  onBack,
}: Props) {
  const [probes, setProbes] = useState<ServiceCheck[]>([])
  // True from the first render: the mount effect starts the checks, and setting
  // a flag synchronously inside an effect is a render of its own for no gain.
  const [busy, setBusy] = useState(true)
  const [ranAt, setRanAt] = useState<number | null>(null)
  const [live, setLive] = useState<DeviceAccuracy>(IDLE_ACCURACY)
  const [copied, setCopied] = useState<string | null>(null)
  const stopWatch = useRef<(() => void) | null>(null)

  /**
   * The one request set both entry points use. It deliberately sets nothing
   * before its first `await`, so calling it while mounting is not a render of
   * its own — the busy flag is already true from the first render.
   */
  const load = useCallback(
    () => probeServices({ style: mapStyle(style), base: import.meta.env.BASE_URL }),
    [style],
  )

  useEffect(() => {
    let alive = true
    void (async () => {
      const rows = await load()
      if (!alive) return
      setProbes(rows)
      setBusy(false)
      setRanAt(Date.now())
    })()
    return () => {
      alive = false
      stopWatch.current?.()
    }
  }, [load])

  const run = useCallback(async () => {
    setBusy(true)
    const rows = await load()
    setProbes(rows)
    setBusy(false)
    setRanAt(Date.now())
  }, [load])

  const measure = useCallback(() => {
    stopWatch.current?.()
    stopWatch.current = watchDeviceAccuracy(setLive)
  }, [])

  /**
   * The list is rebuilt on every render from the latest props and probe results,
   * so a verdict that arrives by event — the live-update test, the mock starting
   * and stopping — lands on the screen without a second round of requests.
   */
  const checks = useMemo<ServiceCheck[]>(
    () => [
      ...deviceChecks(mockState),
      ...deliveryChecks(probe, testing),
      ...accuracyChecks(mode, live, mockState.running),
      ...probes,
      storageCheck(counts),
      lockCheck(lock),
    ],
    [mockState, probe, testing, mode, live, probes, counts, lock],
  )

  const summary = useMemo(() => summarise(checks), [checks])

  const copy = useCallback(async () => {
    const ok = await copyText(
      reportText(checks, { generatedAt: Date.now(), native: nativeReport }),
    )
    setCopied(ok ? 'Copied' : 'Copy failed')
    window.setTimeout(() => setCopied(null), 2200)
  }, [checks, nativeReport])

  const fixable = checks.some((check) => check.status === 'fail' || check.status === 'warn')

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Diagnostics"
          hint="Live state of the services, the mock provider and GPS accuracy."
          action={
            <Badge tone={PILLS[summary.status].tone}>
              {summary.fail
                ? `${summary.fail} broken`
                : summary.warn
                  ? `${summary.warn} to check`
                  : summary.status === 'ok'
                    ? 'All working'
                    : 'Nothing measured'}
            </Badge>
          }
        />

        <div className="flex flex-wrap items-center gap-2 px-4 pb-4">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <Icon name="left" className="h-3.5 w-3.5" />
            Back
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void run()} disabled={busy}>
            <Icon name="rotate" className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
            {busy ? 'Checking…' : 'Re-run checks'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void copy()}>
            <Icon name="copy" className="h-3.5 w-3.5" />
            {copied ?? 'Copy report'}
          </Button>
        </div>

        <div className="px-4 pb-4">
          <p
            className={`rounded-xl px-3 py-2 text-[12px] leading-relaxed ${
              summary.status === 'fail'
                ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
                : summary.status === 'warn'
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'bg-[var(--surface-2)] text-[var(--text-muted)]'
            }`}
          >
            {summary.headline}
          </p>
          <p className="mt-1.5 text-[10px] text-[var(--text-subtle)]">
            {ranAt ? `Services checked ${new Date(ranAt).toLocaleTimeString()}.` : 'Checking services…'}
            {` ${summary.ok} working, ${summary.unknown} not measured yet.`}
          </p>
        </div>
      </Card>

      {SECTIONS.map((section) => {
        const rows = checks.filter((check) => check.group === section.id)
        if (!rows.length) {
          if (!(section.id === 'services' && busy)) return null
          return (
            <Card key={section.id}>
              <CardHeader title={section.title} hint={section.hint} />
              <p className="animate-pulse px-4 pb-4 text-[11px] text-[var(--text-muted)]">
                Asking each service in turn…
              </p>
            </Card>
          )
        }
        return (
          <Card key={section.id}>
            <CardHeader title={section.title} hint={section.hint} />
            <ul className="space-y-2 px-4 pb-4">
              {rows.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </ul>

            {/* The actions that can actually change the answer, grouped with the
                rows they belong to rather than collected in one toolbar — the
                screen is read top to bottom when something is broken. */}
            {section.id === 'device' && mockState.available ? (
              <div className="flex flex-wrap gap-2 border-t border-[var(--border)] px-4 py-3">
                {!mockState.hasPermission ? (
                  <Button variant="secondary" size="sm" onClick={onRequestPermissions}>
                    <Icon name="shield" className="h-3.5 w-3.5" />
                    Grant location
                  </Button>
                ) : null}
                {!mockState.developerOptions ? (
                  <Button variant="secondary" size="sm" onClick={onOpenAboutPhone}>
                    <Icon name="settings" className="h-3.5 w-3.5" />
                    Open About phone
                  </Button>
                ) : null}
                <Button variant="secondary" size="sm" onClick={onOpenDeveloperOptions}>
                  <Icon name="settings" className="h-3.5 w-3.5" />
                  Developer options
                </Button>
                <Button variant="ghost" size="sm" onClick={onOpenAppSettings}>
                  App settings
                </Button>
              </div>
            ) : null}

            {section.id === 'delivery' ? (
              <div className="border-t border-[var(--border)] px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!mockState.running || testing}
                    onClick={onTestUpdates}
                  >
                    <Icon name="pulse" className="h-3.5 w-3.5" />
                    {testing ? 'Listening…' : 'Test fixes'}
                  </Button>
                  {!mockState.running ? (
                    <span className="text-[10px] text-[var(--text-subtle)]">
                      Start the mock location first — there is nothing to listen for until then.
                    </span>
                  ) : null}
                </div>
                {!probe ? (
                  <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-subtle)]">
                    Publishing a position is not the same as delivering one: a one-shot
                    &ldquo;where am I?&rdquo; read succeeds even when nothing is subscribed, which is
                    how a mock can work in one app and look broken in another.
                  </p>
                ) : null}
              </div>
            ) : null}

            {section.id === 'accuracy' ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] px-4 py-3">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={measure}
                  disabled={live.state === 'measuring'}
                >
                  <Icon name="locate" className="h-3.5 w-3.5" />
                  {live.state === 'measuring' ? 'Measuring…' : 'Measure the phone\u2019s GPS'}
                </Button>
                <span className="text-[10px] text-[var(--text-subtle)]">
                  One fix, then the radio is left alone.
                </span>
              </div>
            ) : null}
          </Card>
        )
      })}

      {fixable ? (
        <p className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
          Rows marked <strong>Broken</strong> stop something working; <strong>Check</strong> marks a
            result that works but is worth watching. <strong>No reading</strong> is not a failure — it
            means this screen cannot know without a measurement, and the row says which button takes it.
        </p>
      ) : null}

      <Card>
        <CardHeader
          title="Android report"
          hint="What the wrapper itself says, quoted rather than summarised."
          action={
            <Button variant="ghost" size="sm" onClick={onRefreshNativeReport}>
              <Icon name="rotate" className="h-3.5 w-3.5" />
              Refresh
            </Button>
          }
        />
        <div className="px-4 pb-4">
          {nativeReport ? (
            <pre className="max-h-56 overflow-auto rounded-lg bg-[var(--surface-2)] p-3 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-[var(--text-muted)]">
              {nativeReport}
            </pre>
          ) : (
            <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
              {mockState.available
                ? 'Tap Refresh to read the report from the phone.'
                : 'There is no Android wrapper here: this is the browser preview, so the report is empty.'}
            </p>
          )}
        </div>
      </Card>
    </div>
  )
}

/** One row: what was measured, whether it worked, and what to do about it. */
function CheckRow({ check }: { check: ServiceCheck }) {
  const pill = PILLS[check.status]
  return (
    <li className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-[13px] font-medium text-[var(--text)]">{check.label}</p>
        <Badge tone={pill.tone}>{check.pill ?? pill.label}</Badge>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">{check.detail}</p>
      {check.ms != null ? (
        <p className="tabular mt-0.5 text-[10px] text-[var(--text-subtle)]">
          answered in {formatLatency(check.ms)}
        </p>
      ) : null}
      {check.fix ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg border-l-2 border-[var(--accent)] bg-[var(--surface)] px-2.5 py-1.5 text-[11px] leading-relaxed text-[var(--text)]">
          <Icon name="bolt" className="mt-px h-3 w-3 shrink-0 text-[var(--accent)]" />
          <span>{check.fix}</span>
        </p>
      ) : null}
    </li>
  )
}
