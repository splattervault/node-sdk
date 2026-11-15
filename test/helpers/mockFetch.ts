import { type FetchLike } from "../../src/index.js";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The parsed JSON body, or undefined when none was sent. */
  body: unknown;
  rawBody: string | undefined;
  signal: AbortSignal | undefined;
  /** The fetch `redirect` mode the SDK asked for. */
  redirect: string | undefined;
}

export interface Reply {
  status?: number;
  body?: unknown;
  /** Sent as is (not JSON-encoded). */
  text?: string;
  headers?: Record<string, string>;
}

export type Step = Reply | Error | ((req: RecordedRequest, index: number) => Reply | Error | Promise<Reply | Error | Response> | Response);

/**
 * A fetch that records every request and answers from `steps` in order (the last step repeats). A step that is an
 * Error is thrown as a network failure.
 */
export function mockFetch(...steps: Step[]): { fetch: FetchLike; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers as ConstructorParameters<typeof Headers>[0]).forEach((value, key) => {
      headers[key] = value;
    });
    const rawBody = typeof init.body === "string" ? init.body : undefined;
    const req: RecordedRequest = {
      url: input,
      method: init.method ?? "GET",
      headers,
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
      rawBody,
      signal: init.signal ?? undefined,
      redirect: init.redirect
    };
    const index = calls.length;
    calls.push(req);
    if (init.signal?.aborted) throw init.signal.reason;
    const step = steps[Math.min(index, steps.length - 1)];
    if (step === undefined) throw new Error("mockFetch: no steps");
    const out = typeof step === "function" ? await step(req, index) : step;
    if (out instanceof Error) throw out;
    if (out instanceof Response) return out;
    return toResponse(out);
  };
  return { fetch, calls };
}

export function toResponse(reply: Reply): Response {
  const status = reply.status ?? 200;
  const headers = new Headers(reply.headers);
  let body: string | null = null;
  if (reply.text !== undefined) body = reply.text;
  else if (reply.body !== undefined) {
    body = JSON.stringify(reply.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return new Response(status === 204 ? null : body, { status, headers });
}

/** A fetch that never answers until its signal aborts (then throws the abort reason, like the real fetch). */
export function hangingFetch(): { fetch: FetchLike; calls: RecordedRequest[] } {
  return mockFetch(
    (req) =>
      new Promise<Response>((_resolve, reject) => {
        req.signal?.addEventListener("abort", () => reject(req.signal?.reason ?? new Error("aborted")), { once: true });
      })
  );
}

export const BASE = "https://api.test/rest";
export const KEY = "sv_org_test_0123456789abcdef";
