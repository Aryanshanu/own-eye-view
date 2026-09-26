# Own Eye View

Sovereign World Model & live telemetry proxy.

## Project Structure

- **`world-model-proxy/`**: Cloudflare Worker proxying public data feeds and brokering the hosted AI.
  - `src/index.js`:
    - `GET /` — one cached OpenSky flight snapshot, CORS-enabled (10s edge cache).
    - `?demo=1` — simulated flights, for when OpenSky blocks or rate-limits the worker.
    - `GET /satellites` — a small set of satellite TLEs (ISS, Tiangong, etc.) from CelesTrak's
      free, keyless catalog, cached for 5 minutes. The worker only fetches and parses the raw
      TLE text; actual orbit propagation (SGP4) happens client-side.
    - `POST /ask` — brokers a question + context to the Claude API server-side, so the API key
      never reaches the browser. Returns 501 if `ANTHROPIC_API_KEY` isn't set, so the frontend
      falls back to its local ($0) model instead of failing outright.
  - `wrangler.jsonc`: Cloudflare Workers configuration.
- **`world-model-proxy/sovereign-world-model/`**: Client dashboard with:
  - MapLibre GL rendering the [OpenFreeMap "Liberty"](https://openfreemap.org) style — free, no API key,
    full OpenStreetMap detail (roads, buildings, land use, water, place labels) plus extruded 3D buildings.
  - Live flights as rotated, altitude-colored aircraft icons, and satellites as a separate layer
    (positions computed client-side from CelesTrak TLEs via `satellite.js`/SGP4, refreshed every
    few seconds) — each with a click-for-details popup.
  - Place search via OpenStreetMap's Nominatim geocoder (no key required).
  - DuckDB-Wasm for local client-side SQL analytics over the flight data.
  - AI Q&A that prefers a hosted Claude model (via the worker's `/ask`, when configured) and
    falls back to a local, $0, in-browser model (TinyLlama via `@xenova/transformers`) otherwise —
    each answer is labeled `[Claude]` or `[Local]` so it's clear which one actually answered.

### A note on scope

This aggregates *public infrastructure/environmental data* — flight and satellite positions,
the same kind of data FlightRadar24 or a satellite tracker shows. It does not track
identifiable individuals or private vehicles by owner, and isn't intended to.

### Known incomplete UI

The dashboard's HUD/map still has **Ships** and **Hazards** rows/layers left over from a
real-time streaming design (flights + ships/AIS + earthquakes/weather/wildfires pushed over a
WebSocket via a Cloudflare Durable Object). That worker code caused a full outage after deploy
(both the live and demo flight feeds went down) and was reverted; the frontend pieces were left
in place since they degrade harmlessly (they just show "Not connected" / "—" — no data ever
arrives), but they don't do anything until a working streaming or polling backend for those
sources is rebuilt.

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

**Hosted AI (`/ask`) is optional.** Without a key, the dashboard just uses the local model:
```bash
npx wrangler secret put ANTHROPIC_API_KEY
```
`/ask` uses `claude-opus-5`. It's a real, metered API — unlike everything else in this project,
this is not $0. Keep an eye on usage if the site gets real traffic; there's no per-session cost
cap built in yet (gods-eye-view caps its own hosted AI at $5/session, for comparison).

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
`onnxruntime`/typed-array error) from the local model, the cached model file in the browser's
Cache Storage is corrupted — usually from an earlier interrupted download. The page detects
this and clears the cache and reloads automatically; if it doesn't, hard-refresh
(Ctrl/Cmd+Shift+R) or clear the site's storage from devtools.

### 3. Deploy to Vercel

Import the repo in Vercel with the default settings (no framework, no build command).
`vercel.json` rewrites `/` to the dashboard page, so the site root serves the app.
