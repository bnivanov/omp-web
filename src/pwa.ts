/**
 * PWA bootstrap: register the service worker, subscribe Web Push when
 * desktop notifications are enabled, and honor ?daemon= / ?dialog= deep links.
 */

import { attachSession } from "./store/transport";
import { setNotifyEnabled } from "./store/chat";
import { state } from "./state";

const VAPID_PATH = "/ctl/push/vapid";
const SUBSCRIBE_PATH = "/ctl/push/subscribe";

export function startPwa(): void {
	if (typeof window === "undefined") return;
	const params = new URLSearchParams(window.location.search);
	const daemon = params.get("daemon");
	if (daemon) void waitAndAttach(daemon);
	if ("serviceWorker" in navigator) {
		void navigator.serviceWorker.register("/sw.js").catch(() => {
			// Offline or file:// — the app still works without a SW.
		});
		navigator.serviceWorker.addEventListener("message", (ev: MessageEvent) => {
			const data = ev.data;
			if (!data || data.type !== "omp-notify-open") return;
			if (typeof data.daemonId === "string" && data.daemonId.length > 0) {
				void attachSession(data.daemonId).catch(() => {});
			}
		});
	}
	if (state.notifyEnabled) void subscribePush();
}

export async function enablePushNotifications(): Promise<void> {
	setNotifyEnabled(true);
	await subscribePush();
}

async function subscribePush(): Promise<void> {
	if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
	if (typeof Notification !== "undefined" && Notification.permission === "denied") return;
	try {
		const vapid = await fetch(VAPID_PATH);
		if (!vapid.ok) return;
		const body = (await vapid.json()) as { publicKey?: string };
		if (typeof body.publicKey !== "string") return;
		const reg = await navigator.serviceWorker.ready;
		const existing = await reg.pushManager.getSubscription();
		const sub =
			existing ??
			(await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(body.publicKey),
			}));
		const json = sub.toJSON();
		if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return;
		await fetch(SUBSCRIBE_PATH, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				endpoint: json.endpoint,
				keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
			}),
		});
	} catch {
		// Push is optional; a missing VAPID config is the common case.
	}
}
async function waitAndAttach(daemonId: string): Promise<void> {
	for (let i = 0; i < 80; i++) {
		if (state.sessionMode === "roster" && state.daemonRoster.some((d) => d.daemonId === daemonId)) {
			await attachSession(daemonId).catch(() => {});
			return;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 100);
		await promise;
	}
}

function urlBase64ToUint8Array(base64: string): BufferSource {
	const pad = "=".repeat((4 - (base64.length % 4)) % 4);
	const raw = atob(base64.replace(/-/g, "+").replace(/_/g, "/") + pad);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}
