"""
Prompt Loader - Simple and readable system for managing all agent prompts.

Why this exists:
- Keeps prompts out of Python code for easier editing
- Stores prompts as markdown (.md) files for human readability
- Provides a single place to manage all instructions
- Caches loaded prompts to avoid repeated file reads

Usage:
    from prompts.loader import PromptLoader
    
    # Load a prompt
    prompt = PromptLoader.load("react")
    
    # Load and format with variables
    prompt = PromptLoader.load("react", tool_descriptions="...")
    
    # List all available prompts
    all_prompts = PromptLoader.list_available()
"""

from pathlib import Path
from typing import Any


class PromptLoader:
    """
    Loads prompt templates from the prompts/ folder.
    
    Prompts are stored as .md files and support variable substitution
    using Python's string formatting syntax: {variable_name}
    """

    # Cache to store loaded prompts in memory
    # Avoids re-reading files from disk on every call
    _prompt_cache: dict[str, str] = {}

    # Directory where prompts are stored
    _prompts_directory = Path(__file__).parent

    @classmethod
    def load(cls, prompt_name: str, **variables: Any) -> str:
        """
        Load a prompt template and optionally substitute variables.

        Args:
            prompt_name: Name of the prompt file (without .md extension)
                        Example: "react" loads from prompts/react.md
            **variables: Key-value pairs to substitute in the prompt template
                        Example: tool_descriptions="list of tools here"

        Returns:
            The prompt content with variables substituted (if provided)

        Raises:
            FileNotFoundError: If the prompt file doesn't exist
            KeyError: If a required template variable is missing

        Example:
            >>> prompt = PromptLoader.load(
            ...     "react",
            ...     tool_descriptions="- read_file\\n- write_file"
            ... )
        """

        # Step 1: Load from cache or read from disk
        if prompt_name not in cls._prompt_cache:
            prompt_file = cls._prompts_directory / f"{prompt_name}.md"

            # Check if file exists
            if not prompt_file.exists():
                available = ", ".join(cls.list_available())
                raise FileNotFoundError(
                    f"Prompt '{prompt_name}' not found.\n"
                    f"Looking for: {prompt_file}\n"
                    f"Available prompts: {available}"
                )

            # Read the prompt from disk
            prompt_content = prompt_file.read_text(encoding="utf-8")

            # Store in cache for next time
            cls._prompt_cache[prompt_name] = prompt_content

        # Step 2: Get the prompt from cache
        template = cls._prompt_cache[prompt_name]

        # Step 3: Substitute variables if any were provided.
        #
        # Targeted replacement of {name} tokens — NOT str.format(). Prompts
        # legitimately contain literal braces (JSON examples, JSX/TS snippets
        # in skills/*), and str.format() treats every {...} as a placeholder:
        # adding a JSON example to tool_use_agent.md crashed every agent
        # request with KeyError '"question"'. Replacing only the variables
        # actually provided makes stray braces plain content, never a crash.
        if variables:
            for name, value in variables.items():
                template = template.replace("{" + name + "}", str(value))

        return template

    @classmethod
    def list_available(cls) -> list[str]:
        """
        List all available prompt templates.

        Returns:
            A list of prompt names (without .md extension)

        Example:
            >>> PromptLoader.list_available()
            ['react', 'planning', 'summarization']
        """
        prompt_files = cls._prompts_directory.glob("*.md")
        return sorted([f.stem for f in prompt_files])

    @classmethod
    def clear_cache(cls) -> None:
        """
        Clear the in-memory cache.

        Useful during development when you're editing prompt files
        and want to see changes immediately without restarting.
        """
        cls._prompt_cache.clear()
