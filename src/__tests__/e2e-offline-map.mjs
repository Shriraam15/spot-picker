#!/usr/bin/env node
/**
 * End-to-end check that the map still works with no network at all.
 *
 * This is the one thing the unit tests cannot prove: `offline-tiles.mjs` shows
 * the bundled PNGs are correct, but only a browser can show that Leaflet falls
 * back to them, that the app notices, and that the pin and the style picker
 * keep working while nothing outside the app can be fetched.
 *
 * Every request that leaves the page's own origin is aborted, so the provider
 * tiles fail exactly the way they fail on a phone with no data.
 *
 * Needs the dev server running (`npm run dev`). Run with:
 *   npm run e2e:offline
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:5173'
const TIMEOUT_MS = 20_000

/** A real 256×256 tile, used to stand in for the provider's tiles when online. */
const STUB_TILE = readFileSync(join(here, '..', '..', 'public', 'tiles', 'light', '2', '2', '1.png'))

/**
 * The browser build opens behind its passphrase gate, and the gate swallows
 * clicks aimed at the map. A fresh context has no passphrase stored, so the
 * test walks through the setup screen the way a person does — setting one also
 * unlocks the session, because the whole point of the gate is that a browser
 * cannot use the phone's fingerprint.
 */
async function unlock(page) {
  const setup = page.getByRole('button', { name: 'Set passphrase' })
  if ((await setup.count()) === 0) return
  await page.getByLabel('Passphrase', { exact: true }).fill('offline-map-check')
  await page.getByLabel('Confirm passphrase').fill('offline-map-check')
  await setup.click()
  await page.locator('.leaflet-container').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(500)
}

const failures = []
let checks = 0

function check(label, ok, detail = '') {
  checks += 1
  if (ok) {
    process.stdout.write(`  ok    ${label}\n`)
    return
  }
  failures.push(label)
  process.stdout.write(`  FAIL  ${label}\n`)
  if (detail) process.stdout.write(`        ${detail}\n`)
}

/**
 * Phase one: nothing outside the app's own origin may load, which is what a
 * phone with no data is like. This is the case the feature exists for.
 */
