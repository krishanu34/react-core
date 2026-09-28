"""Regression tests for the HTML→text renderer.

The naive version dropped table content, glued inline text together, and
lost list markers. These tests lock in the structural preservation.
"""
from __future__ import annotations

from react_core.attachments.extractors import render_html_to_text


def test_render_html_table_preserves_rows_and_cells():
    html = """
    <html><body>
      <table>
        <thead><tr><th>Field</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>Account ID</td><td>ACME-12345</td></tr>
          <tr><td>Owner</td><td>Krishanu Ganguli</td></tr>
        </tbody>
      </table>
    </body></html>
    """
    text = render_html_to_text(html)
    assert "Field | Value" in text
    assert "Account ID | ACME-12345" in text
    assert "Owner | Krishanu Ganguli" in text


def test_render_html_lists_with_markers_and_nesting():
    html = """
    <ul>
      <li>Top A
        <ol><li>Nested 1</li><li>Nested 2</li></ol>
      </li>
      <li>Top B</li>
    </ul>
    """
    text = render_html_to_text(html)
    assert "- Top A" in text
    assert "1. Nested 1" in text
    assert "2. Nested 2" in text
    assert "- Top B" in text


def test_render_html_inline_word_boundary():
    """`Hello <strong>world</strong>` should NOT become `Helloworld`."""
    html = "<p>Hello <strong>world</strong>, and <em>kittens</em>.</p>"
    text = render_html_to_text(html)
    assert "Hello world" in text
    assert "and kittens" in text
    assert "Helloworld" not in text


def test_render_html_strips_scripts_and_styles():
    html = """
    <html><head><style>body{color:red}</style></head>
    <body>
      <script>alert('bad')</script>
      <p>Visible only</p>
    </body></html>
    """
    text = render_html_to_text(html)
    assert "Visible only" in text
    assert "alert" not in text
    assert "color:red" not in text


def test_render_html_headings_and_paragraphs_blocked_apart():
    html = "<h1>Title</h1><p>Para one.</p><p>Para two.</p>"
    text = render_html_to_text(html)
    # Each block on its own line — no glued paragraphs.
    lines = [ln for ln in text.splitlines() if ln.strip()]
    assert "Title" in lines
    assert "Para one." in lines
    assert "Para two." in lines


def test_render_html_confluence_style_macro_body():
    """Realistic Confluence body: info macro wraps a table + list."""
    html = """
    <div class="confluence-information-macro">
      <div class="confluence-information-macro-body">
        <table><tr><th>Env</th><th>URL</th></tr>
        <tr><td>Prod</td><td>https://acct.example</td></tr></table>
        <ul><li>Owned by Billing</li><li>Renewal: 2027-01</li></ul>
      </div>
    </div>
    """
    text = render_html_to_text(html)
    assert "Env | URL" in text
    assert "Prod | https://acct.example" in text
    assert "- Owned by Billing" in text
    assert "- Renewal: 2027-01" in text
