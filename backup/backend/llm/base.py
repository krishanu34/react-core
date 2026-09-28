from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class ToolCall:
    """One tool call from the LLM's response (native function calling)."""
    id: str
    name: str
    arguments: dict


@dataclass
class ToolUseResponse:
    """Structured response from invoke_with_tools."""
    text: str = ""
    tool_calls: List[ToolCall] = field(default_factory=list)
    usage: dict = field(default_factory=dict)
    raw_message: dict = field(default_factory=dict)

    @property
    def has_tool_calls(self) -> bool:
        return len(self.tool_calls) > 0

    @property
    def is_final(self) -> bool:
        return bool(self.text) and not self.has_tool_calls


class BaseLLM(ABC):

    @abstractmethod
    async def invoke(
        self,
        message: list,
        temperature: float = 0.0,
        max_tokens: int = 1000,
    ):
        pass

    @abstractmethod
    async def stream(
        self,
        message: list,
        temperature: float = 0.0,
        max_tokens: int = 1000,
    ):
        pass

    async def invoke_with_tools(
        self,
        messages: list,
        tools: list = None,
        temperature: float = 0.0,
        max_tokens: int = 4096,
    ) -> ToolUseResponse:
        """
        Call the LLM with native function calling (tool_use).

        Returns a ToolUseResponse with either:
          - text only (is_final=True) -> agent is done
          - tool_calls (has_tool_calls=True) -> execute tools, continue

        Subclasses override this. Default falls back to invoke().
        """
        text, usage = await self.invoke(messages, temperature, max_tokens)
        return ToolUseResponse(text=text, usage=usage)

    async def stream_with_tools(
        self,
        messages: list,
        tools: list = None,
        temperature: float = 0.0,
        max_tokens: int = 4096,
    ):
        """
        Stream the LLM response token-by-token with tool support.

        Yields tuples:
          ("content", "token text")  -> streaming text token
          ("tool_calls", [...])      -> complete tool calls (at end)
          ("usage", {...})           -> token usage (at end)

        When the LLM calls tools, tool_calls arrive after all content.
        When the LLM responds with text only, content tokens stream
        one by one for real-time display.

        Subclasses override this. Default falls back to invoke_with_tools().
        """
        result = await self.invoke_with_tools(messages, tools, temperature, max_tokens)
        if result.text:
            yield ("content", result.text)
        if result.tool_calls:
            yield ("tool_calls", result.tool_calls)
        if result.usage:
            yield ("usage", result.usage)
