from __future__ import annotations

import sys
from pathlib import Path

# backend/ on the path so `agents`, `tools`, `context` import as top-level
# packages — the same shape the server uses (see app/main.py).
BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))
