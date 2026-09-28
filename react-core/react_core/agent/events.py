"""SSE event helpers."""
from __future__ import annotations

import json
from typing import Any


def sse_event(event_type: str, data: dict[str, Any]) -> str:
    payload = json.dumps({"type": event_type, **data}, ensure_ascii=False, default=str)
    return f"data: {payload}\n\n"
