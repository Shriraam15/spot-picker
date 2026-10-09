#!/usr/bin/env node
/**
 * Plate-only e2e smoke test for Spot Picker.
 *
 * This test runs entirely in the browser. It does NOT exercise mock-location,
 * route playback, Android bridge, or any platform-specific feature. It exists
 * to prove the app opens, renders its panels, and responds to basic UI
 * interaction on desktop Chromium.
 */

import { chromium } from 'playwright-core'

const BASE = 'http://localhost:5173'
const TIMEOUT_MS = 35_000

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  const errors = []
  page.on('pageerror', (err) => errors.push(`PAGE_ERROR: ${err}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`CONSOLE_ERROR: ${msg.text()}`)
  })

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS })
    await sleep(1500)

    // The app should render a header and at least the search panel.
    const header = page.locator('header')
    await expectWithTimeout(header, 'header present', 10_000)

    const searchCard = page.getByRole('region', { name: /search/i }).first()
    await expectWithTimeout(searchCard, 'search panel present', 10_000)

    // Type into the search box. The app should react without a full-page crash.
    const input = page.locator('input[aria-label="Search places"], input[placeholder*="Search" i]').first()
    await expectWithTimeout(input, 'search input present', 10_000)
    await input.fill('tr')
    await sleep(600)

    // A non-empty suggestion list is enough to prove the search pipeline didn't
    // throw. We do not assert exact results here because the backend is remote.
    const suggestionButton = page.locator('ul li button').first()
    const suggestionsVisible = await suggestionButton.isVisible().catch(() => false)
    console.log('e2e | suggestions visible after typing "tr":', suggestionsVisible)

    // Route panel sanity: the page should still be interactive after typing.
    const routeCard = page.getByRole('region', { name: /route/i }).first()
    const routeVisible = await routeCard.isVisible().catch(() => false)
    console.log('e2e | route panel visible:', routeVisible)

    if (errors.length > 0) {
      console.error('e2e | runtime errors during smoke test:')
      for (const e of errors) console.error('  -', e)
      process.exitCode = 1
    } else {
      console.log('e2e | smoke test passed — no runtime errors, panels rendered')
    }
  } catch (err) {
    console.error('e2e | smoke test failed:', err)
    process.exitCode = 1
  } finally {
    await browser.close()
  }
}

async function expectWithTimeout(locator, description, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const count = await locator.count()
    if (count > 0) return
    await sleep(200)
  }
  throw new Error(`timed out waiting for: ${description}`)
}

main()
