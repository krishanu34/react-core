"""Workspace Studio domain exceptions."""

from __future__ import annotations


class WorkspaceStudioError(Exception):
    """Base class for service-layer errors."""


class NotFoundError(WorkspaceStudioError):
    """Requested resource was not found or is not accessible."""


class ConflictError(WorkspaceStudioError):
    """Optimistic locking or sync conflict."""


class DuplicateError(WorkspaceStudioError):
    """A resource already exists."""


class ValidationError(WorkspaceStudioError):
    """Invalid user-controlled input."""

