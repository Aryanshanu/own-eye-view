import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { OPENSKY_URL } from "../src";

afterEach(() => {
	vi.restoreAllMocks();
});

async function callWorker(request) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
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
});
