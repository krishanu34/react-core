import { create } from "zustand";
import type {
  FileNode,
  PipelineMode,
  PipelineRun,
  ChatMessage,
  ProjectInfo,
  EditorTab,
  HitlGate,
  FileDiff,
  ReportFile,
} from "@/types/code-builder";

/* ── Store shape ───────────────────────────────────────── */
interface AppState {
  /* sidebar / file explorer */
  fileTree: FileNode[];
  selectedFile: string | null;
  expandedDirs: Set<string>;
  setFileTree: (tree: FileNode[]) => void;
  selectFile: (path: string | null) => void;
  toggleDir: (path: string) => void;

  /* output file tree (generated code) */
  outputTree: FileNode[];
  setOutputTree: (tree: FileNode[]) => void;
  outputRunId: string | null;
  setOutputRunId: (id: string | null) => void;

  /* editor tabs */
  tabs: EditorTab[];
  activeTab: string | null;
  openTab: (tab: EditorTab) => void;
  closeTab: (path: string) => void;
  setActiveTab: (path: string) => void;
  updateTabContent: (path: string, content: string) => void;
  markTabClean: (path: string) => void;

  /* pipeline */
  pipelineMode: PipelineMode;
  currentRun: PipelineRun | null;
  runHistory: PipelineRun[];
  setPipelineMode: (mode: PipelineMode) => void;
  setCurrentRun: (run: PipelineRun | null) => void;
  updateCurrentRun: (update: Partial<PipelineRun>) => void;
  addRunHistory: (run: PipelineRun) => void;

  /* HITL */
  pendingGates: HitlGate[];
  addPendingGate: (gate: HitlGate) => void;
  updateGate: (gateId: string, status: HitlGate["status"]) => void;
  clearGates: () => void;

  /* chat */
  messages: ChatMessage[];
  isChatStreaming: boolean;
  addMessage: (msg: ChatMessage) => void;
  updateLastAssistant: (content: string) => void;
  setChatStreaming: (v: boolean) => void;
  clearMessages: () => void;

  /* project */
  currentProject: ProjectInfo | null;
  projects: ProjectInfo[];
  setCurrentProject: (p: ProjectInfo | null) => void;
  setProjects: (ps: ProjectInfo[]) => void;

  /* layout */
  sidebarWidth: number;
  rightPanelWidth: number;
  setSidebarWidth: (w: number) => void;
  setRightPanelWidth: (w: number) => void;
  isSidebarOpen: boolean;
  isRightPanelOpen: boolean;
  isBuilderExpanded: boolean;
  activeSidebarTab: "explorer" | "output" | "pipelines";
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  toggleBuilderExpanded: () => void;
  setActiveSidebarTab: (tab: "explorer" | "output" | "pipelines") => void;

  /* pipeline running state */
  isPipelineRunning: boolean;
  setIsPipelineRunning: (v: boolean) => void;

  /* WebSocket connection state — used to disable polling when WS is active */
  wsConnected: boolean;
  setWsConnected: (v: boolean) => void;

  /* zip attachment */
  zipAttachment: { file: File; type: "file" | "zip" } | null;
  setZipAttachment: (a: { file: File; type: "file" | "zip" } | null) => void;

  /* main view mode: "editor" (normal) or "pipeline-history" (full tab) or "report-viewer" or "diff-viewer" or "code-intelligence" */
  mainView: "editor" | "pipeline-history" | "report-viewer" | "diff-viewer" | "code-intelligence";
  setMainView: (v: "editor" | "pipeline-history" | "report-viewer" | "diff-viewer" | "code-intelligence") => void;

  /* report viewer */
  viewerReport: ReportFile | null;
  setViewerReport: (r: ReportFile | null) => void;
  viewerRunId: string | null;
  setViewerRunId: (id: string | null) => void;

  /* diff viewer */
  diffFiles: FileDiff[];
  setDiffFiles: (d: FileDiff[]) => void;
  diffRunId: string | null;
  setDiffRunId: (id: string | null) => void;
}

