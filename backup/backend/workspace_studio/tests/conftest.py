from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MODULE = ROOT / "workspace_studio"
for path in (ROOT, MODULE):
    text = str(path)
    if text not in sys.path:
        sys.path.insert(0, text)

