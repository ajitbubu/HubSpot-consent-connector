/**
 * HubSpot HTTP client — spec §7 production requirements.
 * Every vendor call in the codebase goes through this module: token refresh on 401,
 * 429/Retry-After handling, exponential backoff with jitter, and redacted errors.
 */

import type { AccessTokenProvider } from "../auth/token-service.js";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export class HubSpotApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryable: boolean,
    detail: string,
  ) {
    // Never include request headers or bodies (tokens, emails) in the message.
    super(`HubSpot API error ${status}: ${detail}`);
    this.name = "HubSpotApiError";
  }
}

export interface HubSpotClientOptions {
  baseUrl?: string;
  maxRetries?: number;
  /** Injectable for tests; defaults to real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source; defaults to Math.random. */
  jitter?: () => number;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class HubSpotClient {
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;

  constructor(
    private readonly fetchFn: FetchLike,
    private readonly tokens: AccessTokenProvider,
    options: HubSpotClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? "https://api.hubapi.com";
    this.maxRetries = options.maxRetries ?? 4;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.jitter = options.jitter ?? Math.random;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let token = await this.tokens.getToken();
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      if (response.status >= 200 && response.status < 300) {
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      // §13: expired token — refresh once, then fail closed.
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        token = await this.tokens.refresh();
        continue;
      }

      const retryable = RETRYABLE_STATUSES.has(response.status);
      if (retryable && attempt < this.maxRetries) {
        const retryAfterHeader = response.headers.get("Retry-After");
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
        const backoffMs = Number.isFinite(retryAfterMs)
          ? retryAfterMs
          : Math.min(30_000, 500 * 2 ** attempt) * (0.5 + this.jitter() / 2);
        await this.sleep(backoffMs);
        continue;
      }

      // Include a short, email-redacted excerpt of the response body — HubSpot's
      // error category/message is essential for classifying rejections.
      const bodyExcerpt = redactPath(await response.text()).slice(0, 300);
      throw new HubSpotApiError(
        response.status,
        retryable,
        `${method} ${redactPath(path)} → ${bodyExcerpt}`,
      );
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }
}

/** §14: never log raw email addresses — redact path segments that contain one. */
export function redactPath(path: string): string {
  return path.replace(/[^/?&=]+@[^/?&=]+/g, "<redacted-email>");
}
