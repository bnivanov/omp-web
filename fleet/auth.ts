/**
 * Fleet caller authentication + CSRF for /ctl and /command.
 *
 * Loopback peers stay CLI-trusted. Off-loopback requires a fleet bearer
 * token (`Authorization: Bearer` / `?token=`) or, when enabled, a Tailscale
 * identity header from a Tailscale CGNAT/ULA peer. Mutating requests from
 * browsers need Same-Origin (`Origin`/`Referer` vs `Host`) or `x-omp-csrf`
 * equal to the fleet token. A valid bearer skips CSRF (bots, Hermes).
 */

export const CSRF_HEADER = "x-omp-csrf";
export const TAILSCALE_LOGIN_HEADER = "tailscale-user-login";

export interface FleetAuthConfig {
	/** Fleet operator bearer. Absent → off-loopback fails unless Tailscale auth is on. */
	token?: string;
	/** Trust Tailscale-User-Login from Tailscale IP space. */
	tailscaleAuth: boolean;
}

export interface AuthDecision {
	ok: boolean;
	status: 401 | 403;
	error: string;
}

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;
const TAILSCALE_CGNAT = /^100\.(?:6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./;

export function isLoopbackAddress(address: string | null | undefined): boolean {
	if (!address) return false;
	const h = address.toLowerCase();
	if (h === "localhost" || h === "::1") return true;
	const v4 = h.startsWith("::ffff:") ? h.slice(7) : h;
	return LOOPBACK_V4.test(v4);
}

/** Tailscale CGNAT 100.64.0.0/10 or IPv4-mapped of the same. */
export function isTailscaleAddress(address: string | null | undefined): boolean {
	if (!address) return false;
	const h = address.toLowerCase();
	const v4 = h.startsWith("::ffff:") ? h.slice(7) : h;
	return TAILSCALE_CGNAT.test(v4);
}

export function isLoopbackHostBind(host: string): boolean {
	const h = host.toLowerCase();
	if (h === "localhost" || h === "::1" || h === "127.0.0.1") return true;
	const v4 = h.startsWith("::ffff:") ? h.slice(7) : h;
	const parts = v4.split(".");
	return parts.length === 4 && parts.every((p) => /^\d+$/.test(p)) && Number(parts[0]) === 127;
}

function bearerHeaderOk(header: string | null, token: string): boolean {
	if (header === null) return false;
	return header.slice(0, 7).toLowerCase() === "bearer " && header.slice(7) === token;
}

export function bearerMatches(req: { headers: Headers; url: string }, token: string): boolean {
	if (bearerHeaderOk(req.headers.get("authorization"), token)) return true;
	return new URL(req.url).searchParams.get("token") === token;
}

export function tailscaleLogin(headers: Headers): string | null {
	const login = headers.get(TAILSCALE_LOGIN_HEADER)?.trim();
	return login && login.length > 0 ? login : null;
}

function requestHost(headers: Headers): string | null {
	const forwarded = headers.get("x-forwarded-host");
	if (forwarded && forwarded.length > 0) return forwarded.split(",")[0]!.trim();
	return headers.get("host");
}

function originHost(raw: string): string | null {
	try {
		return new URL(raw).host;
	} catch {
		return null;
	}
}

/** Same-origin vs Host / X-Forwarded-Host. Missing Origin+Referer → non-browser. */
export function sameOrigin(headers: Headers): boolean {
	const origin = headers.get("origin");
	const referer = headers.get("referer");
	const raw = origin && origin !== "null" ? origin : referer;
	if (!raw) return false;
	const host = requestHost(headers);
	if (!host) return false;
	return originHost(raw) === host;
}

const SAFE_METHODS: Record<string, true> = { GET: true, HEAD: true, OPTIONS: true };

export function csrfOk(
	method: string,
	headers: Headers,
	token: string | undefined,
	opts?: { bearerOk?: boolean; loopbackPeer?: boolean },
): boolean {
	if (SAFE_METHODS[method.toUpperCase()]) return true;
	if (opts?.bearerOk) return true;
	if (token !== undefined && headers.get(CSRF_HEADER) === token) return true;
	if (sameOrigin(headers)) return true;
	// Vite (and other local reverse proxies) POST with Origin=localhost:<ui>
	// and Host=127.0.0.1:<fleet>. Treat loopback-to-loopback as same-site.
	if (opts?.loopbackPeer && originIsLoopback(headers)) return true;
	return false;
}

function originIsLoopback(headers: Headers): boolean {
	const origin = headers.get("origin");
	const referer = headers.get("referer");
	const raw = origin && origin !== "null" ? origin : referer;
	if (!raw) return false;
	try {
		const u = new URL(raw);
		return isLoopbackAddress(u.hostname) || u.hostname === "localhost";
	} catch {
		return false;
	}
}

/**
 * Full gate. Loopback mutating requests without Origin are CLI (allowed);
 * a cross-site Origin against loopback is CSRF-rejected. A loopback Origin
 * against a loopback peer is allowed (local UI proxy).
 */
export function authorizeFleetRequest(
	req: { method: string; url: string; headers: Headers },
	peerAddress: string | null,
	auth: FleetAuthConfig,
): AuthDecision {
	const loopback = isLoopbackAddress(peerAddress);
	const token = auth.token;
	const hasBearer = token !== undefined && bearerMatches(req, token);
	const tsLogin = tailscaleLogin(req.headers);
	const tsOk =
		auth.tailscaleAuth && tsLogin !== null && (loopback || isTailscaleAddress(peerAddress));

	if (!loopback && !hasBearer && !tsOk) {
		return { ok: false, status: 401, error: "Unauthorized" };
	}

	if (SAFE_METHODS[req.method.toUpperCase()]) return { ok: true, status: 401, error: "" };

	// Loopback CLI (curl, omp-fleet) sends no Origin. Browsers always do on POST.
	if (loopback && !req.headers.get("origin") && !req.headers.get("referer")) {
		return { ok: true, status: 401, error: "" };
	}

	if (!csrfOk(req.method, req.headers, token, { bearerOk: hasBearer, loopbackPeer: loopback })) {
		return { ok: false, status: 403, error: "CSRF rejected" };
	}
	return { ok: true, status: 401, error: "" };
}

/** Binding a non-loopback host without a token and without Tailscale auth is a startup error. */
export function assertFleetBindSafe(host: string, auth: FleetAuthConfig): void {
	if (isLoopbackHostBind(host)) return;
	if (auth.token || auth.tailscaleAuth) return;
	throw new Error(
		`omp-fleet: binding ${host} requires --token / OMP_FLEET_TOKEN or --tailscale-auth`,
	);
}
