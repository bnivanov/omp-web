/**
 * Default truncation + light redaction for outbound alerts.
 * Prompt text and dialog copy must not leak tokens or over-long bodies.
 */

const DEFAULT_MAX = 200;
const SECRET_RE = /\b(?:sk-|ghp_|gho_|xox[baprs]-|Bearer\s+)[A-Za-z0-9._\-\/=+]{8,}\b/gi;

export function redactForNotify(text: string, max = DEFAULT_MAX): string {
	const stripped = text.replace(SECRET_RE, "[redacted]").replace(/\s+/g, " ").trim();
	if (stripped.length <= max) return stripped;
	return `${stripped.slice(0, Math.max(0, max - 1))}…`;
}

export function dialogNotifyBody(method: string, params: unknown): string {
	if (typeof params !== "object" || params === null) return redactForNotify(method);
	const rec = params as Record<string, unknown>;
	const title = typeof rec.title === "string" ? rec.title : method;
	const message = typeof rec.message === "string" ? rec.message : "";
	const joined = message.length > 0 ? `${title}: ${message}` : title;
	return redactForNotify(joined);
}
