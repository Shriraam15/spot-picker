import { downloadTextFile } from './download'

/**
 * Full app backup: favourites, recents, settings, stats and theme as one JSON
 * file. Security material (passphrase hash, wrapped key) is deliberately left
 * out — it is device-agnostic anyway, and a backup should never carry
 * credential-like state around.
 */
const APP = 'spot-picker'
const VERSION = 1
const EXCLUDE = /security|session/i

export type BackupFile = {
  app: string
  version: number
  exportedAt: string
  data: Record<string, string>
}

export function collectBackup(): BackupFile {
  const data: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (!key || EXCLUDE.test(key)) continue
    const value = localStorage.getItem(key)
    if (value !== null) data[key] = value
  }
  return {
    app: APP,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    data,
  }
}

/** Download the backup file; returns how many keys it carries. */
export function exportBackup(): number {
  const backup = collectBackup()
  const day = backup.exportedAt.slice(0, 10)
  downloadTextFile(
    `spot-picker-backup-${day}.json`,
    JSON.stringify(backup, null, 2),
    'application/json',
  )
  return Object.keys(backup.data).length
}

/** Validate parsed JSON as one of our backups. */
export function parseBackup(text: string): BackupFile | null {
  try {
    const parsed = JSON.parse(text) as Partial<BackupFile>
    if (
      parsed.app !== APP ||
      typeof parsed.version !== 'number' ||
      parsed.version > VERSION ||
      !parsed.data ||
      typeof parsed.data !== 'object'
    ) {
      return null
    }
    for (const value of Object.values(parsed.data)) {
      if (typeof value !== 'string') return null
    }
    return parsed as BackupFile
  } catch {
    return null
  }
}

/** Write the backup's keys over the current profile. Callers reload after. */
export function applyBackup(backup: BackupFile): number {
  let applied = 0
  for (const [key, value] of Object.entries(backup.data)) {
    if (EXCLUDE.test(key)) continue
    localStorage.setItem(key, value)
    applied += 1
  }
  return applied
}
