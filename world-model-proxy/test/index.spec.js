import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { OPENSKY_URL, demoStates, CELESTRAK_URL, parseTleText } from "../src";

afterEach(() => {
	vi.restoreAllMocks();
});

async function callWorker(request, envOverride = env) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, envOverride, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

describe("world-model-proxy", () => {
	it("answers CORS preflight without hitting upstream", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const response = await callWorker(
			new Request("http://example.com/", { method: "OPTIONS" }),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("queries the India bounding box", () => {
		const params = new URL(OPENSKY_URL).searchParams;
		expect(Object.fromEntries(params)).toEqual({
			lamin: "12.0",
			lomin: "76.0",
			lamax: "18.0",
			lomax: "80.0",
		});
	});

	it("proxies upstream data with CORS headers", async () => {
		const body = JSON.stringify({ time: 1, states: [] });
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(body, { status: 200 }));
		const response = await callWorker(new Request("http://example.com/ok"));
		expect(fetchSpy).toHaveBeenCalledWith(OPENSKY_URL, expect.anything());
		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(await response.json()).toEqual({ time: 1, states: [] });
	});

	it("passes upstream errors through without caching them", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("Too Many Requests", { status: 429 }),
		);
		const response = await callWorker(new Request("http://example.com/err"));
		expect(response.status).toBe(429);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("returns 502 when upstream is unreachable", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
		const response = await callWorker(new Request("http://example.com/down"));
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: "Upstream fetch failed" });
	});

	it("serves simulated data inside the bounding box with ?demo=1", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const response = await callWorker(new Request("http://example.com/?demo=1"));
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(response.headers.get("X-Data-Source")).toBe("demo");
		const data = await response.json();
		expect(data.states).toHaveLength(24);
		for (const s of data.states) {
			expect(s[6]).toBeGreaterThanOrEqual(12);
			expect(s[6]).toBeLessThanOrEqual(18);
			expect(s[5]).toBeGreaterThanOrEqual(76);
			expect(s[5]).toBeLessThanOrEqual(80);
		}
	});

	it("moves demo aircraft over time", () => {
		const a = demoStates(0).states[0];
		const b = demoStates(10_000).states[0];
		expect([a[5], a[6]]).not.toEqual([b[5], b[6]]);
	});
});

describe("POST /ask (hosted AI, brokered server-side)", () => {
	it("returns 501 without an API key, instead of failing outright", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const response = await callWorker(
			new Request("http://example.com/ask", { method: "POST", body: JSON.stringify({ question: "hi" }) }),
			{ ...env, ANTHROPIC_API_KEY: undefined },
		);
		expect(response.status).toBe(501);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects non-POST requests", async () => {
		const response = await callWorker(
			new Request("http://example.com/ask"),
			{ ...env, ANTHROPIC_API_KEY: "test-key" },
		);
		expect(response.status).toBe(405);
	});

	it("rejects a missing question", async () => {
		const response = await callWorker(
			new Request("http://example.com/ask", { method: "POST", body: JSON.stringify({}) }),
			{ ...env, ANTHROPIC_API_KEY: "test-key" },
		);
		expect(response.status).toBe(400);
	});

	it("calls the Claude API and returns the extracted text (proves the SDK bundles/runs in the Workers runtime)", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({
				id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5",
				content: [{ type: "text", text: "12 flights are active." }],
				stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 6 },
			}), { status: 200, headers: { "Content-Type": "application/json" } }),
		);

		const response = await callWorker(
			new Request("http://example.com/ask", {
				method: "POST",
				body: JSON.stringify({ question: "How many flights are active?", context: "12 flights active." }),
			}),
			{ ...env, ANTHROPIC_API_KEY: "test-key" },
		);

		expect(fetchSpy).toHaveBeenCalled();
		const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
		expect(String(calledUrl)).toContain("api.anthropic.com");
		expect(calledInit.headers["x-api-key"] ?? calledInit.headers.get?.("x-api-key")).toBe("test-key");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ answer: "12 flights are active.", model: "claude-opus-5" });
	});

	it("returns 502 with details when the Claude API call fails", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
		const response = await callWorker(
			new Request("http://example.com/ask", { method: "POST", body: JSON.stringify({ question: "hi" }) }),
			{ ...env, ANTHROPIC_API_KEY: "test-key" },
		);
		expect(response.status).toBe(502);
	});
});

describe("GET /satellites (CelesTrak TLEs, orbit propagation happens client-side)", () => {
	const SAMPLE_TLE =
		"ISS (ZARYA)\n" +
		"1 25544U 98067A   26001.50000000  .00016717  00000-0  10270-3 0  9008\n" +
		"2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391  1234\n" +
		"CSS (TIANHE)\n" +
		"1 48274U 21035A   26001.50000000  .00021000  00000-0  20000-3 0  9001\n" +
		"2 48274  41.4700 200.0000 0005000 100.0000 260.0000 15.60000000  5678\n";

	it("parseTleText groups the 3-line records into {name, line1, line2}", () => {
		expect(parseTleText(SAMPLE_TLE)).toEqual([
			{ name: "ISS (ZARYA)", line1: "1 25544U 98067A   26001.50000000  .00016717  00000-0  10270-3 0  9008", line2: "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391  1234" },
			{ name: "CSS (TIANHE)", line1: "1 48274U 21035A   26001.50000000  .00021000  00000-0  20000-3 0  9001", line2: "2 48274  41.4700 200.0000 0005000 100.0000 260.0000 15.60000000  5678" },
		]);
	});

	it("parseTleText ignores malformed trailing lines and empty input", () => {
		expect(parseTleText("")).toEqual([]);
		expect(parseTleText(null)).toEqual([]);
		expect(parseTleText("ISS (ZARYA)\nnot a tle line\n")).toEqual([]);
	});

	it("fetches and parses CelesTrak, with CORS headers and edge caching", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(SAMPLE_TLE, { status: 200 }));
		const response = await callWorker(new Request("http://example.com/satellites?t=ok"));
		expect(fetchSpy).toHaveBeenCalledWith(CELESTRAK_URL, expect.anything());
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		const data = await response.json();
		expect(data.satellites).toHaveLength(2);
		expect(data.satellites[0].name).toBe("ISS (ZARYA)");
	});

	it("returns 502 with details when CelesTrak is unreachable", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
		// A distinct query string so this doesn't hit the edge cache entry from the test above.
		const response = await callWorker(new Request("http://example.com/satellites?t=err"));
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: "Upstream fetch failed" });
	});
});
