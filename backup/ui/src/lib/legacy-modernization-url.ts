const LEGACY_MODERNIZATION_PORT = "8002";

function isLoopbackHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function browserHostname() {
  return typeof window !== "undefined" ? window.location.hostname : "";
}

function browserProtocol() {
  return typeof window !== "undefined" ? window.location.protocol : "http:";
}

function resolveConfiguredUrl(configuredUrl: string | undefined, fallbackUrl: string) {
  const raw = (configuredUrl || fallbackUrl).trim();
  const currentHost = browserHostname();

  try {
    const url = new URL(raw, typeof window !== "undefined" ? window.location.origin : fallbackUrl);
    if (currentHost && !isLoopbackHost(currentHost) && isLoopbackHost(url.hostname)) {
      url.hostname = currentHost;
    }
    return url;
  } catch {
    return new URL(fallbackUrl);
  }
}

export function getLegacyModernizationApiRoot() {
  const protocol = browserProtocol();
  const hostname = browserHostname() || "localhost";
  const fallback = `${protocol}//${hostname}:${LEGACY_MODERNIZATION_PORT}`;
  const url = resolveConfiguredUrl(
    process.env.NEXT_PUBLIC_LEGACY_MODERNIZATION_API_URL,
    fallback,
  );
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function getLegacyModernizationApiBase() {
  return `${getLegacyModernizationApiRoot()}/api`;
}

export function getLegacyModernizationSseUrl(path: string) {
  const root = getLegacyModernizationApiRoot();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${root}/api${normalizedPath}`;
}

export function getLegacyModernizationWsUrl(
  path: "/ws/legacy-modernize" | "/ws/legacy-generate",
  configuredUrl?: string,
) {
  const httpProtocol = browserProtocol();
  const wsProtocol = httpProtocol === "https:" ? "wss:" : "ws:";
  const hostname = browserHostname() || "localhost";
  const fallback = `${wsProtocol}//${hostname}:${LEGACY_MODERNIZATION_PORT}${path}`;
  const url = resolveConfiguredUrl(configuredUrl, fallback);

  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (!url.pathname || url.pathname === "/") url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}