/* ── Store implementation ──────────────────────────────── */
export const useStore = create<AppState>((set, get) => ({
  /* ── file explorer ─────────────────────────────── */
  fileTree: [],
  selectedFile: null,
  expandedDirs: new Set<string>(),
  setFileTree: (tree) => set({ fileTree: tree }),
  selectFile: (path) => set({ selectedFile: path }),
  toggleDir: (path) =>
    set((s) => {
      const next = new Set(s.expandedDirs);
      next.has(path) ? next.delete(path) : next.add(path);
      return { expandedDirs: next };
    }),

  /* ── output tree ───────────────────────────────── */
  outputTree: [],
  setOutputTree: (tree) => set({ outputTree: tree }),
  outputRunId: null,
  setOutputRunId: (id) => set({ outputRunId: id }),

  /* ── editor tabs ───────────────────────────────── */
  tabs: [],
  activeTab: null,
  openTab: (tab) =>
    set((s) => {
      const exists = s.tabs.find((t) => t.path === tab.path);
      if (exists) return { activeTab: tab.path };
      return { tabs: [...s.tabs, tab], activeTab: tab.path };
    }),
  closeTab: (path) =>
    set((s) => {
      const next = s.tabs.filter((t) => t.path !== path);
      const active =
        s.activeTab === path
          ? next.length > 0
            ? next[next.length - 1].path
            : null
          : s.activeTab;
      return { tabs: next, activeTab: active };
    }),
  setActiveTab: (path) => set({ activeTab: path }),
  updateTabContent: (path, content) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path ? { ...t, content, isDirty: true } : t
      ),
    })),
  markTabClean: (path) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path ? { ...t, isDirty: false } : t
      ),
    })),

  /* ── pipeline ──────────────────────────────────── */
  pipelineMode: "greenfield",
  currentRun: null,
  runHistory: [],
  setPipelineMode: (mode) => set({ pipelineMode: mode }),
  setCurrentRun: (run) => set({ currentRun: run }),
  updateCurrentRun: (update) =>
    set((s) => ({
      currentRun: s.currentRun ? { ...s.currentRun, ...update } : null,
    })),
  addRunHistory: (run) =>
    set((s) => ({ runHistory: [run, ...s.runHistory].slice(0, 50) })),

  /* ── HITL ──────────────────────────────────────── */
  pendingGates: [],
  addPendingGate: (gate) =>
    set((s) => {
      if (s.pendingGates.find((g) => g.gate_id === gate.gate_id)) return {};
      return { pendingGates: [...s.pendingGates, gate] };
    }),
  updateGate: (gateId, status) =>
    set((s) => ({
      pendingGates: s.pendingGates.map((g) =>
        g.gate_id === gateId ? { ...g, status } : g
      ),
    })),
  clearGates: () => set({ pendingGates: [] }),

  /* ── chat ──────────────────────────────────────── */
  messages: [],
  isChatStreaming: false,
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  updateLastAssistant: (content) =>
    set((s) => {
      const msgs = [...s.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") {
          msgs[i] = { ...msgs[i], content: msgs[i].content + content };
          break;
        }
      }
      return { messages: msgs };
    }),
  setChatStreaming: (v) => set({ isChatStreaming: v }),
  clearMessages: () => set({ messages: [] }),

  /* ── project ───────────────────────────────────── */
  currentProject: null,
  projects: [],
  setCurrentProject: (p) => set({ currentProject: p }),
  setProjects: (ps) => set({ projects: ps }),

  /* ── layout ────────────────────────────────────── */
  sidebarWidth: 280,
  rightPanelWidth: 380,
  setSidebarWidth: (w) => set({ sidebarWidth: w }),
  setRightPanelWidth: (w) => set({ rightPanelWidth: w }),
  isSidebarOpen: true,
  isRightPanelOpen: true,
  isBuilderExpanded: false,
  activeSidebarTab: "explorer" as "explorer" | "output" | "pipelines",
  toggleSidebar: () => set((s) => ({ isSidebarOpen: !s.isSidebarOpen })),
  toggleRightPanel: () => set((s) => ({ isRightPanelOpen: !s.isRightPanelOpen })),
  toggleBuilderExpanded: () => set((s) => ({ isBuilderExpanded: !s.isBuilderExpanded })),
  setActiveSidebarTab: (tab) => set({ activeSidebarTab: tab }),

  /* ── pipeline running ──────────────────────────── */
  isPipelineRunning: false,
  setIsPipelineRunning: (v) => set({ isPipelineRunning: v }),

  /* ── WebSocket connection state ────────────────── */
  wsConnected: false,
  setWsConnected: (v) => set({ wsConnected: v }),

  /* ── zip attachment ────────────────────────────── */
  zipAttachment: null,
  setZipAttachment: (a) => set({ zipAttachment: a }),
  /* ── main view ─────────────────────────────────────── */
  mainView: "editor" as "editor" | "pipeline-history" | "report-viewer" | "diff-viewer" | "code-intelligence",
  setMainView: (v) => set({ mainView: v }),

  /* ── report viewer ─────────────────────────────────── */
  viewerReport: null,
  setViewerReport: (r) => set({ viewerReport: r }),
  viewerRunId: null,
  setViewerRunId: (id) => set({ viewerRunId: id }),

  /* ── diff viewer ───────────────────────────────────── */
  diffFiles: [],
  setDiffFiles: (d) => set({ diffFiles: d }),
  diffRunId: null,
  setDiffRunId: (id) => set({ diffRunId: id }),}));
