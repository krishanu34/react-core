"""
DevSphere MCP integration.

NOTE ON THE FOLDER NAME: this package is `mcp_integration`, NOT `mcp`. The app
runs with `devsphere_ai/` on sys.path (uvicorn router.apis:app), so a top-level
package named `mcp` here would SHADOW the installed `mcp` PyPI SDK and break
`import mcp`. Keeping our name distinct lets both coexist:

    from mcp import ClientSession            # the SDK
    from mcp_integration.config import ...   # our code

See README.md in this folder for the layout.
"""
