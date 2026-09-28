"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileText } from "lucide-react";

interface MarkdownViewerProps {
  content: string;
  className?: string;
  title?: string;
}

export default function MarkdownViewer({
  content,
  className,
  title,
}: MarkdownViewerProps) {
  return (
    <div
      className={
        className ??
        "rounded-lg border border-cbv2-border bg-cbv2-sidebar overflow-hidden"
      }
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-cbv2-border bg-gradient-to-r from-cbv2-sidebar to-cbv2-bg">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-blue-500/15 flex items-center justify-center">
            <FileText className="w-3.5 h-3.5 text-blue-400" />
          </div>
          <span className="text-[11px] font-semibold text-cbv2-text">
            {title || "Markdown Preview"}
          </span>
        </div>
      </div>

      {/* Markdown content */}
      <div className="overflow-auto cbv2-scrollbar p-6" style={{ minHeight: 300 }}>
        <div className="lm-prose max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
