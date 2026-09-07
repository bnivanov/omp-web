/* omp-web service worker: push alerts + notificationclick → dialog. */
self.addEventListener("install", (event) => {
	event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
	let data = { title: "omp-web", body: "", daemonId: "", epochToken: "" };
	try {
		if (event.data) data = { ...data, ...event.data.json() };
	} catch {
		if (event.data) data.body = event.data.text();
	}
	event.waitUntil(
		self.registration.showNotification(data.title || "omp-web", {
			body: data.body || "",
			data: { daemonId: data.daemonId, epochToken: data.epochToken },
			tag: data.epochToken || data.daemonId || "omp-web",
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const data = event.notification.data || {};
	const params = new URLSearchParams();
	if (data.daemonId) params.set("daemon", data.daemonId);
	if (data.epochToken) params.set("dialog", data.epochToken);
	const target = params.toString() ? `/?${params}` : "/";
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
			for (const client of clients) {
				if ("focus" in client) {
					client.postMessage({
						type: "omp-notify-open",
						daemonId: data.daemonId,
						epochToken: data.epochToken,
					});
					return client.focus();
				}
			}
			if (self.clients.openWindow) return self.clients.openWindow(target);
		}),
	);
});
