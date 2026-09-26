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

const DEMO_FLIGHTS = 24;

// Simulated aircraft inside the bounding box, in OpenSky's state-vector layout:
// [icao24, callsign, origin_country, time_position, last_contact, longitude,
//  latitude, baro_altitude, on_ground, velocity, true_track, vertical_rate, ...]
// Each aircraft flies a fixed ellipse, so positions change between polls.
export function demoStates(nowMs = Date.now()) {
  const t = Math.floor(nowMs / 1000);
  const states = [];
  for (let i = 0; i < DEMO_FLIGHTS; i++) {
    const phase = (t / 600 + i / DEMO_FLIGHTS) * 2 * Math.PI;
    const lat = 15.0 + 2.5 * Math.sin(phase + i);
    const lon = 78.0 + 1.6 * Math.cos(phase * (1 + (i % 3) / 10));
    states.push([
      (0x800000 + i).toString(16), `DEMO${String(100 + i)}`, "India", t, t,
      Number(lon.toFixed(4)), Number(lat.toFixed(4)), 3000 + (i % 8) * 1200,
      false, 220 + (i % 5) * 10, ((phase * 180) / Math.PI + 90) % 360, 0,
      null, null, null, false, 0,
    ]);
  }
  return { time: t, states };
}

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

    // Demo mode (?demo=1): simulated data for when OpenSky blocks or rate-limits the worker
    if (cacheUrl.searchParams.get("demo") === "1") {
      return new Response(JSON.stringify(demoStates()), {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "X-Data-Source",
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Data-Source": "demo",
        },
      });
    }

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