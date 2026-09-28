"""
Vision Buffer — how an image a TOOL found reaches the model's eyes.

Claude Code's Read tool presents images visually: read a .png and the model
sees the picture, not a size in kilobytes. Reproducing that on the OpenAI
chat-completions API takes one indirection, because the protocol will not
carry it directly.

The constraint: a `tool` role message's content is a plain string. There is no
image part in it — images are only legal in a `user` message. So a tool cannot
return an image, no matter how the tool result is shaped. (Anthropic's API does
allow image blocks in a tool_result, which is why Claude Code needs no
equivalent of this file.)

The mechanism: a tool that produced viewable images drops them here, keyed by
thread. After the agent loop has appended the batch's tool results, it drains
the buffer and appends ONE user message carrying the images. The model then
sees, in order: its own tool call → the textual result → the pixels. Which is
exactly the sequence it would get from a native image-capable tool result.

Why a module-level dict rather than a return value: `_call_tool` stringifies
whatever a tool returns (`str(await tool.run(...))`), and that contract is
shared by the ReAct loop, the sub-agent loop and the spec workflow. Threading a
second channel through all of them to serve one tool would be a worse trade
than the pattern this codebase already uses for exactly this shape of problem
— see context/read_tracker.py and context/permissions.py, both process-wide
dicts keyed by thread_id, for the same reason.

The buffer is drained on read and cleared at the end of a run, so an image
never leaks into a later turn or another user's thread.
"""

from typing import Dict, List

from ingestion.limits import max_images_per_request
from utils.logger import get_logger

log = get_logger(__name__)

# thread_id -> image payload dicts ({mime_type, data, filename}), the same
# shape agents/tool_use_agent.py already accepts for attached images.
_pending: Dict[str, List[dict]] = {}


def offer(thread_id: str, images: list, source: str = "") -> int:
    """Queue images for the next model turn on this thread.

    Returns how many were actually queued. Excess images are DROPPED rather
    than queued: each one costs real tokens, and a `batch_read_files` over a
    directory of 200 screenshots must not silently become a 200-image request.
    The caller is expected to say in its text result when this happens, so the
    model knows some images exist that it cannot see.
    """
    if not thread_id or not images:
        return 0

    queue = _pending.setdefault(thread_id, [])
    room = max_images_per_request() - len(queue)
    if room <= 0:
        log.info("Vision buffer full for thread %s — %d image(s) from %s dropped",
                 thread_id, len(images), source or "a tool")
        return 0

    accepted = images[:room]
    queue.extend(accepted)
    if len(accepted) < len(images):
        log.info("Vision buffer capped for thread %s — %d of %d image(s) from %s kept",
                 thread_id, len(accepted), len(images), source or "a tool")
    return len(accepted)


def capacity(thread_id: str) -> int:
    """How many more images this thread's next turn can carry. Lets a caller
    decide what to send before spending effort encoding it."""
    return max(0, max_images_per_request() - len(_pending.get(thread_id, [])))


def drain(thread_id: str) -> list:
    """Take everything queued for this thread, leaving the buffer empty.

    Draining rather than reading is what stops the same image being re-sent on
    every subsequent step of the loop — which would multiply its token cost by
    the number of steps in the run.
    """
    return _pending.pop(thread_id, [])


def clear(thread_id: str) -> None:
    """Drop anything a run left behind (it ended before draining)."""
    _pending.pop(thread_id, None)
