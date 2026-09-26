/**
 * World Model proxy.
 *
 * Two ways to get data out of this worker:
 *  - HTTP polling (original design): GET / returns one OpenSky snapshot, cached
 *    for 10s at the edge. Still here, unchanged, for backward compatibility and
 *    as the frontend's fallback if streaming isn't available.
 *  - Real-time streaming (new): GET /live with a WebSocket Upgrade header connects
 *    to a single shared `LiveFeedHub` Durable Object, which polls each upstream
 *    source on its own schedule (via the Alarms API) and pushes every update to
 *    all connected browsers instantly, instead of each browser polling on its own.
 *
 * `npm run dev` starts a local server on http://localhost:8787/
 * `npm run deploy` publishes to https://world-model-proxy.<your-subdomain>.workers.dev
 *
 * IMPORTANT — Durable Objects have historically required the Workers Paid plan.
 * Cloudflare has been widening free-tier access to them, but this can't be
 * verified from here. If `wrangler deploy` rejects the durable_objects binding
 * in wrangler.jsonc, the previously-deployed worker keeps running unaffected
 * (a failed deploy never replaces a live one) — the HTTP polling endpoints
 * above don't depend on Durable Objects at all.
 */

// Bounding box: South-Central India (Hyderabad ~17.4N 78.5E, Bengaluru ~13.0N 77.6E)
export const OPENSKY_URL =
  "https://opensky-network.org/api/states/all?lamin=12.0&lomin=76.0&lamax=18.0&lomax=80.0";

// Free, keyless, public real-time hazard feeds (US-scoped for NOAA; global for the others).
export const USGS_QUAKES_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson";
export const NOAA_ALERTS_URL = "https://api.weather.gov/alerts/active?status=actual&message_type=alert";
export const EONET_EVENTS_URL = "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=50";

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

// --- Pure normalizers for the hazard feeds, kept separate from fetch() so they're testable
//     against fixture JSON without a network call. ---

export function normalizeEarthquakes(geojson) {
  return (geojson?.features || []).map((f) => ({
    id: f.id,
    mag: f.properties?.mag ?? null,
    place: f.properties?.place ?? "Unknown location",
    time: f.properties?.time ?? null,
    url: f.properties?.url ?? null,
    lon: f.geometry?.coordinates?.[0] ?? null,
    lat: f.geometry?.coordinates?.[1] ?? null,
    depthKm: f.geometry?.coordinates?.[2] ?? null,
  })).filter((q) => q.lon != null && q.lat != null);
}

export function normalizeAlerts(json) {
  return (json?.features || []).map((f) => ({
    id: f.id,
    event: f.properties?.event ?? "Alert",
    severity: f.properties?.severity ?? "Unknown",
    area: f.properties?.areaDesc ?? "Unknown area",
    headline: f.properties?.headline ?? null,
  }));
}

export function normalizeEonetEvents(json) {
  return (json?.events || []).map((e) => {
    const geom = e.geometry?.[e.geometry.length - 1]; // most recent point for this event
    return {
      id: e.id,
      title: e.title,
      category: e.categories?.[0]?.title ?? "Event",
      lon: geom?.coordinates?.[0] ?? null,
      lat: geom?.coordinates?.[1] ?? null,
      date: geom?.date ?? null,
    };
  }).filter((e) => e.lon != null && e.lat != null);
}

const UPSTREAM_HEADERS = { "User-Agent": "SovereignWorldModel/1.0 (Educational; contact: none)" };

