"use client";

import { useState, useEffect, useRef } from "react";
import {
  Terminal,
  X,
  Maximize2,
  Minimize2,
  Circle,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { useStore } from "@/store/useCodeBuilderStore";

/* ── Simulated terminal output lines ──────────────────── */
interface TerminalLine {
  text: string;
  type: "command" | "output" | "success" | "error" | "info" | "separator";
  timestamp?: string;
}

/* Map pipeline step names to simulated terminal commands */
const STEP_COMMANDS: Record<string, string[]> = {
  "Input Processing": [
    "$ Initializing pipeline context...",
    "  Loading project configuration",
    "  Validating request parameters",
  ],
  "Codebase Scan": [
    "$ find . -type f | head -100",
    "$ wc -l $(find . -type f -name '*.py' -o -name '*.ts' -o -name '*.js')",
    "  Scanning file inventory...",
    "  Building file hash index",
  ],
  "AST Analysis": [
    "$ python -m ast --parse *.py",
    "  Parsing Abstract Syntax Trees...",
    "  Extracting class/function definitions",
    "  Building symbol table",
  ],
  "Dependency Mapping": [
    "$ pip list --format=json | python -m json.tool",
    "$ cat package.json | jq '.dependencies'",
    "  Mapping import graph...",
    "  Detecting circular dependencies",
  ],
  "Tech Stack Detection": [
    "$ detect-tech-stack --format json .",
    "  Fingerprinting frameworks...",
    "  Identifying runtime versions",
  ],
  "Impact Analysis": [
    "$ git diff --stat HEAD~1",
    "  Analyzing change impact radius...",
    "  Computing affected module graph",
    "  Estimating risk score",
  ],
  "Code Modification": [
    "$ apply-changes --dry-run impact_analysis.json",
    "  Applying modifications to source files...",
    "  Writing change log",
  ],
  "Code Generation": [
    "$ scaffold --template project-structure",
    "  Generating source files...",
    "  Writing package manifests",
    "  Creating configuration files",
  ],
  "Security Scan": [
    "$ bandit -r . -f json",
    "$ npm audit --json",
    "  Scanning for vulnerabilities...",
    "  Checking dependency licenses",
    "  Generating security report",
  ],
  "CI Pipeline": [
    "$ docker build -t app:latest .",
    "$ npm run lint",
    "$ npm run test -- --coverage",
    "$ pytest --cov=app tests/",
    "  Running CI checks...",
  ],
  "Deploy Simulation": [
    "$ kubectl apply --dry-run=client -f k8s/",
    "$ terraform plan",
    "  Simulating deployment...",
    "  Validating infrastructure config",
  ],
  "Test Generation": [
    "$ generate-tests --framework jest src/",
    "  Creating test suites...",
    "  Writing test fixtures",
    "  Generating coverage plan",
  ],
  "Code Review": [
    "$ review --checklist quality,security,style",
    "  Reviewing all modifications...",
    "  Checking code quality metrics",
    "  Generating review summary",
  ],
  "Source Analysis": [
    "$ analyze-source --deep .",
    "  Parsing source codebase...",
    "  Extracting API contracts",
    "  Mapping data models",
  ],
  "Target Specification": [
    "$ generate-target-spec --from source_analysis.json",
    "  Defining target architecture...",
    "  Planning file structure",
  ],
  "Code Transformation": [
    "$ transform --rules mapping_rules.json src/ migrated/",
    "  Transforming source files...",
    "  Applying syntax conversions",
    "  Migrating imports and types",
  ],
  "Validation": [
    "$ validate-migration --source src/ --target migrated/",
    "  Verifying completeness...",
    "  Checking API compatibility",
    "  Running validation tests",
  ],
};

export default function TerminalView() {
  const { currentRun } = useStore();
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevStepsRef = useRef<string>("");

  /* Watch pipeline steps and add terminal lines */
  useEffect(() => {
    if (!currentRun?.steps) return;

    const stepsKey = currentRun.steps.map(s => `${s.name}:${s.status}`).join(",");
    if (stepsKey === prevStepsRef.current) return;
    prevStepsRef.current = stepsKey;

    const newLines: TerminalLine[] = [];

    currentRun.steps.forEach((step) => {
      if (step.status === "running" || step.status === "completed" || step.status === "failed") {
        const cmds = STEP_COMMANDS[step.name] || [`$ Running ${step.name}...`];

        newLines.push({
          text: `─── ${step.name} ───`,
          type: "separator",
          timestamp: step.started_at,
        });

        cmds.forEach((cmd) => {
          newLines.push({
            text: cmd,
            type: cmd.startsWith("$") ? "command" : "output",
          });
        });

        if (step.status === "completed") {
          newLines.push({
            text: `  ✓ ${step.name} completed${step.duration_ms ? ` (${step.duration_ms}ms)` : ""}`,
            type: "success",
          });
        } else if (step.status === "failed") {
          newLines.push({
            text: `  ✗ ${step.name} failed${step.error ? `: ${step.error}` : ""}`,
            type: "error",
          });
        } else {
          newLines.push({
            text: `  ⟳ ${step.name} running...`,
            type: "info",
          });
        }
      }
    });

    setLines(newLines);
  }, [currentRun?.steps]);

  /* Auto-scroll to bottom */
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  if (!currentRun || lines.length === 0) return null;

  const lineColor = (type: TerminalLine["type"]) => {
    switch (type) {
      case "command":   return "text-cyan-300";
      case "output":    return "text-gray-400";
      case "success":   return "text-emerald-400";
      case "error":     return "text-red-400";
      case "info":      return "text-blue-300";
      case "separator": return "text-gray-600";
    }
  };

  return (
    <div className={`border-t border-editor-border bg-[#0d1117] transition-all ${
      isExpanded ? "h-[300px]" : "h-[140px]"
    }`}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1 border-b border-editor-border bg-editor-sidebar">
        <Terminal size={12} className="text-editor-accent" />
        <span className="text-[11px] text-gray-300 font-medium">Pipeline Terminal</span>

        {/* Traffic lights */}
        <div className="flex items-center gap-1 ml-2">
          <Circle size={7} className="text-red-500 fill-red-500" />
          <Circle size={7} className="text-yellow-500 fill-yellow-500" />
          <Circle size={7} className="text-green-500 fill-green-500" />
        </div>

        <div className="flex-1" />

        {currentRun.status === "running" && (
          <Loader2 size={11} className="text-editor-accent animate-spin" />
        )}

        <button
          onClick={() => setAutoScroll(!autoScroll)}
          className={`text-[10px] px-1.5 py-0.5 rounded ${
            autoScroll ? "bg-editor-accent/20 text-editor-accent" : "text-gray-500 hover:text-gray-300"
          }`}
          title="Auto-scroll"
        >
          <ChevronDown size={10} />
        </button>

        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-gray-500 hover:text-gray-300"
        >
          {isExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
      </div>

      {/* Terminal content */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-2 font-mono text-[11px] leading-[1.6]"
        style={{ height: isExpanded ? "264px" : "104px" }}
      >
        {lines.map((line, i) => (
          <div key={i} className={`${lineColor(line.type)} ${
            line.type === "separator" ? "mt-1 mb-0.5 opacity-50" : ""
          }`}>
            {line.type === "command" ? (
              <span>
                <span className="text-emerald-400">$</span>
                <span className="text-cyan-300">{line.text.slice(1)}</span>
              </span>
            ) : (
              line.text
            )}
          </div>
        ))}

        {/* Blinking cursor */}
        {currentRun.status === "running" && (
          <div className="text-emerald-400 animate-pulse">▋</div>
        )}
      </div>
    </div>
  );
}
