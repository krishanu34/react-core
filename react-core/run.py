"""Dev entrypoint: `python run.py`."""
from __future__ import annotations

import os

import uvicorn
from dotenv import load_dotenv

load_dotenv()

if __name__ == "__main__":
    uvicorn.run(
        "react_core.app.main:app",
        host=os.getenv("REACT_CORE_HOST", "127.0.0.1"),
        port=int(os.getenv("REACT_CORE_PORT", "8000")),
        reload=os.getenv("REACT_CORE_RELOAD", "false").lower() == "true",
    )
