import type { Metadata } from "next";
import { getRuntimeEnv } from "@/lib/runtime-env";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bell TAG Engine",
  description:
    "Conversational AI QA agent — turn requirements into scenarios, cases and automation.",
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
  },
};

// Skip Next.js static generation so `API_BASE_URL` is read on every request.
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const env = getRuntimeEnv();
  return (
    <html lang="en">
      <head>
        <script
          // Runtime env for the client — read once, then reused.
          dangerouslySetInnerHTML={{
            __html: `window.__ENV__ = ${JSON.stringify(env)};`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
