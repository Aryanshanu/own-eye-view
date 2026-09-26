# Own Eye View

Sovereign World Model & live telemetry proxy.

## Project Structure

- **`world-model-proxy/`**: Cloudflare Worker proxying and streaming several public data feeds.
  - `src/index.js`:
    - `GET /` — the original HTTP endpoint: one cached OpenSky snapshot, CORS-enabled (10s edge cache).
    - `GET /live` (WebSocket) — a `LiveFeedHub` Durable Object that polls flights (OpenSky),
      hazards (USGS earthquakes, NOAA weather alerts, NASA EONET wildfires/storms/volcanoes),
      and, if configured, ships (AIS via aisstream.io) on its own schedule and pushes every
      update to all connected browsers instantly, instead of each browser polling on its own.
    - `?demo=1` — simulated flights, for when OpenSky blocks or rate-limits the worker.
  - `wrangler.jsonc`: Cloudflare Workers configuration, including the Durable Object binding.
- **`world-model-proxy/sovereign-world-model/`**: Client dashboard with:
  - MapLibre GL rendering the [OpenFreeMap "Liberty"](https://openfreemap.org) style — free, no API key,
    full OpenStreetMap detail (roads, buildings, land use, water, place labels) plus extruded 3D buildings.
  - Live flights, ships and hazards as distinct map layers (rotated altitude-colored aircraft,
    ship positions, earthquakes sized by magnitude, wildfire/storm/volcano events), each with a
    click-for-details popup. Connects to the worker's `/live` stream first, falling back to the
    original HTTP polling if streaming can't be reached.
  - Place search via OpenStreetMap's Nominatim geocoder (no key required).
  - DuckDB-Wasm for local client-side SQL analytics (flights only — ships and hazards are kept
    as lightweight in-memory state instead, since ships in particular can update many times a
    second and re-inserting per update was exactly the performance bug fixed earlier for flights).
  - In-browser AI (TinyLlama via `@xenova/transformers`) that picks which live dataset (flights,
    ships, or hazards) to summarize based on the question, instead of dumping everything into
    every prompt.

### A note on scope

This aggregates *public infrastructure/environmental data* — flight positions, AIS ship
reports, and public hazard advisories — the same kind of data FlightRadar24, MarineTraffic, or
a weather app show. It does not track identifiable individuals or private vehicles by owner,
and isn't intended to.

## Getting Started

### 1. Cloudflare Worker Proxy

Navigate to `world-model-proxy`:
```bash
cd world-model-proxy
npm install
npm run dev
```

To deploy to Cloudflare Workers:
```bash
npm run deploy
```

**Real-time streaming (`/live`) needs Durable Objects.** Cloudflare has historically required
the $5/mo Workers Paid plan for Durable Objects and has been widening free-tier access to them
over time — check your account before relying on it. If `wrangler deploy` rejects the
`durable_objects` binding in `wrangler.jsonc`, your previous deployment is untouched (a failed
deploy never replaces a running one), and the dashboard automatically falls back to the original
HTTP polling — nothing else breaks.

**Ships (AIS) are optional.** Without an API key, the ships layer just stays empty; everything
else (flights, hazards) works regardless:
```bash
npx wrangler secret put AISSTREAM_API_KEY   # get a free key at aisstream.io
```
Its exact WebSocket message schema was implemented from memory and hasn't been verified against
aisstream.io's live docs — if ships never populate after setting the key, check the console for
`AIS connection failed` and compare the subscribe message in `connectAis()` against their current docs.

### 2. Sovereign World Model Dashboard

Open `world-model-proxy/sovereign-world-model/index.html` in your browser (or serve with a static server).
Set `DEFAULT_PROXY_URL` inside `index.html` to your deployed Worker URL. `npm run deploy` prints it;
it looks like `https://world-model-proxy.<your-subdomain>.workers.dev` (the name comes from `wrangler.jsonc`).
To try a URL without editing the file, open the page with `?proxy=<worker-url>`.

If OpenSky blocks or rate-limits the worker, the dashboard notices on its own: it falls back
to the worker's `?demo=1` data and the panel shows "AUTO-FALLBACK DEMO (live feed down, ...)".
Every poll still tries the live feed first, so it switches back on its own once OpenSky is
reachable again. You can also force demo data yourself with `?demo=1` on the page URL, which
shows "DEMO DATA" instead and skips the live attempt entirely. Either way the AI is told the
data is simulated, and if the live feed fails outright the panel shows the reason inline, e.g.
`Feed failed: HTTP 429` (no console needed).

If the AI panel shows `AI Query Failed: offset is out of bounds` (or a similar
`onnxruntime`/typed-array error), the cached model file in the browser's Cache Storage is
corrupted — usually from an earlier interrupted download. The page detects this and clears
the cache and reloads automatically; if it doesn't, hard-refresh (Ctrl/Cmd+Shift+R) or clear
the site's storage from devtools.

### 3. Deploy to Vercel

Import the repo in Vercel with the default settings (no framework, no build command).
`vercel.json` rewrites `/` to the dashboard page, so the site root serves the app.
