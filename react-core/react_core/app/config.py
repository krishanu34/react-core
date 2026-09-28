"""Runtime configuration read from environment variables."""
from __future__ import annotations

import os
from pathlib import Path


class Settings:
    def __init__(self):
        self.host: str = os.getenv("REACT_CORE_HOST", "127.0.0.1")
        self.port: int = int(os.getenv("REACT_CORE_PORT", "8080"))
        self.state_dir: Path = Path(os.getenv("REACT_CORE_STATE_DIR", "./.react-core")).resolve()
        self.max_steps: int = int(os.getenv("REACT_CORE_MAX_STEPS", "50"))
        self.temperature: float = float(os.getenv("REACT_CORE_TEMPERATURE", "0.2"))
        self.llm_provider: str = os.getenv("LLM_PROVIDER", "openai").strip().lower()
        self.state_dir.mkdir(parents=True, exist_ok=True)


settings = Settings()
