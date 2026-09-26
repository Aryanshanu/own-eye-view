/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

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
        // Fetch live OpenSky data (Bounding box: Central Europe)
        const openskyUrl = "https://opensky-network.org/api/states/all?lamin=12.0&lomin=76.0&lamax=18.0&lomax=80.0";
        
        response = await fetch(openskyUrl, {
          headers: { "User-Agent": "SovereignWorldModel/1.0 (Educational)" }
        });

        // 3. Add CORS headers and cache the response
        const corsResponse = new Response(response.body, response);
        corsResponse.headers.set("Access-Control-Allow-Origin", "*");
        corsResponse.headers.set("Cache-Control", "public, max-age=10"); 
        
        ctx.waitUntil(cache.put(cacheKey, corsResponse.clone()));
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