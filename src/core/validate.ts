/** The longest delay a Node.js timer holds (2^31 - 1 ms); a longer one fires after 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

/** `value` as a finite number in [min, max]; a RangeError naming `name` otherwise (NaN and Infinity included). */
export function numberInRange(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a finite number from ${min} to ${max} (got ${String(value)})`);
  }
  return value;
}

/** `value` as an integer in [min, max]; a RangeError naming `name` otherwise. */
export function intInRange(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a whole number from ${min} to ${max} (got ${String(value)})`);
  }
  return value;
}

/** True for a loopback host name: localhost, 127.x.x.x or [::1]. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Checks a URL the SDK sends requests to (the API base URL, the JWKS URL) and answers it without trailing slashes:
 * absolute, https (http only for a loopback host, or with `allowInsecureHttp`), no credentials, no query or fragment.
 */
export function checkServiceUrl(value: unknown, name: string, allowInsecureHttp: boolean): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a URL string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} must be an absolute https URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError(`${name} must be an absolute https URL`);
  if (url.username || url.password) throw new TypeError(`${name} must not hold a user name or password`);
  if (url.search || url.hash) throw new TypeError(`${name} must not have a query or a fragment`);
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname) && !allowInsecureHttp) {
    throw new TypeError(
      `${name} must use https: plain http is allowed only for loopback hosts (localhost, 127.0.0.1, [::1]), or with ` +
        "{ dangerouslyAllowInsecureHttp: true } for a development server you trust"
    );
  }
  return value.replace(/\/+$/, "");
}
