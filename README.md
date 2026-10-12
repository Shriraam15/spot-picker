# Spot Picker — web app

React + TypeScript + Vite + Tailwind v4 + Leaflet. This is the UI that ships inside the
Android APK, and it also runs standalone in a browser.

```bash
npm install
npm run dev      # dev server
npm test         # bridge contract + route geometry + walk + offline map
npm run build    # production build -> dist/
npm run preview  # serve the production build
npm run data     # rebuild the offline gazetteer from scripts/geonames/
npm run tiles    # redraw the offline map tiles from Natural Earth vectors
npm run e2e:offline  # with the dev server running: the map with no network at all
```

## Layout

```
src/
  App.tsx              shell + all app state
  index.css            design tokens, light/dark theme, Leaflet overrides
  components/
    MapView.tsx        Leaflet map, tap-to-pick, flyTo/locate/reset commands
    SearchPanel.tsx    place search (Nominatim)
    FavoritesPanel.tsx saved spots (localStorage)
    SetupPanel.tsx     mock-location setup checklist
    RoutePanel.tsx     endpoints, travel mode, speed, road picker, Google Maps, simulator
    MockBar.tsx        sticky action bar, nudge pad, Start/Stop
    ui.tsx             shared Button / Card / Badge / Icon
  lib/
    native.ts          window.SpotPicker bridge client (no-ops in a browser)
    geocode.ts         Nominatim client, throttled to 1 req/s
    favorites.ts       localStorage persistence
    format.ts          coordinate formatting
    route.ts           route geometry, road-faithful thinning, formatting, nudging
    routing.ts         road routes from OSRM, with road names, alternatives, direct line
    haptics.ts         navigator.vibrate wrapper
    theme.ts           light/dark toggle
    map-style.ts       the three map styles, their providers and offline tiles
    walk.ts            joystick walk maths (pure, so the tests can load it)
public/
  tiles/               offline world map: 3 styles × zooms 0-4, drawn by npm run tiles
  data/                offline gazetteer shards, written by npm run data
```

## Tests

`npm test` runs both files under `src/__tests__/`.

[`bridge-contract.mjs`](src/__tests__/bridge-contract.mjs): the web app reaches Android
through `window.SpotPicker`, a WebView JavaScript interface, and neither language can
type-check the other across that boundary. This test reads `lib/native.ts` alongside
`SpotPickerBridge.kt` and fails when the two stop describing the same contract: method
names and signatures, the JSON keys `getStatus()` emits versus `MockState`, the
`{ ok, error }` result envelope versus `MockResult`, the native event types and fields
versus what `App.tsx` handles, the travel mode ids versus `MotionMode.kt`, the route
point cap both sides have to agree on, and the injected global names. Update both sides
together when adding anything to the bridge.

[`route-geometry.mjs`](src/__tests__/route-geometry.mjs): the geometry that decides what
the phone plays — distances, the progress split, the point cap, nudging, and how far
thinning may move a road. It imports `lib/route.ts` directly (Node strips the types) and
is shaped around a bug that really shipped: simplification discarded a whole corner
whenever the worst deviation landed one vertex in, so the fixture turns immediately and
the check fails against the old code. The thinning checks assert an absolute 20 m
ceiling on the deviation rather than the module's own tolerance, because a test that
asks a module whether it obeys its own constant passes when the constant is wrong.

[`walk-step.mjs`](src/__tests__/walk-step.mjs): the joystick's walk. It covers the
things that fail quietly — a deadzone that eats an honest push, a diagonal that walks
root-two times too fast, and a "walk" that moves the mock once and then stands still.
It also checks the arithmetic end to end through `nudge`, so a held stick is proved to
travel at the pace it is set to.

[`offline-tiles.mjs`](src/__tests__/offline-tiles.mjs): the offline map. It decodes the
committed PNGs rather than trusting the generator, and checks that every style has a
complete pyramid, that the palettes are the ones the app thinks it is drawing, that
known geography lands where it should (Paris is land, the mid-Pacific is sea), that a
tile *inside* a continent is still land — the case a clipped-edge renderer gets wrong —
and that the app and the generator agree on how deep the bundle goes.

The four above are dependency-free — no build, no emulator, no browser.

[`e2e-offline-map.mjs`](src/__tests__/e2e-offline-map.mjs) is the one check that needs both:
a browser and the dev server (`npm run e2e:offline`). It drives Chromium against the app
twice. First with every off-origin request aborted, which is what a phone with no data
is like, and asserts that the bundled world is what gets drawn — decoded out of the
canvas rather than trusted, with the badge, the place names, the pin and the style
switcher all still working. Then with the provider's tiles answered from a local stand-in
(a real bundled PNG), because the interesting failure is the opposite one: detection that
latches on the first batch, or that counts Leaflet's transparent stand-in for a failed
tile as an arrival, would leave the app calling itself offline while a perfectly good map
is on screen. It is the only place the two verdicts are proved to be reachable and
distinguishable.

## Notes

- **The map has three styles**, from `lib/map-style.ts`: *Light* and *Dark* are
  OpenStreetMap's tiles (dark is the same tiles flipped by a filter, because every
  key-free dark raster basemap now wants an API key the app would have to ship), and
  *Terrain* is OpenTopoMap. Nothing here needs a key, and each provider's required
  credit is attached to its own layer, so switching styles switches the credit with it.
  The choice is the user's and is kept in `spotpicker.settings`; with nothing saved yet
  it follows the app theme, so a dark app does not open onto a white map.
