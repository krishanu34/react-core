"""
EXAMPLE: How to Use the Prompt System

This file shows practical examples of how the prompt loading system works.
You can delete this file once you understand the pattern.
"""

from prompts.loader import PromptLoader


def example_1_load_react_prompt():
    """Load the ReAct prompt and see what it looks like."""
    prompt = PromptLoader.load("react", tool_descriptions="- tool1\n- tool2")
    print("=== ReAct Prompt ===")
    print(prompt)
    print()


def example_2_load_planning_prompt():
    """Load the Planning prompt."""
    prompt = PromptLoader.load(
        "planning",
        task_description="Build a website",
        tool_descriptions="- create_file\n- edit_file"
    )
    print("=== Planning Prompt ===")
    print(prompt)
    print()


def example_3_list_prompts():
    """See all available prompts."""
    available = PromptLoader.list_available()
    print("=== Available Prompts ===")
    print(available)
    print()


def example_4_use_in_agent():
    """How to use prompts in your agents."""
    from agents.react_agent import ReActAgent
    from llm.factory import LLMFactory

    # Create an agent - it will automatically load prompts when needed
    llm = LLMFactory.create()
    agent = ReActAgent(llm=llm, max_steps=5)
    # The agent's _build_messages() method calls PromptLoader.load("react", ...)
    # You don't need to do anything special - it's already integrated!


def example_5_cache_management():
    """Manage the prompt cache during development."""
    
    # First call - loads from disk
    prompt1 = PromptLoader.load("react", tool_descriptions="...")
    
    # Second call - loads from cache (much faster)
    prompt2 = PromptLoader.load("react", tool_descriptions="...")
    
    # If you edited prompts/react.md, clear the cache
    PromptLoader.clear_cache()
    
    # Now it will re-read from disk
    prompt3 = PromptLoader.load("react", tool_descriptions="...")


# Run examples if this file is executed directly
if __name__ == "__main__":
    print("Running prompt system examples...\n")
    
    try:
        example_1_load_react_prompt()
        example_2_load_planning_prompt()
        example_3_list_prompts()
    except Exception as e:
        print(f"Error: {e}")
