/**
 * Web Push (RFC 8291 + VAPID RFC 8292) over Web Crypto. No extra dependency.
 * Subscriptions live in memory; the PWA resubscribes on load.
 */

import { dialogNotifyBody, redactForNotify } from "./redact";

export interface VapidKeys {
	publicKey: string;
	privateKey: string;
	subject: string;
}

export interface PushSubscriptionJSON {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export interface PushPayload {
	title: string;
	body: string;
	daemonId?: string;
	epochToken?: string;
	kind: "dialog" | "turn_end";
}

const encoder = new TextEncoder();

export class WebPushDispatcher {
	readonly #vapid: VapidKeys;
	readonly #subs = new Map<string, PushSubscriptionJSON>();
	readonly #fetch: typeof fetch;

	constructor(vapid: VapidKeys, fetchImpl: typeof fetch = fetch) {
		this.#vapid = vapid;
		this.#fetch = fetchImpl;
	}

	publicKey(): string {
		return this.#vapid.publicKey;
	}

	subscribe(sub: PushSubscriptionJSON): void {
		this.#subs.set(sub.endpoint, sub);
	}

	unsubscribe(endpoint: string): void {
		this.#subs.delete(endpoint);
	}

	subscriptions(): PushSubscriptionJSON[] {
		return [...this.#subs.values()];
	}

	async notifyDialog(input: {
		daemonId: string;
		name: string;
		method: string;
		params: unknown;
		epochToken: string;
	}): Promise<void> {
		await this.broadcast({
			kind: "dialog",
			title: redactForNotify(`${input.name} needs you`),
			body: dialogNotifyBody(input.method, input.params),
			daemonId: input.daemonId,
			epochToken: input.epochToken,
		});
	}

	async notifyTurnEnd(input: { daemonId: string; name: string; preview: string }): Promise<void> {
		await this.broadcast({
			kind: "turn_end",
			title: redactForNotify(`${input.name} finished`),
			body: redactForNotify(input.preview),
			daemonId: input.daemonId,
		});
	}

	async broadcast(payload: PushPayload): Promise<void> {
		const body = JSON.stringify(payload);
		const dead: string[] = [];
		for (const sub of this.#subs.values()) {
			try {
				const status = await this.#sendOne(sub, body);
				if (status === 404 || status === 410) dead.push(sub.endpoint);
			} catch {
				// Per-sub failure must not stall the rest of the outbox.
			}
		}
		for (const endpoint of dead) this.#subs.delete(endpoint);
	}

	async #sendOne(sub: PushSubscriptionJSON, plaintext: string): Promise<number> {
		const endpoint = new URL(sub.endpoint);
		const audience = endpoint.origin;
		const jwt = await signVapidJwt({
			audience,
			subject: this.#vapid.subject,
			privateKey: this.#vapid.privateKey,
		});
		const encrypted = await encryptPayload(plaintext, sub.keys.p256dh, sub.keys.auth);
		const res = await this.#fetch(sub.endpoint, {
			method: "POST",
			headers: {
				authorization: `vapid t=${jwt}, k=${this.#vapid.publicKey}`,
				ttl: "60",
				"content-type": "application/octet-stream",
				"content-encoding": "aes128gcm",
			},
			body: asBuf(encrypted),
		});
		return res.status;
	}
}

export function parseSubscription(body: Record<string, unknown>): PushSubscriptionJSON | null {
	const endpoint = body.endpoint;
	if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) return null;
	if (typeof body.keys !== "object" || body.keys === null) return null;
	const keys = body.keys as Record<string, unknown>;
	if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return null;
	if (keys.p256dh.length === 0 || keys.auth.length === 0) return null;
	return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

async function signVapidJwt(opts: {
	audience: string;
	subject: string;
	privateKey: string;
}): Promise<string> {
	const header = b64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const now = Math.floor(Date.now() / 1000);
	const payload = b64url(
		encoder.encode(
			JSON.stringify({
				aud: opts.audience,
				exp: now + 12 * 60 * 60,
				sub: opts.subject,
			}),
		),
	);
	const unsigned = `${header}.${payload}`;
	const key = await crypto.subtle.importKey(
		"pkcs8",
		asBuf(b64urlToBytes(opts.privateKey)),
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		encoder.encode(unsigned),
	);
	return `${unsigned}.${b64url(ieeeP1363ToDer(new Uint8Array(sig)))}`;
}

/** Web Push JWTs want raw r||s; some stacks accept DER. Use raw P1363 (64 bytes). */
function ieeeP1363ToDer(sig: Uint8Array): Uint8Array {
	// ES256 produce is already r||s (P-1363). JWT wants that raw form.
	return sig;
}

async function encryptPayload(
	plaintext: string,
	p256dh: string,
	auth: string,
): Promise<Uint8Array> {
	const userPublic = await crypto.subtle.importKey(
		"raw",
		asBuf(b64urlToBytes(p256dh)),
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
		"deriveBits",
	]);
	const localPub = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
	const bits = await crypto.subtle.deriveBits(
		{ name: "ECDH", public: userPublic },
		local.privateKey,
		256,
	);
	const authSecret = b64urlToBytes(auth);
	const ikm = await hkdf(
		new Uint8Array(bits),
		authSecret,
		concat(encoder.encode("WebPush: info\0"), await exportUncompressed(userPublic), localPub),
		32,
	);
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(ikm, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(ikm, salt, encoder.encode("Content-Encoding: nonce\0"), 12);
	const padded = concat(encoder.encode(plaintext), new Uint8Array([2]));
	const aesKey = await crypto.subtle.importKey("raw", asBuf(cek), "AES-GCM", false, ["encrypt"]);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: asBuf(nonce) }, aesKey, asBuf(padded)),
	);
	// aes128gcm header: salt(16) + rs(4) + idlen(1) + keyid(localPub 65)
	const header = new Uint8Array(16 + 4 + 1 + localPub.length);
	header.set(salt, 0);
	header[16] = 0;
	header[17] = 0;
	header[18] = 16;
	header[19] = 0; // record size 4096
	header[20] = localPub.length;
	header.set(localPub, 21);
	return concat(header, ciphertext);
}

async function exportUncompressed(key: CryptoKey): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

async function hkdf(
	ikm: Uint8Array,
	salt: Uint8Array,
	info: Uint8Array,
	length: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const base = await crypto.subtle.importKey("raw", asBuf(ikm), "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt: asBuf(salt), info: asBuf(info) },
		base,
		length * 8,
	);
	return new Uint8Array(bits);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

function asBuf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(bytes.byteLength);
	out.set(bytes);
	return out;
}

function b64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(raw: string): Uint8Array<ArrayBuffer> {
	const pad = raw.length % 4 === 0 ? "" : "=".repeat(4 - (raw.length % 4));
	const b64 = raw.replace(/-/g, "+").replace(/_/g, "/") + pad;
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