- **A world map ships inside the app**, under `public/tiles`, so the map draws with no
  data at all. It is drawn by `npm run tiles` from Natural Earth vectors (public
  domain) — land, lakes, borders, plus rivers and relief tints for the terrain palette —
  in the same three palettes, at zooms 0–4 in 8-bit indexed PNGs: 1023 tiles, about
  1.5 MB. Leaflet treats those as `maxNativeZoom: 4`, so zooming deeper scales the
  zoom-4 tile up rather than asking for a tile nobody has.
- **The offline world is drawn by us rather than cached from a provider** on purpose.
  OpenStreetMap's tile usage policy forbids offline use and pre-seeding outright,
  OpenTopoMap says nothing about keeping tiles, and the providers that do permit it
  (Stadia, Thunderforest) want a key and a subscription. Public-domain vectors have no
  such terms, and the `errorTileUrl` trick makes the pair seamless: a provider tile
  that fails to load is transparent, so the world underneath is simply what shows.
- **"Offline" is decided by the tiles, not by `navigator.onLine`**: a phone behind a
  captive portal reports being online and still fetches nothing. `MapView` counts
  `tileload` against `tileerror` and tells the app, which shows a badge and lets
  `MapView` label the bundled world with the biggest places from the gazetteer it
  already carries. The moment tiles arrive again the labels and the badge go away.
  Two details make that verdict honest: the counts are reset for each batch of tiles
  (Leaflet's `loading` event), so signal lost halfway through a pan is noticed as much
  as it is on the first load; and a tile whose `src` is the transparent error stub is
  not counted as an arrival, because Leaflet fires `tileload` for that stand-in once it
  has swapped it in — without that, a map with no data at all would report itself online.
- The map's floating controls sit in a container that is `pointer-events-none`, so that
  taps aimed at the gaps between them reach the map. `pointer-events` is inherited, so
  every button in that cluster has to opt back in with `pointer-events-auto`; without it
  the style, locate and reset buttons are visible, focusable and completely dead to a
  finger — the tap lands on the map and drops a pin instead.
- The app theme no longer filters the map: the filter belongs to the *dark style*, so a
  light map in a dark app stays light. The bundled dark tiles are drawn dark already and
  carry no filter of their own.
- The marker is a Leaflet `divIcon`, so there are no marker image assets to keep in sync
  with the bundler.
- Mock-location controls only appear when `window.SpotPicker` exists. Everything else —
  map, search, saved spots, route building — works identically in a browser and in the
  APK; only playback needs the native side.
- Route playback runs in the Android foreground service, not here. The web app sends
  the path once and then only polls progress, so a simulated journey survives the
  screen going off. `lib/route.ts` mirrors the native geometry for drawing and
  estimates, and both sides use the same earth radius so their distances agree.
- Road routes come from `lib/routing.ts`, which calls the public OSRM demo router. It is
  the one router that needs no API key *and* sends `Access-Control-Allow-Origin: *`,
  which is not optional here: the bundle is served from an asset origin, so anything
  without CORS headers is unreachable. The request asks for `steps=true` so each route
  arrives with its per-road names and signed numbers (`A 115`, `B 2`); `routeSurface()`
  totals the metres per road and turns them into the `via` line, the road list and the
  `% numbered` share the panel shows. Numbered roads are what make a route identifiable
  as *that* route rather than as a pair of coordinates.
- A road path arrives with hundreds of vertices, and the cap is **4000** on both sides,
  not the few hundred a drawn polyline would need. A road route is only a road route for
  as long as it still lies on the carriageway, so `thinToLimit` is a last resort rather
  than a first step: it starts at a 4 m tolerance and only loosens if the cap is really
  exceeded, and `maxDeviationMetres()` is there so the loosening can be measured. A
  real 6 km city pair arrives as 414–471 points and is handed over untouched.
- The mode cannot change *which* roads exist: the demo router ships only the driving
  graph and ignores the profile in the URL. The request still asks for the right
  profile, so the code is correct against a real OSRM deployment. It also cannot be
  told to *prefer* motorways — `exclude=motorway` and `exclude=toll` both come back
  `InvalidValue`, and there is no preference parameter — which is why **Highways first**
  in `App.tsx` ranks the options the router returned by `highwayShare` instead of
  directing the router. A strict highways-only path needs a self-hosted router with a
  custom profile.
- `openExternal()` in `lib/native.ts` crosses the bridge as `openExternalUrl`, and falls
  back to `window.open` in a browser. It exists for one case: handing the same journey to
  Google Maps, which the WebView cannot do by itself because the embedded browser has no
  address bar. The bridge refuses anything that is not `https://`.
- `base: './'` in `vite.config.ts` is required: the APK serves the bundle from a
  sub-path, and relative asset URLs are what make that work.
- `src/index.css` pins Tailwind's sources (`source(none)` plus explicit `@source`)
  instead of using automatic detection. Detection scans every text file in the
  project, so a stray word in a README or a test file becomes a utility class in the
  CSS that ships inside the APK — the build stops being reproducible. Add a source
  there if new class-bearing files ever live outside `src/**/*.ts(x)`.

See the [root README](../README.md) for Android setup and the APK.
