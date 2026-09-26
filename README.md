# Own Eye View

Sovereign World Model & live telemetry proxy.

## Project Structure

- **`world-model-proxy/`**: Cloudflare Worker proxy providing cached, CORS-enabled upstream telemetry data (e.g. OpenSky Network).
  - `src/index.js`: Worker entrypoint caching live telemetry feed.
  - `wrangler.jsonc`: Cloudflare Workers configuration.
- **`world-model-proxy/sovereign-world-model/`**: Client dashboard with:
  - MapLibre GL rendering the [OpenFreeMap "Liberty"](https://openfreemap.org) style — free, no API key,
    full OpenStreetMap detail (roads, buildings, land use, water, place labels) plus extruded 3D buildings.
  - Live flight telemetry as rotated, altitude-colored aircraft icons with a click-for-details popup.
  - Place search via OpenStreetMap's Nominatim geocoder (no key required).
  - DuckDB-Wasm for local client-side SQL analytics.
  - In-browser AI models via `@xenova/transformers`.

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

### 2. Sovereign World Model Dashboard

Open `world-model-proxy/sovereign-world-model/index.html` in your browser (or serve with a static server).
Set `DEFAULT_PROXY_URL` inside `index.html` to your deployed Worker URL. `npm run deploy` prints it;
it looks like `https://world-model-proxy.<your-subdomain>.workers.dev` (the name comes from `wrangler.jsonc`).
To try a URL without editing the file, open the page with `?proxy=<worker-url>`.

If OpenSky blocks or rate-limits the worker, the panel now shows the reason inline, e.g.
`Proxy Error: Proxy failed: HTTP 429` (no console needed). Add `?demo=1` to the page URL in
that case: the worker then returns 24 simulated aircraft over the bounding box, and the panel
shows "DEMO DATA" so it is never mistaken for live traffic.

If the AI panel shows `AI Query Failed: offset is out of bounds` (or a similar
`onnxruntime`/typed-array error), the cached model file in the browser's Cache Storage is
corrupted — usually from an earlier interrupted download. The page detects this and clears
the cache and reloads automatically; if it doesn't, hard-refresh (Ctrl/Cmd+Shift+R) or clear
the site's storage from devtools.

### 3. Deploy to Vercel

Import the repo in Vercel with the default settings (no framework, no build command).
`vercel.json` rewrites `/` to the dashboard page, so the site root serves the app.
