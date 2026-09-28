"""
Web Search Tool — Search the Web

Claude Code's WebSearch runs queries against Anthropic's search
backend. Our implementation uses DuckDuckGo's HTML search page
(no API key required, no external dependencies).

How it works:
  1. Send query to DuckDuckGo's lite HTML endpoint
  2. Parse result titles, URLs, and snippets with regex
  3. Return structured results

The agent can then use web_fetch on specific URLs to read full pages.

Limitations vs Claude Code:
  - No allowed_domains / blocked_domains filtering
  - Single search per call (no internal refinement)
  - Results quality depends on DuckDuckGo
"""

import re
from urllib.parse import quote_plus

import httpx

from .base_tool import BaseTool

TIMEOUT = 15.0
MAX_RESULTS = 10


class WebSearchTool(BaseTool):

    name = "web_search"

    description = (
        "Search the web for information. Returns result titles, URLs, "
        "and snippets. Use this to find documentation, Stack Overflow "
        "answers, API references, or any information not in the workspace. "
        "Follow up with web_fetch to read specific result pages."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "The search query. Be specific for better results. "
                        "Example: 'FastAPI WebSocket authentication tutorial'"
                    )
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of results to return (default: 5, max: 10)"
                }
            },
            "required": ["query"]
        }

    async def run(self, query, max_results=5):
        max_results = min(max_results or 5, MAX_RESULTS)

        url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"

        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
        }

        try:
            try:
                async with httpx.AsyncClient(
                    timeout=TIMEOUT,
                    follow_redirects=True,
                ) as client:
                    response = await client.get(url, headers=headers)
            except httpx.ConnectError:
                async with httpx.AsyncClient(
                    timeout=TIMEOUT,
                    follow_redirects=True,
                    verify=False,
                ) as client:
                    response = await client.get(url, headers=headers)

            if response.status_code != 200:
                return {
                    "error": f"Search failed: HTTP {response.status_code}",
                    "query": query,
                }

            results = _parse_duckduckgo_html(response.text, max_results)

            if not results:
                return {
                    "query": query,
                    "results": [],
                    "total": 0,
                    "message": f"No results found for '{query}'",
                }

            return {
                "query": query,
                "results": results,
                "total": len(results),
            }

        except httpx.TimeoutException:
            return {"error": f"Search timed out after {TIMEOUT}s", "query": query}
        except Exception as e:
            return {"error": f"Search failed: {type(e).__name__}: {e}", "query": query}


def _parse_duckduckgo_html(html: str, max_results: int) -> list:
    """Parse DuckDuckGo HTML search results into structured data."""
    results = []

    # DuckDuckGo lite page has results in <a class="result__a"> tags
    # and snippets in <a class="result__snippet"> tags
    result_blocks = re.findall(
        r'<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>'
        r'.*?'
        r'(?:<a[^>]*class="result__snippet"[^>]*>(.*?)</a>)?',
        html,
        re.DOTALL,
    )

    if not result_blocks:
        # Try alternate pattern for different DuckDuckGo page versions
        result_blocks = re.findall(
            r'<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*>(.*?)</a>',
            html,
            re.DOTALL,
        )

    for block in result_blocks[:max_results]:
        url = block[0] if len(block) > 0 else ""
        title = block[1] if len(block) > 1 else ""
        snippet = block[2] if len(block) > 2 else ""

        # Clean HTML from title and snippet
        title = re.sub(r'<[^>]+>', '', title).strip()
        snippet = re.sub(r'<[^>]+>', '', snippet).strip()

        # Skip DuckDuckGo internal URLs
        if not url or "duckduckgo.com" in url:
            continue

        # Decode DuckDuckGo redirect URLs
        if "uddg=" in url:
            match = re.search(r'uddg=([^&]+)', url)
            if match:
                from urllib.parse import unquote
                url = unquote(match.group(1))

        if title:
            results.append({
                "title": title[:200],
                "url": url,
                "snippet": snippet[:300] if snippet else "",
            })

    return results
