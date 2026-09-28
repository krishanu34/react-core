"""
Notebook Edit Tool — Modify Jupyter Notebooks

Claude Code's NotebookEdit modifies .ipynb files one cell at a time.
Jupyter notebooks are JSON files with a specific structure:

  {
    "cells": [
      {"cell_type": "code", "source": ["..."], "id": "abc123", ...},
      {"cell_type": "markdown", "source": ["# Title"], "id": "def456", ...}
    ],
    "metadata": {...},
    "nbformat": 4
  }

Operations:
  - replace: overwrite a cell's source by cell_id or index
  - insert: add a new cell after a target cell
  - delete: remove a cell
  - list: show all cells with their IDs and types

No external dependencies — notebooks are just JSON files.
"""

import json
import uuid
from pathlib import Path

from .base_tool import BaseTool
from .file_locks import file_lock


class NotebookEditTool(BaseTool):

    name = "notebook_edit"

    description = (
        "Edit Jupyter notebook (.ipynb) files. Operations: 'replace' to "
        "update a cell's content, 'insert' to add a new cell, 'delete' to "
        "remove a cell, 'list' to see all cells. Target cells by index "
        "(0-based) or cell_id."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the .ipynb file"
                },
                "operation": {
                    "type": "string",
                    "description": (
                        "Operation: 'replace' (update cell content), "
                        "'insert' (add new cell), 'delete' (remove cell), "
                        "'list' (show all cells)"
                    )
                },
                "cell_index": {
                    "type": "integer",
                    "description": "Target cell index (0-based). Alternative to cell_id."
                },
                "cell_id": {
                    "type": "string",
                    "description": "Target cell ID. Alternative to cell_index."
                },
                "cell_type": {
                    "type": "string",
                    "description": "For 'insert': type of new cell ('code' or 'markdown'). Default: 'code'"
                },
                "source": {
                    "type": "string",
                    "description": "For 'replace' and 'insert': the new cell content"
                }
            },
            "required": ["path", "operation"]
        }

    async def run(self, path, operation, cell_index=None, cell_id=None,
                  cell_type=None, source=None):
        file_path = Path(self._resolve_path(path))

        if operation == "list":
            return await self._list_cells(file_path)

        # Every mutating operation is load-JSON → mutate cells → dump-JSON,
        # which is not atomic. Two cell edits to the same notebook in one
        # concurrent tool batch would both load the original and the second
        # dump would drop the first cell's change. See tools/file_locks.py.
        async with file_lock(str(file_path)):
            return await self._edit_locked(
                file_path, path, operation, cell_index, cell_id, cell_type, source
            )

    async def _edit_locked(self, file_path, path, operation, cell_index,
                           cell_id, cell_type, source):
        """The load → mutate → dump sequence. Caller holds this path's lock."""
        if not file_path.exists():
            if operation == "insert" and source:
                return await self._create_notebook(file_path, cell_type or "code", source)
            return {"error": f"Notebook not found: {path}"}

        try:
            nb = json.loads(file_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            return {"error": f"Failed to read notebook: {e}"}

        cells = nb.get("cells", [])

        # Resolve cell target
        target_idx = self._resolve_cell(cells, cell_index, cell_id)

        if operation == "replace":
            if target_idx is None:
                return {"error": "Provide cell_index or cell_id to replace"}
            if target_idx < 0 or target_idx >= len(cells):
                return {"error": f"Cell index {target_idx} out of range (0-{len(cells)-1})"}
            if source is None:
                return {"error": "Provide 'source' content for replace"}

            cells[target_idx]["source"] = _to_source_lines(source)
            file_path.write_text(json.dumps(nb, indent=1, ensure_ascii=False), encoding="utf-8")
            return {
                "operation": "replaced",
                "cell_index": target_idx,
                "cell_type": cells[target_idx].get("cell_type", "code"),
                "path": path,
            }

        elif operation == "insert":
            if source is None:
                return {"error": "Provide 'source' content for insert"}

            new_cell = _make_cell(cell_type or "code", source)

            if target_idx is not None:
                # Insert after target
                cells.insert(target_idx + 1, new_cell)
                insert_at = target_idx + 1
            else:
                # Append at end
                cells.append(new_cell)
                insert_at = len(cells) - 1

            nb["cells"] = cells
            file_path.write_text(json.dumps(nb, indent=1, ensure_ascii=False), encoding="utf-8")
            return {
                "operation": "inserted",
                "cell_index": insert_at,
                "cell_id": new_cell.get("id", ""),
                "cell_type": cell_type or "code",
                "path": path,
                "total_cells": len(cells),
            }

        elif operation == "delete":
            if target_idx is None:
                return {"error": "Provide cell_index or cell_id to delete"}
            if target_idx < 0 or target_idx >= len(cells):
                return {"error": f"Cell index {target_idx} out of range (0-{len(cells)-1})"}

            removed = cells.pop(target_idx)
            nb["cells"] = cells
            file_path.write_text(json.dumps(nb, indent=1, ensure_ascii=False), encoding="utf-8")
            return {
                "operation": "deleted",
                "cell_index": target_idx,
                "cell_type": removed.get("cell_type", "unknown"),
                "path": path,
                "remaining_cells": len(cells),
            }

        return {"error": f"Unknown operation '{operation}'. Use: replace, insert, delete, list"}

    async def _list_cells(self, file_path: Path):
        if not file_path.exists():
            return {"error": f"Notebook not found: {file_path.name}"}

        try:
            nb = json.loads(file_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            return {"error": f"Failed to read notebook: {e}"}

        cells = nb.get("cells", [])
        cell_info = []
        for i, cell in enumerate(cells):
            source_text = "".join(cell.get("source", []))
            preview = source_text[:100].replace("\n", " ")
            if len(source_text) > 100:
                preview += "..."

            cell_info.append({
                "index": i,
                "cell_id": cell.get("id", ""),
                "cell_type": cell.get("cell_type", "unknown"),
                "lines": source_text.count("\n") + 1,
                "preview": preview,
            })

        return {
            "path": str(file_path.name),
            "total_cells": len(cells),
            "cells": cell_info,
        }

    async def _create_notebook(self, file_path: Path, cell_type: str, source: str):
        nb = {
            "cells": [_make_cell(cell_type, source)],
            "metadata": {
                "kernelspec": {
                    "display_name": "Python 3",
                    "language": "python",
                    "name": "python3",
                }
            },
            "nbformat": 4,
            "nbformat_minor": 5,
        }
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(json.dumps(nb, indent=1, ensure_ascii=False), encoding="utf-8")
        return {
            "operation": "created",
            "path": str(file_path),
            "cell_type": cell_type,
            "total_cells": 1,
        }

    def _resolve_cell(self, cells, cell_index, cell_id):
        if cell_index is not None:
            return cell_index
        if cell_id:
            for i, cell in enumerate(cells):
                if cell.get("id") == cell_id:
                    return i
        return None


def _make_cell(cell_type: str, source: str) -> dict:
    return {
        "cell_type": cell_type,
        "id": str(uuid.uuid4())[:8],
        "metadata": {},
        "source": _to_source_lines(source),
        "outputs": [] if cell_type == "code" else [],
        **({"execution_count": None} if cell_type == "code" else {}),
    }


def _to_source_lines(source: str) -> list:
    """Convert a source string to notebook's line-array format."""
    lines = source.split("\n")
    result = []
    for i, line in enumerate(lines):
        if i < len(lines) - 1:
            result.append(line + "\n")
        else:
            result.append(line)
    return result
