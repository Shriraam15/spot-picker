# Spot Picker — web app

React + TypeScript + Vite + Tailwind v4 + Leaflet. This is the UI that ships inside the
Android APK, and it also runs standalone in a browser.

```bash
npm install
npm run dev      # dev server
npm test         # bridge contract + route geometry
npm run build    # production build -> dist/
npm run preview  # serve the production build
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

Both are dependency-free — no build, no emulator.

## Notes

- The map uses OpenStreetMap tiles only. Dark mode is a CSS filter on
  `.leaflet-tile-pane` rather than a second tile provider, because every key-free dark
  tile provider either requires an API key or has since started.
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
