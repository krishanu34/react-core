"use client";

import { useCallback, useState } from "react";
import { Chat } from "./Chat";
import { FileEditor } from "./FileEditor";
import { FileExplorer } from "./FileExplorer";

export function Workspace() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleThreadIdChange = useCallback((tid: string | null) => {
    setThreadId(tid);
  }, []);

  const handleRunFinished = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <FileExplorer
        threadId={threadId}
        selectedPath={selectedPath}
        onSelect={setSelectedPath}
        refreshKey={refreshKey}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Chat
          onThreadIdChange={handleThreadIdChange}
          onRunFinished={handleRunFinished}
        />
      </div>
      {selectedPath && threadId && (
        <div className="flex min-h-0 w-[520px] min-w-[420px] flex-shrink-0 flex-col">
          <FileEditor
            key={`${threadId}:${selectedPath}`}
            threadId={threadId}
            path={selectedPath}
            onClose={() => setSelectedPath(null)}
            onSaved={() => setRefreshKey((k) => k + 1)}
          />
        </div>
      )}
    </div>
  );
}
