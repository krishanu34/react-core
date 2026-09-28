"""
Prompts Package

All agent prompts are stored as .md files in this folder.
Use PromptLoader to load and use them in your agents.

Quick Start:
    from prompts.loader import PromptLoader
    
    # Load a prompt
    prompt = PromptLoader.load("react", tool_descriptions="...")
    
    # List available
    print(PromptLoader.list_available())
"""

from .loader import PromptLoader

__all__ = ["PromptLoader"]
