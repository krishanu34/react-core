"use client";

import { useQuery } from "@tanstack/react-query";
import queryKeys from "@/lib/query-keys";
import { authFetch } from "@/lib/auth";
import { getLegacyModernizationApiRoot } from "@/lib/legacy-modernization-url";
import type {
  LegacyModernizationProject,
  LegacyModernizationProjectListResponse,
  LegacyModernizationCodeContextStatus,
  LegacyModernizationSuggestions,
} from "@/types/legacy-modernization";

const API_BASE = "/lm-api";

const TARGET_STACK_LABEL_MAP: Record<string, string> = {
  "node.fastify": "Modernize to a Node.js backend with Fastify for lightweight, high-speed APIs.",
  "typescript.nestjs": "Modernize to a TypeScript backend with NestJS for modular, enterprise-ready services.",
  "typescript.nextjs": "Modernize to a TypeScript application with Next.js for a modern full-stack web experience.",
  "python.fastapi": "Modernize to a Python backend with FastAPI for clean, high-performance API development.",
  "react.nextjs": "Modernize to a React application with Next.js for a scalable, server-rendered frontend.",
  "go.gin": "Modernize to a Go backend with Gin for efficient, high-throughput services.",
  "java.springboot": "Modernize to a Java backend with Spring Boot for robust, maintainable enterprise APIs.",
  "dotnet.webapi": "Modernize to a .NET Web API architecture for secure, maintainable service modernization.",
};

const TARGET_STACK_TOKEN_MAP: Record<string, string> = {
  angular: "Angular",
  aspnetcore: "ASP.NET Core",
  dotnet: ".NET",
  express: "Express",
  fastapi: "FastAPI",
  fastify: "Fastify",
  gin: "Gin",
  go: "Go",
  golang: "Go",
  graphql: "GraphQL",
  grpc: "gRPC",
  java: "Java",
  nestjs: "NestJS",
  nextjs: "Next.js",
  node: "Node.js",
  nodejs: "Node.js",
  postgres: "PostgreSQL",
  postgresql: "PostgreSQL",
  python: "Python",
  react: "React",
  spring: "Spring",
  springboot: "Spring Boot",
  typescript: "TypeScript",
  vue: "Vue.js",
  vuejs: "Vue.js",
  webapi: "Web API",
};

function normalizeTargetStackSuggestion(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";

  const exact = TARGET_STACK_LABEL_MAP[text.toLowerCase()];
  if (exact) return exact;
  if (text.includes(" ")) {
    if (/[.!?]$/.test(text) || /^(modernize to|move to|adopt|use)\s/i.test(text)) return text;
    return `Modernize to ${text}.`;
  }
  if (text.length > 80) return text;

  const parts = text.toLowerCase().split(/[._/\-]+/).filter(Boolean);
  if (!parts.length) return text;

  const labels = parts.map((part) =>
    TARGET_STACK_TOKEN_MAP[part] ?? (part.length <= 4 ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
  );

  if (labels.length === 1) return `Modernize to ${labels[0]}.`;
  if (labels.length === 2) return `Modernize to ${labels[0]} with ${labels[1]}.`;
  return `Modernize to ${labels[0]} with ${labels.slice(1).join(" ")}.`;
}

function normalizeTargetStackSuggestions(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const label = normalizeTargetStackSuggestion(value);
    const key = label.toLocaleLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    normalized.push(label);
  }
  return normalized;
}

async function fetchFromLegacyModernizationApi(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  let lastError: Error | null = null;
  const candidates = [`${getLegacyModernizationApiRoot()}/api${path}`, `${API_BASE}${path}`];

  for (const url of candidates) {
    try {
      const response = await authFetch(url, init);
      if (response.status !== 404 || url === candidates[candidates.length - 1]) {
        return response;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Request failed");
    }
  }

  throw lastError ?? new Error("Request failed");
}

// ═══════════════════════════════════════════════════════════════════════════
//  QUERY HOOKS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch legacy modernization projects.
 */
export function useLegacyModProjects() {
  return useQuery<LegacyModernizationProject[]>({
    queryKey: queryKeys.legacyMod.projects(),
    queryFn: async () => {
      const res = await fetchFromLegacyModernizationApi("/legacy-modernization/projects");
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(
          String((payload as { error?: unknown }).error ?? res.statusText ?? "Failed to load projects"),
        );
      }
      const payload = (await res.json()) as Partial<LegacyModernizationProjectListResponse>;
      return Array.isArray(payload.projects) ? payload.projects : [];
    },
    staleTime: 30_000,
  });
}

/**
 * Fetch code context status for a legacy modernization project.
 */
export function useLegacyModCodeContext(projectId: number | null) {
  return useQuery<LegacyModernizationCodeContextStatus | null>({
    queryKey: queryKeys.legacyMod.codeContext(projectId ?? 0),
    queryFn: async () => {
      const res = await fetchFromLegacyModernizationApi(
        `/legacy-modernization/projects/${encodeURIComponent(String(projectId))}/code-context`,
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(
          String((payload as { error?: unknown }).error ?? res.statusText ?? "Failed to load code context"),
        );
      }
      const payload = await res.json();
      return {
        stored: Boolean(payload.stored),
        total_files: typeof payload.total_files === "number" ? payload.total_files : undefined,
        total_chunks: typeof payload.total_chunks === "number" ? payload.total_chunks : undefined,
        files: Array.isArray(payload.files) ? payload.files.map(String) : [],
      };
    },
    enabled: projectId != null && projectId > 0,
    staleTime: 30_000,
  });
}

/**
 * Fetch LLM-powered suggestions for target stack and modernization goals.
 */
export function useLegacyModSuggestions(
  projectId: number | null,
  codeContextReady: boolean,
  workspaceRoot?: string | null,
  targetStack?: string | null,
) {
  const trimmedTargetStack = targetStack?.trim() ?? "";

  return useQuery<LegacyModernizationSuggestions | null>({
    queryKey: [...queryKeys.legacyMod.suggestions(projectId ?? 0), workspaceRoot ?? "", trimmedTargetStack],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (workspaceRoot) params.set("workspace_root", workspaceRoot);
      if (trimmedTargetStack) params.set("target_stack", trimmedTargetStack);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const res = await fetchFromLegacyModernizationApi(
        `/legacy-modernization/projects/${encodeURIComponent(String(projectId))}/suggestions${qs}`,
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(
          String((payload as { error?: unknown }).error ?? res.statusText ?? "Failed to load suggestions"),
        );
      }
      const payload = (await res.json()) as LegacyModernizationSuggestions;
      return {
        ...payload,
        target_stack_suggestions: normalizeTargetStackSuggestions(payload.target_stack_suggestions),
      };
    },
    enabled: projectId != null && projectId > 0 && codeContextReady,
    staleTime: 120_000,
    retry: 1,
  });
}
