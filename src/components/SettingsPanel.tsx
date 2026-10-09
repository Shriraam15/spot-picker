import { useCallback, useRef, useState } from 'react'
import { Card, CardHeader, Button, Icon, Badge } from './ui'
import { loadSettings, saveSettings } from '@/lib/settings'
import { ROUTE_MODES } from '@/lib/types'
import { getRecentSearches } from '@/lib/recent-searches'
import { loadFavorites } from '@/lib/favorites'
import { useTheme } from '@/lib/theme'
import { applyBackup, exportBackup, parseBackup } from '@/lib/backup'
import { resetStats } from '@/lib/stats'

type Props = {
  favorites: ReturnType<typeof loadFavorites>
  onClearRecentSearches: () => void
  onExportFavorites: () => void
  onImportFavorites: () => void
  /** Engages the app lock immediately (same state as on page load). */
  onLock: () => void
}

const SHORTCUTS: [string, string][] = [
  ['1 – 6', 'Jump to Home / Search / Explore / Saved / Recent / Settings'],
  ['/', 'Focus the search box'],
  ['Esc', 'Back to Home'],
  ['Enter', 'Run the search'],
  ['↑  ↓', 'Move through the suggestion list'],
]

export default function SettingsPanel({ favorites, onClearRecentSearches, onExportFavorites, onImportFavorites, onLock }: Props) {
  const { theme, toggle } = useTheme()
  const settings = loadSettings()
  const [backupMsg, setBackupMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const handleImportBackup = useCallback(async (file: File) => {
    const parsed = parseBackup(await file.text())
    if (!parsed) {
      setBackupMsg('That file is not a Spot Picker backup.')
      return
    }
    const count = Object.keys(parsed.data).length
    if (
      !window.confirm(
        `Restore ${count} item${count !== 1 ? 's' : ''} from this backup? ` +
          'Current values for those keys will be replaced.',
      )
    ) {
      return
    }
    applyBackup(parsed)
    window.location.reload()
  }, [])

  const handleClearAllData = useCallback(() => {
    if (window.confirm('Clear all saved data? This cannot be undone.')) {
      localStorage.clear()
      window.location.reload()
    }
  }, [])

  const recentSearches = getRecentSearches()

  return (
    <div className="flex flex-col gap-4">
      {/* Appearance */}
      <Card>
        <CardHeader
          title="Appearance"
          hint="Customize how the app looks"
        />
        <div className="px-4 pb-4">
          <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
            <div className="flex items-center gap-3">
              <Icon name={theme === 'dark' ? 'moon' : 'sun'} className="h-5 w-5 text-[var(--text-muted)]" />
              <div>
                <p className="text-sm font-medium text-[var(--text)]">
                  {theme === 'dark' ? 'Dark mode' : 'Light mode'}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  {theme === 'dark' ? 'Easier on the eyes at night' : 'Bright and clear during the day'}
                </p>
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={toggle}>
              Switch to {theme === 'dark' ? 'Light' : 'Dark'}
            </Button>
          </div>
        </div>
      </Card>

      {/* Route Defaults */}
      <Card>
        <CardHeader
          title="Route Defaults"
          hint="These settings are used when you start a new route"
        />
        <div className="px-4 pb-4 space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
            <div className="flex items-center gap-3">
              <Icon name="gauge" className="h-5 w-5 text-[var(--text-muted)]" />
              <div>
                <p className="text-sm font-medium text-[var(--text)]">Default Speed</p>
                <p className="text-xs text-[var(--text-muted)]">
                  {settings.defaultSpeedKmh} km/h — used for new routes
                </p>
              </div>
            </div>
            <select
              value={settings.defaultSpeedKmh}
              onChange={(e) => {
                const speed = Number(e.target.value)
                saveSettings({ ...loadSettings(), defaultSpeedKmh: speed })
                window.dispatchEvent(new CustomEvent('settings-changed'))
              }}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            >
              <option value={5}>5 km/h (Walking)</option>
              <option value={12}>12 km/h (Running)</option>
              <option value={20}>20 km/h (Cycling)</option>
              <option value={45}>45 km/h (Driving)</option>
            </select>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
            <div className="flex items-center gap-3">
              <Icon name="route" className="h-5 w-5 text-[var(--text-muted)]" />
              <div>
                <p className="text-sm font-medium text-[var(--text)]">Route Preference</p>
                <p className="text-xs text-[var(--text-muted)]">
                  {settings.routePreference === 'highways' ? 'Prefer numbered highways' : 'Fastest route'}
                </p>
              </div>
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => {
                  saveSettings({ ...loadSettings(), routePreference: 'fastest' })
                  window.dispatchEvent(new CustomEvent('settings-changed'))
                }}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  settings.routePreference === 'fastest'
                    ? 'bg-[var(--accent)] text-[var(--accent-text)]'
                    : 'bg-[var(--surface)] text-[var(--text-muted)] hover:bg-[var(--surface-2)]'
                }`}
              >
                Fastest
              </button>
              <button
                onClick={() => {
                  saveSettings({ ...loadSettings(), routePreference: 'highways' })
                  window.dispatchEvent(new CustomEvent('settings-changed'))
                }}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  settings.routePreference === 'highways'
                    ? 'bg-[var(--accent)] text-[var(--accent-text)]'
                    : 'bg-[var(--surface)] text-[var(--text-muted)] hover:bg-[var(--surface-2)]'
                }`}
              >
                Highways
              </button>
            </div>
          </div>
        </div>
      </Card>

      {/* Travel Modes */}
      <Card>
        <CardHeader
          title="Travel Modes"
          hint="Speeds used for route simulation"
        />
        <div className="px-4 pb-4">
          <div className="space-y-2">
            {ROUTE_MODES.map((mode) => (
              <div
                key={mode.id}
                className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2"
              >
                <div className="flex items-center gap-3">
                  <Icon name={mode.icon} className="h-5 w-5 text-[var(--text-muted)]" />
                  <div>
                    <p className="text-sm font-medium text-[var(--text)]">{mode.label}</p>
                    <p className="text-xs text-[var(--text-muted)]">{mode.hint}</p>
                  </div>
                </div>
                <Badge tone={mode.defaultSpeedKmh === settings.defaultSpeedKmh ? 'accent' : 'neutral'}>
                  {mode.defaultSpeedKmh} km/h
                </Badge>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* Data Management */}
      <Card>
        <CardHeader
          title="Data Management"
          hint="Export, import, or clear your saved data"
        />
        <div className="px-4 pb-4 space-y-2">
          <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
            <div className="flex items-center gap-3">
              <Icon name="star" className="h-5 w-5 text-[var(--text-muted)]" />
              <div>
                <p className="text-sm font-medium text-[var(--text)]">Saved Favorites</p>
                <p className="text-xs text-[var(--text-muted)]">
                  {favorites.length} spot{favorites.length !== 1 ? 's' : ''} saved
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={onExportFavorites}>
                <Icon name="copy" className="h-3.5 w-3.5" />
                Export
              </Button>
              <Button variant="ghost" size="sm" onClick={onImportFavorites}>
              <Icon name="copy" className="h-3.5 w-3.5" />
              Import
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
            <div className="flex items-center gap-3">
              <Icon name="search" className="h-5 w-5 text-[var(--text-muted)]" />
              <div>
                <p className="text-sm font-medium text-[var(--text)]">Recent Searches</p>
                <p className="text-xs text-[var(--text-muted)]">
                  {recentSearches.length} recent search{recentSearches.length !== 1 ? 'es' : ''}
                </p>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={onClearRecentSearches}>
              Clear
            </Button>
          </div>
        </div>
      </Card>

      {/* Backup & restore */}
      <Card>
        <CardHeader
          title="Backup & Restore"
          hint="One JSON file with everything: spots, recents, settings, stats"
        />
        <div className="px-4 pb-4 space-y-2">
          <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
            <div className="flex items-center gap-3">
              <Icon name="save" className="h-5 w-5 text-[var(--text-muted)]" />
              <div>
                <p className="text-sm font-medium text-[var(--text)]">Full backup</p>
                <p className="text-xs text-[var(--text-muted)]">
                  {backupMsg ?? 'Move your data to another device'}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const count = exportBackup()
                  setBackupMsg(`Exported ${count} item${count !== 1 ? 's' : ''}.`)
                }}
              >
                Export
              </Button>
              <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
                Import
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void handleImportBackup(file)
                  e.target.value = ''
                }}
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
            <div className="flex items-center gap-3">
              <Icon name="gauge" className="h-5 w-5 text-[var(--text-muted)]" />
              <div>
                <p className="text-sm font-medium text-[var(--text)]">Activity counters</p>
                <p className="text-xs text-[var(--text-muted)]">
                  Start the scorecard from zero
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                resetStats()
                setBackupMsg('Activity counters reset.')
              }}
            >
              Reset
            </Button>
          </div>
        </div>
      </Card>

      {/* Keyboard shortcuts */}
      <Card>
        <CardHeader
          title="Keyboard shortcuts"
          hint="Quicker than the mouse"
        />
        <div className="space-y-1.5 px-4 pb-4">
          {SHORTCUTS.map(([keys, what]) => (
            <div
              key={keys}
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2"
            >
              <span className="text-xs text-[var(--text-muted)]">{what}</span>
              <kbd className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text)]">
                {keys}
              </kbd>
            </div>
          ))}
        </div>
      </Card>

      {/* App Info */}
      <Card>
        <CardHeader
          title="About"
          hint="App information and credits"
        />
        <div className="px-4 pb-4 space-y-3">
          <div className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--accent)] text-[var(--accent-text)] shadow-[var(--shadow-sm)]">
              <Icon name="locate" className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-[var(--text)]">Spot Picker</p>
              <p className="text-xs text-[var(--text-muted)]">Version 2.0.0</p>
            </div>
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              A mock location picker that lets you drop pins anywhere and use them as your device's location.
              Built with React, TypeScript, Vite, and Leaflet.
            </p>
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs text-[var(--text-muted)]">
            <p className="font-medium text-[var(--text)] mb-1">Data & Privacy</p>
            <p>All your data stays on this device. Nothing is uploaded anywhere.</p>
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs text-[var(--text-muted)]">
            <p className="font-medium text-[var(--text)] mb-1">Data & credits</p>
            <p>
              Offline place database © <a href="https://www.geonames.org/" className="text-[var(--accent)] underline-offset-2 hover:underline">GeoNames</a>, licensed under{' '}
              <a href="https://creativecommons.org/licenses/by/4.0/" className="text-[var(--accent)] underline-offset-2 hover:underline">CC BY 4.0</a>.
              Airport data from <a href="https://ourairports.com/" className="text-[var(--accent)] underline-offset-2 hover:underline">OurAirports</a> (public domain).
              Map tiles © OpenStreetMap contributors.
            </p>
          </div>

          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={onLock}
          >
            <Icon name="lock" className="h-3.5 w-3.5" />
            Lock now
          </Button>

          <Button
            variant="danger"
            size="sm"
            className="w-full"
            onClick={handleClearAllData}
          >
            <Icon name="trash" className="h-3.5 w-3.5" />
            Clear All Data
          </Button>
        </div>
      </Card>
    </div>
  )
}
