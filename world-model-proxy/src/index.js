/**
 * World Model proxy: fetches live OpenSky state vectors for a fixed bounding box,
 * adds CORS headers, and caches successful responses at the edge for 10 seconds.
 *
 * - `npm run dev` starts a local server on http://localhost:8787/
 * - `npm run deploy` publishes to https://world-model-proxy.<your-subdomain>.workers.dev
 */

// Bounding box: South-Central India (Hyderabad ~17.4N 78.5E, Bengaluru ~13.0N 77.6E)
export const OPENSKY_URL =
  "https://opensky-network.org/api/states/all?lamin=12.0&lomin=76.0&lamax=18.0&lomax=80.0";

export default {
  async fetch(request, env, ctx) {
    // 1. Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const cacheUrl = new URL(request.url);
    const cacheKey = new Request(cacheUrl.toString(), request);
    const cache = caches.default;

    // 2. Check cache first (10-second TTL)
    let response = await cache.match(cacheKey);
    
    if (!response) {
      try {
        response = await fetch(OPENSKY_URL, {
          headers: { "User-Agent": "SovereignWorldModel/1.0 (Educational)" }
        });

        // 3. Add CORS headers; only cache successful responses so an upstream
        //    429/5xx isn't served to every client for the next 10 seconds
        const corsResponse = new Response(response.body, response);
        corsResponse.headers.set("Access-Control-Allow-Origin", "*");
        if (response.ok) {
          corsResponse.headers.set("Cache-Control", "public, max-age=10");
          ctx.waitUntil(cache.put(cacheKey, corsResponse.clone()));
        } else {
          corsResponse.headers.set("Cache-Control", "no-store");
        }
        response = corsResponse;
      } catch (err) {
        return new Response(JSON.stringify({ error: "Upstream fetch failed", details: err.message }), {
          status: 502,
          headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }
        });
      }
    }

    return response;
  }
};