async function fetchJson(url, fallback) {
  try {
    const res = await fetch(url, { headers: UPSTREAM_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`fetchJson failed for ${url}:`, err.message);
    return fallback;
  }
}

async function pollHazards() {
  const [quakesJson, alertsJson, eonetJson] = await Promise.all([
    fetchJson(USGS_QUAKES_URL, null),
    fetchJson(NOAA_ALERTS_URL, null),
    fetchJson(EONET_EVENTS_URL, null),
  ]);
  return {
    type: "hazards",
    earthquakes: quakesJson ? normalizeEarthquakes(quakesJson) : [],
    alerts: alertsJson ? normalizeAlerts(alertsJson) : [],
    events: eonetJson ? normalizeEonetEvents(eonetJson) : [],
    fetchedAt: Date.now(),
  };
}

async function pollFlights() {
  try {
    const res = await fetch(OPENSKY_URL, { headers: UPSTREAM_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return { type: "flights", source: "live", time: json.time, states: json.states || [] };
  } catch (err) {
    console.warn("Live OpenSky poll failed, using demo flights:", err.message);
    const demo = demoStates();
    return { type: "flights", source: "demo", time: demo.time, states: demo.states };
  }
}

// --- Durable Object: one shared hub per worker, polling upstream sources on a
//     timer (Alarms API) and pushing every update to all connected browsers. ---
const ALARM_INTERVAL_MS = 15000;

export class LiveFeedHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
    this.latest = { flights: null, hazards: null, ships: null };
    this.aisStatus = "not configured";

    this.state.blockConcurrencyWhile(async () => {
      const existing = await this.state.storage.getAlarm();
      if (!existing) await this.state.storage.setAlarm(Date.now() + 1000);
    });

    // Best-effort persistent AIS ship feed. Optional: only attempted if an API key
    // secret is set (`wrangler secret put AISSTREAM_API_KEY`). aisstream.io's exact
    // message schema hasn't been verified against their live docs from this sandbox —
    // if the subscribe message shape below is wrong, this just logs and ships stay
    // empty; flights and hazards are unaffected either way.
    if (this.env.AISSTREAM_API_KEY) {
      this.connectAis().catch((err) => {
        this.aisStatus = `error: ${err.message}`;
        console.warn("AIS connection failed:", err);
      });
    }
  }

  async connectAis() {
    const resp = await fetch("https://stream.aisstream.io/v0/stream", {
      headers: { Upgrade: "websocket" },
    });
    const ws = resp.webSocket;
    if (!ws) throw new Error("aisstream.io did not upgrade to a WebSocket");
    ws.accept();
    this.aisStatus = "connecting";

    ws.send(JSON.stringify({
      APIKey: this.env.AISSTREAM_API_KEY,
      // Same India bounding box as the flights feed, as [[lat_min, lon_min], [lat_max, lon_max]]
      BoundingBoxes: [[[12.0, 76.0], [18.0, 80.0]]],
      FilterMessageTypes: ["PositionReport"],
    }));

    ws.addEventListener("message", (event) => {
      this.aisStatus = "streaming";
      try {
        const msg = JSON.parse(event.data);
        const report = msg?.Message?.PositionReport;
        if (!report) return;
        this.broadcast({
          type: "ships",
          ship: {
            mmsi: msg.MetaData?.MMSI ?? report.UserID,
            name: msg.MetaData?.ShipName?.trim() || null,
            lat: report.Latitude,
            lon: report.Longitude,
            speed: report.Sog, // knots
            course: report.Cog, // degrees
          },
        });
      } catch (err) {
        console.warn("Bad AIS message:", err.message);
      }
    });
    ws.addEventListener("close", () => { this.aisStatus = "disconnected"; });
    ws.addEventListener("error", () => { this.aisStatus = "error"; });
  }

  async alarm() {
    const [flights, hazards] = await Promise.all([pollFlights(), pollHazards()]);
    this.broadcast(flights);
    this.broadcast(hazards);
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  broadcast(message) {
    this.latest[message.type] = message;
    const text = JSON.stringify(message);
    for (const ws of this.sockets) {
      try {
        ws.send(text);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket Upgrade request", { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets.add(server);
    server.addEventListener("close", () => this.sockets.delete(server));
    server.addEventListener("error", () => this.sockets.delete(server));

    // Send whatever we already have so a new client isn't blank until the next tick.
    for (const type of Object.keys(this.latest)) {
      if (this.latest[type]) server.send(JSON.stringify(this.latest[type]));
    }
    server.send(JSON.stringify({ type: "ais-status", status: this.aisStatus }));

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Real-time streaming: proxy the WebSocket upgrade to the shared Durable Object.
    if (url.pathname === "/live") {
      if (!env.LIVE_FEED_HUB) {
        return new Response(
          JSON.stringify({ error: "Streaming not configured", details: "LIVE_FEED_HUB binding missing" }),
          { status: 501, headers: { "Content-Type": "application/json" } }
        );
      }
      const id = env.LIVE_FEED_HUB.idFromName("global");
      const stub = env.LIVE_FEED_HUB.get(id);
      return stub.fetch(request);
    }

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

    // Demo mode (?demo=1): simulated data for when OpenSky blocks or rate-limits the worker
    if (url.searchParams.get("demo") === "1") {
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

    const cacheKey = new Request(url.toString(), request);
    const cache = caches.default;

    // 2. Check cache first (10-second TTL)
    let response = await cache.match(cacheKey);

    if (!response) {
      try {
        response = await fetch(OPENSKY_URL, { headers: UPSTREAM_HEADERS });

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
