"""Build a ToolRegistry bound to one workspace root.

Two profiles (env `PROMPT_PROFILE`):
- `qa` (default) — workspace tools + attachments + connectors + vector-store +
  human-in-loop (ask_user, request_approval) + remember.
- `coding` — workspace tools + ask_user + remember only (original persona).
"""
from __future__ import annotations

import os
from typing import Optional

from ..memory.long_term import LongTermMemory
from .analyze_requirements import AnalyzeRequirementsTool
from .ask_user import AskUserTool
from .base import BaseTool, signature_from_schema
from .batch_read_files import BatchReadFilesTool
from .code_edit import CodeEditTool
from .confluence_fetch_page import ConfluenceFetchPageTool
from .confluence_page_extract import ConfluencePageExtractTool
from .confluence_search import ConfluenceSearchTool
from .create_entry import CreateEntryTool
from .delete_entry import DeleteEntryTool
from .file_search import FileSearchTool
from .generate_gherkin import GenerateGherkinTool
from .grep_search import GrepSearchTool
from .index_document import IndexDocumentTool
from .jira_fetch_issue import JiraFetchIssueTool
from .jira_hierarchy import JiraHierarchyTool
from .jira_search import JiraSearchTool
from .list_attachments import ListAttachmentsTool
from .list_directory import ListDirectoryTool
from .list_indexed_sources import ListIndexedSourcesTool
from .read_attachment import ReadAttachmentTool
from .read_file import ReadFileTool
from .remember import RememberTool
from .rename_entry import RenameEntryTool
from .request_approval import RequestApprovalTool
from .run_terminal import RunTerminalTool
from .search_semantic import SearchSemanticTool
from .web_fetch import WebFetchTool
from .workspace_tree import WorkspaceTreeTool
from .write_file import WriteFileTool

# Tool classes that take (workspace) only.
_WORKSPACE_TOOL_CLASSES: list[type[BaseTool]] = [
    ReadFileTool,
    WriteFileTool,
    CodeEditTool,
    BatchReadFilesTool,
    GrepSearchTool,
    FileSearchTool,
    ListDirectoryTool,
    WorkspaceTreeTool,
    CreateEntryTool,
    DeleteEntryTool,
    RenameEntryTool,
    RunTerminalTool,
]


class ToolRegistry:
    def __init__(self, tools: list[BaseTool]):
        self._tools = tools
        self._by_name = {t.name: t for t in tools}

    @classmethod
    def build_for_workspace(
        cls,
        workspace: str,
        thread_id: str = "",
        tool_classes: Optional[list[type[BaseTool]]] = None,
        long_term: LongTermMemory | None = None,
        *,
        org_id: str = "org-default",
        user_id: str = "admin",
        project_id: Optional[str] = None,
    ) -> "ToolRegistry":
        classes = tool_classes if tool_classes is not None else _WORKSPACE_TOOL_CLASSES
        tools: list[BaseTool] = [cls_(workspace) for cls_ in classes]

        profile = (os.getenv("PROMPT_PROFILE") or "qa").strip().lower()

        # ask_user is always available (clarification-only). request_approval
        # is a QA-only checkpoint tool.
        tools.append(AskUserTool(workspace, thread_id=thread_id))
        if profile != "coding":
            tools.append(RequestApprovalTool(workspace, thread_id=thread_id))
            # Attachments
            tools.append(ListAttachmentsTool(workspace, org_id=org_id))
            tools.append(ReadAttachmentTool(workspace, org_id=org_id))
            # Connectors
            tools.append(JiraFetchIssueTool(workspace, user_id=user_id))
            tools.append(JiraSearchTool(workspace, user_id=user_id))
            tools.append(JiraHierarchyTool(workspace, user_id=user_id))
            tools.append(ConfluenceFetchPageTool(workspace, user_id=user_id))
            tools.append(ConfluenceSearchTool(workspace, user_id=user_id))
            tools.append(ConfluencePageExtractTool(workspace, user_id=user_id))
            tools.append(WebFetchTool(workspace))
            # Vector store
            tools.append(IndexDocumentTool(workspace, org_id=org_id, project_id=project_id))
            tools.append(SearchSemanticTool(workspace, org_id=org_id, project_id=project_id))
            tools.append(ListIndexedSourcesTool(workspace, org_id=org_id, project_id=project_id))
            # QA-layer tools (spec: docs/qa-layer-spec.md)
            tools.append(AnalyzeRequirementsTool(workspace))
            tools.append(GenerateGherkinTool(
                workspace, org_id=org_id, thread_id=thread_id, project_id=project_id,
            ))

        if long_term is not None:
            tools.append(RememberTool(workspace, long_term=long_term))
        return cls(tools)

    def get(self, name: str) -> Optional[BaseTool]:
        return self._by_name.get(name)

    def names(self) -> list[str]:
        return list(self._by_name.keys())

    def list_tools(self) -> list[BaseTool]:
        return list(self._tools)

    def schemas(self) -> list[dict]:
        return [t.schema() for t in self._tools]

    def descriptions_text(self) -> str:
        if not self._tools:
            return "(no tools available)"
        lines: list[str] = []
        for tool in self._tools:
            sig = signature_from_schema(tool)
            desc = " ".join(tool.description.split())
            lines.append(f"- {tool.name}({sig}): {desc}")
        return "\n".join(lines)