async function offlinePhase(browser) {
  const context = await browser.newContext({ viewport: { width: 420, height: 780 } })
  const page = await context.newPage()

  const errors = []
  const tileRequests = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('request', (request) => {
    const url = request.url()
    if (/\/tiles\/(light|dark|terrain)\/\d+\/\d+\/\d+\.png/.test(url)) tileRequests.push(url)
  })

  // Nothing off-origin is allowed to load: the provider's tiles are the point.
  await context.route('**/*', (route) => {
    if (route.request().url().startsWith(BASE)) return route.continue()
    return route.abort()
  })

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS })
    await unlock(page)
    await page.waitForTimeout(2500)

    check('the app opens with no network', (await page.locator('header').count()) > 0)

    // The bundled world must be what the map is drawing.
    const baseTiles = tileRequests.filter((url) => url.includes('/tiles/light/'))
    check('the bundled world tiles are requested', baseTiles.length > 0, `${tileRequests.length} tile requests`)

    // The badge is the app's own verdict on the tiles, and it is the one piece
    // of UI that claims something about the network. Matched by its own class
    // rather than its words, because the map's attribution carries a credit for
    // the bundled world too.
    const badge = page.locator('.offline-badge')
    await badge.waitFor({ timeout: 8000 }).catch(() => {})
    check('the app admits the tiles are not arriving', (await badge.count()) > 0)

    // Leaflet puts the palette on the canvas, so the drawing itself is checkable.
    const painted = await page.evaluate(async () => {
      const tile = document.querySelector('.map-tiles-base img')
      if (!tile) return null
      await (tile.decode ? tile.decode() : Promise.resolve()).catch(() => {})
      const canvas = document.createElement('canvas')
      canvas.width = 16
      canvas.height = 16
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(tile, 0, 0, 16, 16)
      const data = ctx.getImageData(0, 0, 16, 16).data
      const colours = new Set()
      for (let i = 0; i < data.length; i += 4) colours.add(`${data[i]},${data[i + 1]},${data[i + 2]}`)
      return { colours: [...colours], width: tile.naturalWidth }
    })
    check(
      'the bundled tile is a drawn map, not a blank or a broken image',
      !!painted && painted.width === 256 && painted.colours.length >= 2,
      JSON.stringify(painted),
    )

    const labels = await page.locator('.offline-label').count()
    check('the offline world carries place names', labels > 0, `${labels} labels`)

    // The pin is local work: it has to keep working with no data.
    await page.locator('.leaflet-container').click({ position: { x: 210, y: 250 } })
    await page.waitForTimeout(400)
    check('a pin can still be dropped with no network', (await page.locator('.spot-pin').count()) > 0)

    // The style picker is local too, and switching must swap the bundled world.
    await page.getByRole('button', { name: 'Map style', exact: true }).click()
    await page.waitForTimeout(300)
    for (const style of ['Light', 'Dark', 'Terrain']) {
      check(`the picker offers ${style}`, (await page.getByText(style, { exact: true }).count()) > 0)
    }

    tileRequests.length = 0
    await page.getByText('Terrain', { exact: true }).click()
    await page.waitForTimeout(2000)
    check(
      'switching to terrain swaps the bundled world',
      tileRequests.some((url) => url.includes('/tiles/terrain/')),
      tileRequests.slice(0, 3).join(' '),
    )
    const credit = (await page.locator('.leaflet-control-attribution').innerText()).replace(/\s+/g, ' ')
    check('the terrain style credits OpenTopoMap', /OpenTopoMap/i.test(credit), credit.slice(0, 120))
    check('the offline world is credited', /Natural Earth/i.test(credit), credit.slice(0, 120))

    // Choosing a style closes the picker, so reopen it to read back which style
    // the app now considers in force. Each button is a label, a hint and a tick,
    // so the style name is its first `span` rather than all of its text.
    await page.getByRole('button', { name: 'Map style', exact: true }).click()
    await page.waitForTimeout(300)
    const styles = await page.evaluate(() =>
      [...document.querySelectorAll('button[aria-pressed]')]
        .map((button) => {
          const name = (button.textContent ?? '').trim().match(/^(Light|Dark|Terrain)/)?.[1]
          return name ? `${name}:${button.getAttribute('aria-pressed')}` : ''
        })
        .filter(Boolean),
    )
    check('terrain is the style now in force', styles.includes('Terrain:true'), styles.join(' | '))
    const saved = await page.evaluate(() => localStorage.getItem('spotpicker.settings') ?? '')
    check('the chosen style survives a reload', /"mapStyle":"terrain"/.test(saved), saved.slice(0, 120))

    check('no page errors along the way', errors.length === 0, errors.slice(0, 2).join(' | '))
  } finally {
    await context.close()
  }
}

/**
 * Phase two: the provider's tiles arrive, so the app must not go on claiming to
 * be offline. The provider itself is stood in for — a test that depends on
 * OpenStreetMap being reachable fails for reasons that have nothing to do with
 * this app — but the app cannot tell the difference, and the verdict it reaches
 * is the thing under test. A detection that latched on the first batch, or that
 * counted Leaflet's stand-in for a failed tile as an arrival, would show up
 * here as a badge that never goes away.
 */
async function onlinePhase(browser) {
  const context = await browser.newContext({ viewport: { width: 420, height: 780 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))

  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (url.startsWith(BASE)) return route.continue()
    if (/tile\.openstreetmap\.org|tile\.opentopomap\.org/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: STUB_TILE })
    }
    return route.abort()
  })

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS })
    await unlock(page)
    await page.waitForTimeout(3000)

    const arriving = await page.evaluate(() =>
      [...document.querySelectorAll('.map-tiles-online img')].filter((img) => img.naturalWidth > 0).length,
    )
    check('the provider\u2019s tiles are really arriving', arriving > 0, `${arriving} tiles drawn`)
    check('the app does not call that offline', (await page.locator('.offline-badge').count()) === 0)
    check(
      'the bundled world stays out of the way',
      (await page.locator('.offline-label').count()) === 0,
      'place names are only for the offline world',
    )
    check('no page errors while online either', errors.length === 0, errors.slice(0, 2).join(' | '))
  } finally {
    await context.close()
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  try {
    process.stdout.write('\nWith nothing off-origin allowed to load\n')
    await offlinePhase(browser)
    process.stdout.write('\nWith the provider\u2019s tiles arriving\n')
    await onlinePhase(browser)
  } finally {
    await browser.close()
  }

  if (failures.length) {
    console.error(`\n✗ the offline map does not work — ${failures.length} of ${checks} checks failed:`)
    for (const failure of failures) console.error(`    • ${failure}`)
    console.error('')
    process.exit(1)
  }
  process.stdout.write(`\n✓ the map works with and without network (${checks} checks)\n`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
