"""HTTP connectors + auth resolution."""
from .auth import AuthCredential, resolve_auth
from .confluence import Confluence
from .jira import Jira
from .web import WebFetchError, web_fetch

__all__ = [
    "AuthCredential", "resolve_auth",
    "Jira", "Confluence",
    "web_fetch", "WebFetchError",
]
