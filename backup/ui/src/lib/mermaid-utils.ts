function splitCompoundMermaidLines(code: string): string {
  const lines = code.split("\n");
  const fixedLines: string[] = [];

  for (const line of lines) {
    let updatedLine = line;
    while (true) {
      const splitLine = updatedLine.replace(
        /(\]\)|\]|\}\)|\}|\)\])\s+([A-Za-z][A-Za-z0-9_]*\s*[\[(\{])/, 
        "$1\n$2"
      );
      if (splitLine === updatedLine) {
        break;
      }
      updatedLine = splitLine;
    }
    fixedLines.push(...updatedLine.split("\n"));
  }

  return fixedLines.join("\n").trim();
}

export function sanitizeMermaidCode(code: string): string {
  let cleaned = code.trim();
  cleaned = cleaned.replace(/^```(?:mermaid)?\s*/i, "");
  cleaned = cleaned.replace(/\s*```$/i, "");
  cleaned = cleaned.replace(/^\[MERMAID\]\s*/i, "");
  if (/^mermaid\n/i.test(cleaned)) {
    cleaned = cleaned.replace(/^mermaid\n/i, "");
  }
  cleaned = cleaned.replace(/\r\n?/g, "\n");
  cleaned = cleaned.replace(/[ \t]+\n/g, "\n");
  cleaned = splitCompoundMermaidLines(cleaned);
  return cleaned.trim();
}