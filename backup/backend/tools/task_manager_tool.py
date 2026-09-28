"""
Task Manager Tool — Track Multi-Step Work

This is Claude Code's TodoWrite/TaskCreate/TaskUpdate/TaskList system.
When the agent is working on a complex task (refactor 10 files, implement
a feature with multiple parts), it uses this tool to:

  1. Break the work into discrete steps
  2. Track which steps are done vs pending
  3. Report progress to the user

The task list lives in memory per thread — it's visible in SSE events
so the client can show a progress indicator.

Task states: pending → in_progress → done | blocked | skipped
"""

from typing import Dict, List, Optional
from .base_tool import BaseTool


# In-memory task store, keyed by thread_id
# In production this would be in the database (Phase 4: SQLite)
_task_stores: Dict[str, List[dict]] = {}


class TaskManagerTool(BaseTool):

    name = "task_manager"

    # Emits a structured `tasks` SSE event on every change so the client can
    # render a live Claude Code-style todo checklist instead of raw JSON.
    SUPPORTS_STREAMING = True

    description = (
        "Manage a task checklist for multi-step work. Use this to plan, "
        "track, and report progress on complex tasks. Operations: "
        "'create' to add tasks, 'update' to change status, 'list' to "
        "see all tasks, 'clear' to reset. Each task has an id, title, "
        "and status (pending/in_progress/done/blocked/skipped)."
    )

    def __init__(self, workspace: str, thread_id: str = "default"):
        super().__init__(workspace)
        self._thread_id = thread_id

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "description": (
                        "Operation to perform: 'create' (add tasks), "
                        "'update' (change task status), 'list' (show all tasks), "
                        "'clear' (remove all tasks)"
                    )
                },
                "tasks": {
                    "type": "array",
                    "description": (
                        "For 'create': list of task titles to add. "
                        "Example: ['Read config files', 'Update database schema', 'Run tests']"
                    ),
                    "items": {"type": "string"}
                },
                "task_id": {
                    "type": "integer",
                    "description": "For 'update': the task ID to update (1-based)"
                },
                "status": {
                    "type": "string",
                    "description": (
                        "For 'update': new status. One of: "
                        "'pending', 'in_progress', 'done', 'blocked', 'skipped'"
                    )
                },
                "note": {
                    "type": "string",
                    "description": "For 'update': optional note about the task"
                }
            },
            "required": ["operation"]
        }

    def _get_tasks(self) -> List[dict]:
        if self._thread_id not in _task_stores:
            _task_stores[self._thread_id] = []
        return _task_stores[self._thread_id]

    async def _emit_tasks(self, on_event) -> None:
        """Push the current checklist to the client as a structured event."""
        if on_event is None:
            return
        task_list = self._get_tasks()
        finished = sum(1 for t in task_list if t["status"] in ("done", "skipped"))
        maybe = on_event("tasks", {
            "tasks": [dict(t) for t in task_list],
            "done": finished,
            "total": len(task_list),
        })
        if maybe is not None:
            await maybe

    async def run(self, operation, tasks=None, task_id=None, status=None, note=None, on_event=None):
        task_list = self._get_tasks()

        if operation == "create":
            if not tasks:
                return {"error": "Provide a 'tasks' list of task titles"}
            for title in tasks:
                task_list.append({
                    "id": len(task_list) + 1,
                    "title": title,
                    "status": "pending",
                    "note": "",
                })
            await self._emit_tasks(on_event)
            return {
                "operation": "created",
                "added": len(tasks),
                "total": len(task_list),
                "tasks": task_list,
            }

        elif operation == "update":
            if task_id is None:
                return {"error": "Provide 'task_id' (1-based) to update"}
            if task_id < 1 or task_id > len(task_list):
                return {"error": f"Invalid task_id {task_id}. Valid range: 1-{len(task_list)}"}

            valid_statuses = {"pending", "in_progress", "done", "blocked", "skipped"}
            if status and status not in valid_statuses:
                return {"error": f"Invalid status '{status}'. Valid: {valid_statuses}"}

            task = task_list[task_id - 1]
            if status:
                task["status"] = status
            if note:
                task["note"] = note

            done = sum(1 for t in task_list if t["status"] == "done")
            total = len(task_list)

            await self._emit_tasks(on_event)
            return {
                "operation": "updated",
                "task": task,
                "progress": f"{done}/{total} done",
                "tasks": task_list,
            }

        elif operation == "list":
            if not task_list:
                return {"tasks": [], "message": "No tasks created yet"}

            done = sum(1 for t in task_list if t["status"] == "done")
            total = len(task_list)
            status_icons = {
                "pending": "[ ]",
                "in_progress": "[~]",
                "done": "[x]",
                "blocked": "[!]",
                "skipped": "[-]",
            }
            formatted = []
            for t in task_list:
                icon = status_icons.get(t["status"], "[ ]")
                line = f"{icon} {t['id']}. {t['title']}"
                if t.get("note"):
                    line += f" ({t['note']})"
                formatted.append(line)

            return {
                "tasks": task_list,
                "progress": f"{done}/{total} done",
                "formatted": "\n".join(formatted),
            }

        elif operation == "clear":
            _task_stores[self._thread_id] = []
            await self._emit_tasks(on_event)
            return {"operation": "cleared", "message": "All tasks removed"}

        return {"error": f"Unknown operation '{operation}'. Use: create, update, list, clear"}
