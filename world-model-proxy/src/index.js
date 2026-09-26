/**
 * World Model proxy: fetches live OpenSky state vectors for a fixed bounding box,
 * adds CORS headers, and caches successful responses at the edge for 10 seconds.
 * Also brokers POST /ask to the Claude API server-side, so the API key never
 * reaches the browser (the same "credential brokering" pattern gods-eye-view uses
 * for its own API keys).
 *
 * - `npm run dev` starts a local server on http://localhost:8787/
 * - `npm run deploy` publishes to https://world-model-proxy.<your-subdomain>.workers.dev
 */

import Anthropic from "@anthropic-ai/sdk";

const ASK_MODEL = "claude-opus-5";
const ASK_MAX_TOKENS = 300; // this is short Q&A over a data summary, not long-form generation
const ASK_SYSTEM_PROMPT =
  "You are a helpful assistant analyzing live public data: aircraft positions (OpenSky), " +
  "ship positions (AIS), and public hazard advisories (USGS earthquakes, NOAA weather alerts, " +
  "NASA EONET wildfires/storms/volcanoes). Answer concisely, based ONLY on the context given " +
  "to you in the user message. If the context doesn't cover the question (e.g. flight routes, " +
  "vehicle ownership, or anything about identifiable individuals), say so plainly instead of " +
  "guessing — this data has no such information and never will.";

// POST /ask {question, context} -> {answer}. Brokered through the worker so the API key stays
// server-side. Returns 501 if ANTHROPIC_API_KEY isn't set, so the frontend can fall back to its
// local ($0) model instead of just failing — same "optional, degrades gracefully" pattern as ships.
async function handleAsk(request, env) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), {
      status: 405,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  }
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "Hosted AI not configured", details: "ANTHROPIC_API_KEY not set" }), {
      status: 501,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  }
  const question = typeof body.question === "string" ? body.question.slice(0, 2000) : "";
  const context = typeof body.context === "string" ? body.context.slice(0, 4000) : "";
  if (!question) {
    return new Response(JSON.stringify({ error: "Missing question" }), {
      status: 400,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  }

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: ASK_MODEL,
      max_tokens: ASK_MAX_TOKENS,
      system: ASK_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Context: ${context}\n\nQuestion: ${question}` }],
    });
    const answer = response.content.find((block) => block.type === "text")?.text || "(empty response)";
    return new Response(JSON.stringify({ answer, model: ASK_MODEL }), {
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Claude API request failed:", err);
    return new Response(JSON.stringify({ error: "Hosted AI request failed", details: err.message }), {
      status: 502,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  }
}

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

// Satellites: CelesTrak's keyless TLE catalog. "stations" is a small, meaningful set
// (ISS, Tiangong, etc.) rather than the full 800+ object catalog, which would be heavy
// to render and propagate every poll. The worker only fetches and parses the raw TLE
// text into clean JSON; actual orbit propagation (SGP4) happens client-side with
// satellite.js, the same "compute on the client" pattern as everything else in this app.
export const CELESTRAK_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle";
const UPSTREAM_HEADERS = { "User-Agent": "SovereignWorldModel/1.0 (Educational)" };

// CelesTrak's TLE format is 3 lines per satellite: name, then the two TLE lines.
export function parseTleText(text) {
  const lines = (text || "").split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const satellites = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i].trim();
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (line1?.startsWith("1 ") && line2?.startsWith("2 ")) {
      satellites.push({ name, line1, line2 });
    }
  }
  return satellites;
}

async function handleSatellites(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), request);
  let response = await cache.match(cacheKey);
  if (response) return response;

  try {
    const upstream = await fetch(CELESTRAK_URL, { headers: UPSTREAM_HEADERS });
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    const satellites = parseTleText(await upstream.text());
    response = new Response(JSON.stringify({ satellites }), {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
        // TLEs barely change minute to minute; cache generously so we're a light,
        // well-behaved client of CelesTrak's free, keyless catalog.
        "Cache-Control": "public, max-age=300",
      },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return new Response(JSON.stringify({ error: "Upstream fetch failed", details: err.message }), {
      status: 502,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  }
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

    if (cacheUrl.pathname === "/ask") {
      return handleAsk(request, env);
    }
    if (cacheUrl.pathname === "/satellites") {
      return handleSatellites(request, env, ctx);
    }

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