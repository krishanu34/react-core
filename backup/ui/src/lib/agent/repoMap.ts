/**
 * repoMap — client-built repository map (Pattern C, Phase 6).
 *
 * Built in the browser at session start and uploaded with the first request so
 * the model orients without ten list_dir/read calls (Aider's highest-leverage
 * trick). Two parts: a compact file tree + top-level symbols per source file,
 * extracted with lightweight regex (not full tree-sitter — keeps it instant and
 * dependency-free in the browser).
 *
 * The symbol extractor is a pure function so it's unit-testable without the
 * File System Access API.
 */

import { getCachedHandle, scanDirectory, readFsFile } from "@/lib/localFs";
import type { WsNode } from "@/lib/db/workspaceStore";

const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".rb", ".php",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".swift", ".kt", ".scala",
]);

const MAX_FILES_SCANNED = 400;   // cap files we open for symbols
const MAX_FILE_BYTES = 200_000;  // skip huge files
const MAX_SYMBOLS_PER_FILE = 30;
const MAX_MAP_CHARS = 24_000;    // hard cap on the uploaded map

function ext(path: string): string {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i).toLowerCase();
}

/**
 * Extract top-level declarations from a source file. Pure — regex over text.
 * Returns short "kind name" strings (e.g. "function login", "class AuthService").
 */
export function extractSymbols(path: string, content: string): string[] {
  const e = ext(path);
  const out: string[] = [];
  const push = (s: string) => {
    if (out.length < MAX_SYMBOLS_PER_FILE && !out.includes(s)) out.push(s);
  };

  const scan = (re: RegExp, fmt: (m: RegExpExecArray) => string) => {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    while ((m = r.exec(content)) !== null) push(fmt(m));
  };

  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(e)) {
    scan(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/m, (m) => `function ${m[1]}`);
    scan(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/m, (m) => `class ${m[1]}`);
    scan(/^\s*(?:export\s+)?interface\s+([A-Za-z0-9_]+)/m, (m) => `interface ${m[1]}`);
    scan(/^\s*(?:export\s+)?type\s+([A-Za-z0-9_]+)/m, (m) => `type ${m[1]}`);
    scan(/^\s*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/m, (m) => `fn ${m[1]}`);
  } else if (e === ".py") {
    scan(/^\s*def\s+([A-Za-z0-9_]+)/m, (m) => `def ${m[1]}`);
    scan(/^\s*class\s+([A-Za-z0-9_]+)/m, (m) => `class ${m[1]}`);
  } else if (e === ".go") {
    scan(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/m, (m) => `func ${m[1]}`);
    scan(/^\s*type\s+([A-Za-z0-9_]+)/m, (m) => `type ${m[1]}`);
  } else if (e === ".rs") {
    scan(/^\s*(?:pub\s+)?fn\s+([A-Za-z0-9_]+)/m, (m) => `fn ${m[1]}`);
    scan(/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/m, (m) => `type ${m[1]}`);
  } else if ([".java", ".cs", ".kt", ".scala", ".swift"].includes(e)) {
    scan(/^\s*(?:public|private|protected|internal|open|final|abstract|\s)*\s*class\s+([A-Za-z0-9_]+)/m, (m) => `class ${m[1]}`);
    scan(/^\s*(?:public|private|protected|internal|static|func|fun|def|\s)+\s+([A-Za-z0-9_]+)\s*\(/m, (m) => `method ${m[1]}`);
  } else if ([".c", ".cc", ".cpp", ".h", ".hpp"].includes(e)) {
    scan(/^[A-Za-z_][A-Za-z0-9_<>:\s\*&]*\s+([A-Za-z0-9_]+)\s*\([^;]*\)\s*\{/m, (m) => `fn ${m[1]}`);
    scan(/^\s*(?:struct|class|enum)\s+([A-Za-z0-9_]+)/m, (m) => `type ${m[1]}`);
  }
  return out;
}

/** Render a compact indented tree from the flat node list. */
function renderTree(nodes: WsNode[]): string {
  return nodes
    .map((n) => {
      const depth = n.path.split("/").length - 1;
      const name = n.path.split("/").pop() ?? n.path;
      return `${"  ".repeat(depth)}${name}${n.type === "folder" ? "/" : ""}`;
    })
    .join("\n");
}

/**
 * Build the repository map for a workspace. Returns "" if no folder is bound.
 * Safe to call at session start; capped so it never bloats the request.
 */
export async function buildRepoMap(wsId: number): Promise<string> {
  const handle = getCachedHandle(wsId);
  if (!handle) return "";

  let nodes: WsNode[];
  try {
    nodes = await scanDirectory(handle);
  } catch {
    return "";
  }

  const treeText = renderTree(nodes);

  // Symbol section — source files only, budget-capped.
  const sourceFiles = nodes.filter((n) => n.type === "file" && SOURCE_EXT.has(ext(n.path))).slice(0, MAX_FILES_SCANNED);
  const symbolBlocks: string[] = [];
  for (const f of sourceFiles) {
    let content: string;
    try {
      content = await readFsFile(handle, f.path);
    } catch {
      continue;
    }
    if (content.length > MAX_FILE_BYTES) continue;
    const syms = extractSymbols(f.path, content);
    if (syms.length > 0) {
      symbolBlocks.push(`${f.path}:\n  ${syms.join("\n  ")}`);
    }
  }

  let map =
    `## Repository map\n\n### File tree\n${treeText}` +
    (symbolBlocks.length ? `\n\n### Symbols\n${symbolBlocks.join("\n\n")}` : "");

  if (map.length > MAX_MAP_CHARS) {
    map = map.slice(0, MAX_MAP_CHARS) + "\n… (repo map truncated)";
  }
  return map;
}
