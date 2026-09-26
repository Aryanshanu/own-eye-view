# Own Eye View

Sovereign World Model & live telemetry proxy.

## Project Structure

- **`world-model-proxy/`**: Cloudflare Worker proxy providing cached, CORS-enabled upstream telemetry data (e.g. OpenSky Network).
  - `src/index.js`: Worker entrypoint caching live telemetry feed.
  - `wrangler.jsonc`: Cloudflare Workers configuration.
- **`world-model-proxy/sovereign-world-model/`**: Client dashboard with:
  - MapLibre GL for map and live flight telemetry visualization.
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
Update `PROXY_WORKER_URL` inside `index.html` with your deployed Cloudflare Worker URL.
