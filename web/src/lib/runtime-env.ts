import "server-only";

/**
 * Runtime config resolver — runs on the server for every request.
 *
 * Reads `API_BASE_URL` at request time (not build time), so Docker /
 * PM2 / systemd env-var changes take effect on the next request without
 * rebuilding the Next.js bundle.
 */
export interface RuntimeEnv {
  API_BASE_URL: string;
}

export function getRuntimeEnv(): RuntimeEnv {
  const raw = process.env.API_BASE_URL?.trim();
  return {
    API_BASE_URL: (raw && raw.length > 0 ? raw : "http://localhost:8080").replace(/\/+$/, ""),
  };
}
