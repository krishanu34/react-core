import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  reactCompiler: true,
  devIndicators: false,
  productionBrowserSourceMaps: false,
  compress: true,
  output: "standalone", // Required for Docker deployment
  turbopack: {
    root: path.resolve(__dirname),
  },
  // DevSphere API routes are handled by app/devsphere-api and app/workspace-api
  // route handlers (server-side proxy to :8003). No next.config rewrites needed
  // for DevSphere's own backend.
  //
  // Code Builder (:8001) and Legacy Modernization (:8002) are proxied for IDE
  // panels that call those services directly.
  async rewrites() {
    return [
      {
        source:      "/cb-api/:path*",
        destination: `${process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL ?? "http://127.0.0.1:8001"}/api/:path*`,
      },
      {
        source:      "/lm-api/:path*",
        destination: `${process.env.NEXT_PUBLIC_LEGACY_MODERNIZATION_API_URL ?? "http://localhost:8002"}/api/:path*`,
      },
      // WebSocket proxy — code builder
      {
        source:      "/ws/cb/:path*",
        destination: `${process.env.NEXT_PUBLIC_CODE_BUILDER_API_URL ?? "http://127.0.0.1:8001"}/ws/:path*`,
      },
      // WebSocket proxy — legacy modernization
      {
        source:      "/ws/lm/:path*",
        destination: `${process.env.NEXT_PUBLIC_LEGACY_MODERNIZATION_API_URL ?? "http://localhost:8002"}/ws/:path*`,
      },
    ];
  },
};

export default nextConfig;
