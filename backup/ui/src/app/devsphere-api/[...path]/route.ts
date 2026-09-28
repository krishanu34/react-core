import { NextRequest, NextResponse } from "next/server";

const baseUrl = () => {
  const raw =
    process.env.WORKSPACE_STUDIO_API_URL ??
    process.env.NEXT_PUBLIC_DEVSPHERE_API_URL ??
    "http://127.0.0.1:8003";
  return raw.replace("://localhost", "://127.0.0.1").replace(/\/+$/, "").replace(/\/api$/, "");
};

// Statuses that MUST NOT carry a body. The Response constructor rejects even a
// zero-length buffer for these ("Invalid response status code"), and because
// that throw happened inside the proxy's try block it reached users as a
// generic "proxy failed" 502 — with the real cause nowhere in sight. Every
// 204-returning endpoint (all the admin deletes, add-team-member) was
// unreachable through the proxy because of it.
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

const HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "transfer-encoding",
  "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate",
]);

function sanitizeHeaders(request: NextRequest): Headers {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    if (value === undefined || value === "undefined") return;
    headers.set(key, value);
  });
  const xff = request.headers.get("x-forwarded-for");
  if (xff && xff !== "undefined") headers.set("x-forwarded-for", xff);
  return headers;
}

async function proxyDevsphereRequest(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await context.params;
    const target = new URL(`/api/${path.join("/")}`, baseUrl());
    target.search = request.nextUrl.search;

    const headers = sanitizeHeaders(request);

    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "manual",
    };

    if (!["GET", "HEAD"].includes(request.method)) {
      const contentType = request.headers.get("content-type") ?? "";
      if (contentType.includes("multipart/form-data")) {
        init.body = await request.arrayBuffer();
        headers.set("content-type", contentType);
      } else {
        init.body = await request.arrayBuffer();
      }
    }

    const response = await fetch(target, init);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("transfer-encoding");

    const isSSE =
      response.headers.get("content-type")?.includes("text/event-stream") ??
      false;

    if (isSSE && response.body) {
      responseHeaders.set("content-type", "text/event-stream");
      responseHeaders.set("cache-control", "no-cache, no-transform");
      responseHeaders.set("x-accel-buffering", "no");
      return new NextResponse(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    }

    if (NULL_BODY_STATUS.has(response.status)) {
      return new NextResponse(null, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    return new NextResponse(await response.arrayBuffer(), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    return NextResponse.json(
      {
        detail: "DevSphere AI proxy failed",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}

export const GET = proxyDevsphereRequest;
export const POST = proxyDevsphereRequest;
export const PUT = proxyDevsphereRequest;
export const PATCH = proxyDevsphereRequest;
export const DELETE = proxyDevsphereRequest;
