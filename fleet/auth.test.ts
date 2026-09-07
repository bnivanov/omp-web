import { describe, expect, test } from "bun:test";
import {
	assertFleetBindSafe,
	authorizeFleetRequest,
	bearerMatches,
	csrfOk,
	CSRF_HEADER,
	isLoopbackAddress,
	isTailscaleAddress,
	sameOrigin,
	TAILSCALE_LOGIN_HEADER,
} from "./auth";

function req(
	method: string,
	headers: Record<string, string>,
	url = "http://127.0.0.1:4722/ctl/herd",
): { method: string; url: string; headers: Headers } {
	return { method, url, headers: new Headers(headers) };
}

describe("isLoopbackAddress", () => {
	test("127/8, localhost, ::1", () => {
		expect(isLoopbackAddress("127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("127.1.2.3")).toBe(true);
		expect(isLoopbackAddress("::1")).toBe(true);
		expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("10.0.0.1")).toBe(false);
		expect(isLoopbackAddress("192.168.1.1")).toBe(false);
	});
});

describe("isTailscaleAddress", () => {
	test("CGNAT 100.64/10 only", () => {
		expect(isTailscaleAddress("100.64.0.1")).toBe(true);
		expect(isTailscaleAddress("100.127.1.2")).toBe(true);
		expect(isTailscaleAddress("100.63.0.1")).toBe(false);
		expect(isTailscaleAddress("100.128.0.1")).toBe(false);
		expect(isTailscaleAddress("127.0.0.1")).toBe(false);
	});
});

describe("csrf / same-origin", () => {
	test("Origin matching Host passes; cross-site fails", () => {
		expect(
			sameOrigin(new Headers({ origin: "http://localhost:4713", host: "localhost:4713" })),
		).toBe(true);
		expect(sameOrigin(new Headers({ origin: "https://evil.com", host: "127.0.0.1:4722" }))).toBe(
			false,
		);
		expect(sameOrigin(new Headers({ host: "127.0.0.1:4722" }))).toBe(false);
	});
	test("GET skips CSRF; bearer skips CSRF; header matches token", () => {
		expect(csrfOk("GET", new Headers(), "tok")).toBe(true);
		expect(csrfOk("POST", new Headers(), "tok", { bearerOk: true })).toBe(true);
		expect(csrfOk("POST", new Headers({ [CSRF_HEADER]: "tok" }), "tok")).toBe(true);
		expect(csrfOk("POST", new Headers({ [CSRF_HEADER]: "nope" }), "tok")).toBe(false);
		expect(
			csrfOk("POST", new Headers({ origin: "http://localhost:4713" }), undefined, {
				loopbackPeer: true,
			}),
		).toBe(true);
	});
});

describe("authorizeFleetRequest", () => {
	const token = "fleet-secret";
	test("loopback GET and CLI POST (no Origin) pass without a token", () => {
		expect(authorizeFleetRequest(req("GET", {}), "127.0.0.1", { tailscaleAuth: false }).ok).toBe(
			true,
		);
		expect(authorizeFleetRequest(req("POST", {}), "127.0.0.1", { tailscaleAuth: false }).ok).toBe(
			true,
		);
		expect(
			authorizeFleetRequest(
				req("POST", { origin: "http://localhost:4713", host: "127.0.0.1:4722" }),
				"127.0.0.1",
				{ tailscaleAuth: false },
			).ok,
		).toBe(true);
	});

	test("loopback POST from a foreign Origin is CSRF-rejected", () => {
		const decision = authorizeFleetRequest(
			req("POST", { origin: "https://evil.com", host: "127.0.0.1:4722" }),
			"127.0.0.1",
			{ tailscaleAuth: false },
		);
		expect(decision.ok).toBe(false);
		expect(decision.status).toBe(403);
	});

	test("off-loopback without bearer is 401", () => {
		const decision = authorizeFleetRequest(req("GET", {}), "10.0.0.8", { tailscaleAuth: false });
		expect(decision.ok).toBe(false);
		expect(decision.status).toBe(401);
	});

	test("off-loopback bearer authorizes mutating calls without Origin", () => {
		const decision = authorizeFleetRequest(
			req("POST", { authorization: `Bearer ${token}` }),
			"10.0.0.8",
			{ token, tailscaleAuth: false },
		);
		expect(decision.ok).toBe(true);
		expect(bearerMatches(req("GET", { authorization: `Bearer ${token}` }), token)).toBe(true);
	});

	test("Tailscale identity from a tailnet IP is enough", () => {
		const decision = authorizeFleetRequest(
			req("GET", { [TAILSCALE_LOGIN_HEADER]: "you@example.com" }),
			"100.64.1.2",
			{ tailscaleAuth: true },
		);
		expect(decision.ok).toBe(true);
	});

	test("spoofed Tailscale header from a public IP is 401", () => {
		const decision = authorizeFleetRequest(
			req("GET", { [TAILSCALE_LOGIN_HEADER]: "you@example.com" }),
			"8.8.8.8",
			{ tailscaleAuth: true },
		);
		expect(decision.ok).toBe(false);
	});
});

describe("assertFleetBindSafe", () => {
	test("loopback is always safe; 0.0.0.0 needs token or tailscale", () => {
		expect(() => assertFleetBindSafe("127.0.0.1", { tailscaleAuth: false })).not.toThrow();
		expect(() => assertFleetBindSafe("0.0.0.0", { tailscaleAuth: false })).toThrow(/requires/);
		expect(() =>
			assertFleetBindSafe("0.0.0.0", { token: "x", tailscaleAuth: false }),
		).not.toThrow();
		expect(() => assertFleetBindSafe("0.0.0.0", { tailscaleAuth: true })).not.toThrow();
	});
});
