"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

/**
 * Renders assistant markdown output (headings, tables, lists, code, links,
 * blockquotes, GFM extensions). User messages stay as plain text — this
 * component is only used for the assistant side.
 *
 * Link resolution: relative `/api/agent/...` hrefs (artifact / attachment
 * downloads) are rewritten to the backend base URL so they open the file
 * on port 8000/8080 instead of hitting the UI dev-server 404.
 */
export function MarkdownContent({ content }: { content: string }) {
  const components: Components = {
    h1: (p) => (
      <h1
        className="mt-4 border-b border-bell-border pb-1 text-xl font-semibold tracking-tight text-bell-ink first:mt-0"
        {...p}
      />
    ),
    h2: (p) => (
      <h2
        className="mt-4 text-lg font-semibold tracking-tight text-bell-ink first:mt-0"
        {...p}
      />
    ),
    h3: (p) => (
      <h3
        className="mt-3 text-base font-semibold text-bell-ink first:mt-0"
        {...p}
      />
    ),
    h4: (p) => (
      <h4
        className="mt-3 text-sm font-semibold uppercase tracking-wide text-bell-slate first:mt-0"
        {...p}
      />
    ),
    p: (p) => <p className="my-0" {...p} />,
    strong: (p) => <strong className="font-semibold text-bell-ink" {...p} />,
    em: (p) => <em className="italic" {...p} />,
    ul: (p) => (
      <ul className="ml-1 list-disc space-y-1 pl-5 marker:text-bell-blue" {...p} />
    ),
    ol: (p) => (
      <ol
        className="ml-1 list-decimal space-y-1 pl-5 marker:font-semibold marker:text-bell-blue"
        {...p}
      />
    ),
    li: (p) => <li className="leading-snug" {...p} />,
    hr: () => <hr className="my-3 border-t border-bell-border" />,
    blockquote: (p) => (
      <blockquote
        className="border-l-4 border-bell-blue-soft pl-3 italic text-bell-slate"
        {...p}
      />
    ),
    a: ({ href, children, ...rest }) => (
      <a
        href={resolveHref(href ?? "")}
        target="_blank"
        rel="noopener noreferrer"
        className="text-bell-blue underline underline-offset-2 hover:text-bell-blue-dark"
        {...rest}
      >
        {children}
      </a>
    ),
    // react-markdown v9: use `code` to detect inline vs block via className.
    code: ({ className, children, ...rest }) => {
      const isBlock = !!className && className.startsWith("language-");
      if (isBlock) {
        return (
          <code
            className={`block whitespace-pre font-mono text-[13px] leading-relaxed ${className ?? ""}`}
            {...rest}
          >
            {children}
          </code>
        );
      }
      return (
        <code
          className="rounded bg-bell-chrome px-1 py-0.5 font-mono text-[13px] text-bell-ink"
          {...rest}
        >
          {children}
        </code>
      );
    },
    pre: ({ children, ...rest }) => (
      <pre
        className="my-0 overflow-x-auto rounded-[var(--radius-bell)] border border-bell-border bg-bell-chrome p-3"
        {...rest}
      >
        {children}
      </pre>
    ),
    table: (p) => (
      <div className="overflow-x-auto rounded-[var(--radius-bell)] border border-bell-border">
        <table className="w-full border-collapse text-sm" {...p} />
      </div>
    ),
    thead: (p) => <thead className="bg-bell-blue-soft text-bell-blue" {...p} />,
    th: (p) => (
      <th
        className="border-b border-bell-border px-3 py-2 text-left align-top text-xs font-semibold uppercase tracking-wide"
        {...p}
      />
    ),
    td: (p) => (
      <td
        className="border-b border-bell-border px-3 py-2 align-top text-bell-ink"
        {...p}
      />
    ),
    tr: (p) => <tr className="even:bg-bell-chrome/60" {...p} />,
  };

  return (
    <div className="flex flex-col gap-3 text-[15px] leading-relaxed text-bell-ink">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function resolveHref(href: string): string {
  if (!href) return href;
  if (
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:") ||
    href.startsWith("#")
  ) {
    return href;
  }
  if (href.startsWith("/api/agent/")) {
    const base = resolveBackendBase();
    if (base) return `${base}${href}`;
  }
  return href;
}

function resolveBackendBase(): string {
  if (typeof window === "undefined") return "";
  const runtime = window.__ENV__?.API_BASE_URL?.trim();
  return (runtime || "").replace(/\/+$/, "");
}
