"""
Web Fetch Tool — Fetch Content from URLs

Claude Code's WebFetch fetches a URL, converts HTML to markdown,
and runs an extraction prompt against it. Our implementation:

  1. Fetch the URL with httpx (already a project dependency)
  2. Strip HTML tags to get readable text
  3. Return the content (no extraction LLM call — the agent
     does its own reasoning on the content)

Security:
  - HTTPS only (HTTP auto-upgraded)
  - 30-second timeout
  - 500KB max response size
  - No file:// or internal URLs
  - User-Agent identifies the bot
"""

import re
from urllib.parse import urlparse

import httpx

from .base_tool import BaseTool

MAX_RESPONSE_SIZE = 500_000  # 500KB
MAX_CONTENT_LENGTH = 50_000  # chars returned to agent
TIMEOUT = 30.0


class WebFetchTool(BaseTool):

    name = "web_fetch"

    description = (
        "Fetch content from a URL. Returns the page text with HTML tags "
        "stripped. Use this to read documentation, API references, GitHub "
        "READMEs, blog posts, or any web page. Automatically upgrades "
        "HTTP to HTTPS. Max 500KB response."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": (
                        "The URL to fetch. Must be HTTPS (HTTP auto-upgraded). "
                        "Examples: 'https://docs.python.org/3/library/asyncio.html', "
                        "'https://github.com/user/repo/blob/main/README.md'"
                    )
                },
                "extract": {
                    "type": "string",
                    "description": (
                        "Optional: what to look for in the page. The full page "
                        "content is returned regardless, but this helps you "
                        "focus your analysis. Example: 'installation instructions'"
                    )
                }
            },
            "required": ["url"]
        }

    async def run(self, url, extract=None):
        # Validate and normalize URL
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https", ""):
            return {"error": f"Unsupported URL scheme: {parsed.scheme}. Use http or https."}

        if not parsed.netloc:
            return {"error": f"Invalid URL: {url}"}

        # Block internal/local URLs
        hostname = parsed.hostname or ""
        if hostname in ("localhost", "127.0.0.1", "0.0.0.0", "::1"):
            return {"error": "Cannot fetch local/internal URLs"}

        # Auto-upgrade to HTTPS
        if parsed.scheme == "http" or not parsed.scheme:
            url = url.replace("http://", "https://", 1)
            if not url.startswith("https://"):
                url = "https://" + url

        headers = {
            "User-Agent": "DevSphere-AI/1.0 (AI coding agent)",
            "Accept": "text/markdown, text/plain, text/html;q=0.9, */*;q=0.5",
        }

        try:
            # Try with SSL verification first, fall back to unverified
            # for corporate networks with custom CA certificates
            try:
                async with httpx.AsyncClient(
                    timeout=TIMEOUT,
                    follow_redirects=True,
                    max_redirects=5,
                ) as client:
                    response = await client.get(url, headers=headers)
            except httpx.ConnectError:
                async with httpx.AsyncClient(
                    timeout=TIMEOUT,
                    follow_redirects=True,
                    max_redirects=5,
                    verify=False,
                ) as client:
                    response = await client.get(url, headers=headers)

            if response.status_code != 200:
                return {
                    "error": f"HTTP {response.status_code}: {response.reason_phrase}",
                    "url": url,
                }

            content_type = response.headers.get("content-type", "")
            raw = response.text

            if len(raw) > MAX_RESPONSE_SIZE:
                raw = raw[:MAX_RESPONSE_SIZE]

            # Convert HTML to readable text
            if "text/html" in content_type:
                text = _html_to_text(raw)
            else:
                text = raw

            # Truncate for agent context
            if len(text) > MAX_CONTENT_LENGTH:
                text = text[:MAX_CONTENT_LENGTH] + f"\n\n[...truncated at {MAX_CONTENT_LENGTH} chars]"

            result = {
                "url": str(response.url),
                "status": response.status_code,
                "content_type": content_type.split(";")[0].strip(),
                "content_length": len(text),
                "content": text,
            }

            if extract:
                result["extract_hint"] = extract

            return result

        except httpx.TimeoutException:
            return {"error": f"Request timed out after {TIMEOUT}s", "url": url}
        except httpx.ConnectError as e:
            return {"error": f"Connection failed: {e}", "url": url}
        except Exception as e:
            return {"error": f"Fetch failed: {type(e).__name__}: {e}", "url": url}


def _html_to_text(html: str) -> str:
    """Convert HTML to readable plain text. No external dependencies."""
    # Remove script and style blocks
    text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL | re.IGNORECASE)

    # Convert common block elements to newlines
    text = re.sub(r'<br\s*/?>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'</(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote)>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<(h[1-6])[^>]*>', '\n## ', text, flags=re.IGNORECASE)

    # Convert links: <a href="url">text</a> → text (url)
    text = re.sub(r'<a[^>]*href=["\']([^"\']*)["\'][^>]*>(.*?)</a>',
                  r'\2 (\1)', text, flags=re.DOTALL | re.IGNORECASE)

    # Convert list items
    text = re.sub(r'<li[^>]*>', '- ', text, flags=re.IGNORECASE)

    # Convert code blocks
    text = re.sub(r'<pre[^>]*>', '\n```\n', text, flags=re.IGNORECASE)
    text = re.sub(r'</pre>', '\n```\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<code[^>]*>', '`', text, flags=re.IGNORECASE)
    text = re.sub(r'</code>', '`', text, flags=re.IGNORECASE)

    # Strip remaining tags
    text = re.sub(r'<[^>]+>', '', text)

    # Decode common HTML entities
    text = text.replace('&amp;', '&')
    text = text.replace('&lt;', '<')
    text = text.replace('&gt;', '>')
    text = text.replace('&quot;', '"')
    text = text.replace('&#39;', "'")
    text = text.replace('&nbsp;', ' ')

    # Clean up whitespace
    text = re.sub(r'\n\s*\n\s*\n', '\n\n', text)
    text = re.sub(r'[ \t]+', ' ', text)

    return text.strip()
