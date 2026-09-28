"""Smoke tests that exercise the tools without hitting an LLM."""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Make the package importable when running `python -m unittest` from repo root.
_REPO = Path(__file__).resolve().parents[1]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

from react_core.llm.gemini_client import convert_messages as gemini_convert_messages
from react_core.llm.structured_output import extract_json
from react_core.memory.conversation import ConversationMemory
from react_core.memory.long_term import LongTermMemory
from react_core.memory.thread_memory import ThreadMemory
from react_core.permissions.path_guard import PathEscape, resolve_in_root
from react_core.permissions.scan_policy import build as build_policy
from react_core.agent.scratchpad import Scratchpad
from react_core.tools.code_edit import CodeEditTool
from react_core.tools.create_entry import CreateEntryTool
from react_core.tools.delete_entry import DeleteEntryTool
from react_core.tools.file_search import FileSearchTool
from react_core.tools.grep_search import GrepSearchTool
from react_core.tools.list_directory import ListDirectoryTool
from react_core.tools.read_file import ReadFileTool
from react_core.tools.registry import ToolRegistry
from react_core.tools.remember import RememberTool
from react_core.tools.rename_entry import RenameEntryTool
from react_core.tools.workspace_tree import WorkspaceTreeTool
from react_core.tools.write_file import WriteFileTool
from react_core.utils.token_estimator import estimate_tokens, estimate_messages_tokens


def _run(coro):
    return asyncio.get_event_loop_policy().new_event_loop().run_until_complete(coro)


class PathGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_relative_ok(self):
        p = resolve_in_root(self.root, "a/b.txt")
        self.assertTrue(str(p).startswith(str(Path(self.root).resolve())))

    def test_dotdot_rejected(self):
        with self.assertRaises(PathEscape):
            resolve_in_root(self.root, "../etc/passwd")

    def test_absolute_rejected(self):
        with self.assertRaises(PathEscape):
            resolve_in_root(self.root, "/etc/passwd" if os.name != "nt" else "C:\\Windows")


class StructuredOutputTests(unittest.TestCase):
    def test_plain_json(self):
        self.assertEqual(extract_json('{"a": 1}'), {"a": 1})

    def test_fenced_json(self):
        text = 'Sure!\n```json\n{"action": "read_file"}\n```\n'
        self.assertEqual(extract_json(text), {"action": "read_file"})

    def test_prefixed_json(self):
        text = 'Here is the next step: {"thought": "hi", "action": "list_directory"}'
        parsed = extract_json(text)
        self.assertEqual(parsed["action"], "list_directory")


class ScanPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_default_prunes_node_modules(self):
        pol = build_policy(self.root)
        self.assertTrue(pol.skip_dir("node_modules", "node_modules"))
        self.assertFalse(pol.skip_dir("src", "src"))

    def test_include_ignored_shows_everything(self):
        pol = build_policy(self.root, include_ignored=True)
        self.assertFalse(pol.skip_dir("node_modules", "node_modules"))

    def test_targeting_bypasses_prune(self):
        pol = build_policy(self.root, search_path="node_modules/express")
        self.assertFalse(pol.skip_dir("node_modules", "node_modules"))


class FileToolsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        (Path(self.root) / "hello.py").write_text("print('hi')\n", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_read_file(self):
        r = _run(ReadFileTool(self.root).run(path="hello.py"))
        self.assertIn("print('hi')", r["content"])
        self.assertEqual(r["total_lines"], 1)

    def test_write_and_edit(self):
        w = _run(WriteFileTool(self.root).run(path="a.txt", content="one\ntwo\nthree\n"))
        self.assertEqual(w["bytes_written"], len("one\ntwo\nthree\n"))
        e = _run(CodeEditTool(self.root).run(
            path="a.txt", old_string="two", new_string="TWO",
        ))
        self.assertEqual(e["replacements"], 1)
        r = _run(ReadFileTool(self.root).run(path="a.txt"))
        self.assertIn("TWO", r["content"])

    def test_code_edit_ambiguous(self):
        (Path(self.root) / "b.txt").write_text("x\nx\n", encoding="utf-8")
        e = _run(CodeEditTool(self.root).run(path="b.txt", old_string="x", new_string="y"))
        self.assertIn("error", e)

    def test_create_delete_rename(self):
        c = _run(CreateEntryTool(self.root).run(path="new.md"))
        self.assertTrue(c["created"])
        r = _run(RenameEntryTool(self.root).run(old_path="new.md", new_path="dir/renamed.md"))
        self.assertTrue(r["renamed"])
        d = _run(DeleteEntryTool(self.root).run(path="dir/renamed.md"))
        self.assertTrue(d["deleted"])

    def test_list_directory(self):
        r = _run(ListDirectoryTool(self.root).run(path="."))
        names = {e["name"] for e in r["entries"]}
        self.assertIn("hello.py", names)

    def test_workspace_tree(self):
        (Path(self.root) / "sub").mkdir()
        (Path(self.root) / "sub" / "x.py").write_text("", encoding="utf-8")
        r = _run(WorkspaceTreeTool(self.root).run())
        self.assertIn("hello.py", r["tree"])
        self.assertIn("sub/", r["tree"])

    def test_grep_python_engine(self):
        r = _run(GrepSearchTool(self.root).run(query=r"print"))
        self.assertEqual(r["total_matches"], 1)

    def test_file_search(self):
        r = _run(FileSearchTool(self.root).run(pattern="*.py"))
        paths = [f["path"] for f in r["files"]]
        self.assertIn("hello.py", paths)


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_registry_builds(self):
        reg = ToolRegistry.build_for_workspace(self.tmp.name, thread_id="t")
        names = set(reg.names())
        for expected in (
            "read_file", "write_file", "code_edit", "grep_search",
            "file_search", "list_directory", "workspace_tree",
            "batch_read_files", "run_terminal", "create_entry",
            "delete_entry", "rename_entry", "ask_user",
        ):
            self.assertIn(expected, names)
        text = reg.descriptions_text()
        self.assertIn("read_file", text)

    def test_registry_registers_remember_when_long_term_wired(self):
        lt = LongTermMemory(state_dir=self.tmp.name, thread_id="t")
        reg = ToolRegistry.build_for_workspace(
            self.tmp.name, thread_id="t", long_term=lt,
        )
        self.assertIn("remember", reg.names())


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_conversation_persists_across_instances(self):
        conv1 = ConversationMemory(state_dir=self.tmp.name)
        conv1.set_workspace("t1", self.tmp.name)
        conv1.add_message("t1", "user", "hi")
        conv1.add_message("t1", "assistant", "hello")

        conv2 = ConversationMemory(state_dir=self.tmp.name)
        msgs = conv2.get_messages("t1")
        self.assertEqual(len(msgs), 2)
        self.assertEqual(msgs[0]["role"], "user")
        self.assertEqual(msgs[1]["content"], "hello")
        self.assertEqual(conv2.get_workspace("t1"), self.tmp.name)

    def test_long_term_add_and_load(self):
        lt = LongTermMemory(state_dir=self.tmp.name, thread_id="t")
        lt.add("prefers black coffee", tags=["preference"])
        lt.add("uses PowerShell", tags=["env"])
        entries = lt.load()
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["content"], "prefers black coffee")
        self.assertEqual(lt.search("preference"), [entries[0]])

    def test_remember_tool_writes_long_term(self):
        lt = LongTermMemory(state_dir=self.tmp.name, thread_id="t")
        tool = RememberTool(self.tmp.name, long_term=lt)
        r = _run(tool.run(content="likes vim keybindings"))
        self.assertTrue(r["remembered"])
        self.assertEqual(len(lt.load()), 1)

    def test_thread_memory_context_includes_recent_and_long_term(self):
        conv = ConversationMemory(state_dir=self.tmp.name)
        lt = LongTermMemory(state_dir=self.tmp.name, thread_id="t")
        conv.add_message("t", "user", "please build a script")
        conv.add_message("t", "assistant", "here is your script")
        lt.add("prefers concise output")
        tm = ThreadMemory(thread_id="t", conversation=conv, long_term=lt)
        ctx = _run(tm.build_memory_context())
        self.assertIn("Recent Conversation", ctx)
        self.assertIn("please build a script", ctx)
        self.assertIn("Long-Term Memory", ctx)
        self.assertIn("prefers concise output", ctx)

    def test_thread_memory_empty_returns_empty(self):
        conv = ConversationMemory(state_dir=self.tmp.name)
        lt = LongTermMemory(state_dir=self.tmp.name, thread_id="empty")
        tm = ThreadMemory(thread_id="empty", conversation=conv, long_term=lt)
        ctx = _run(tm.build_memory_context())
        self.assertEqual(ctx, "")


class ScratchpadTests(unittest.TestCase):
    def test_render_when_empty(self):
        sp = Scratchpad()
        self.assertIn("no prior steps", sp.render())

    def test_render_includes_steps(self):
        sp = Scratchpad()
        sp.add(
            thought="check the file",
            observations=[{"tool": "read_file", "input": {"path": "a.py"}, "observation": "line one"}],
        )
        rendered = sp.render()
        self.assertIn("Step 1", rendered)
        self.assertIn("read_file", rendered)
        self.assertIn("line one", rendered)


class TokenEstimatorTests(unittest.TestCase):
    def test_counts_something(self):
        self.assertGreater(estimate_tokens("hello world"), 0)

    def test_messages_include_overhead(self):
        n = estimate_messages_tokens([
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ])
        self.assertGreater(n, 0)


class GeminiMessageConversionTests(unittest.TestCase):
    def test_system_folded_and_roles_mapped(self):
        system, contents = gemini_convert_messages([
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello!"},
            {"role": "user", "content": "How are you?"},
        ])
        self.assertEqual(system, "You are helpful.")
        self.assertEqual(len(contents), 3)
        self.assertEqual(contents[0]["role"], "user")
        self.assertEqual(contents[1]["role"], "model")
        self.assertEqual(contents[2]["role"], "user")
        self.assertEqual(contents[0]["parts"][0]["text"], "Hi")

    def test_multiple_system_messages_joined(self):
        system, _ = gemini_convert_messages([
            {"role": "system", "content": "Rule one."},
            {"role": "system", "content": "Rule two."},
            {"role": "user", "content": "Go"},
        ])
        self.assertIn("Rule one.", system)
        self.assertIn("Rule two.", system)

    def test_empty_messages_dropped(self):
        system, contents = gemini_convert_messages([
            {"role": "system", "content": ""},
            {"role": "user", "content": "   "},
            {"role": "user", "content": "real message"},
        ])
        self.assertEqual(system, "")
        self.assertEqual(len(contents), 1)
        self.assertEqual(contents[0]["parts"][0]["text"], "real message")


if __name__ == "__main__":
    unittest.main()
