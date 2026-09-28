"""Git provider utilities for Code Builder source control.

Supported providers in this module: GitHub, Azure DevOps, and GitLab.

The local repository metadata is isolated in ``.devaccel`` instead of ``.git``
to avoid collisions with the parent workspace repository.
"""

import asyncio
import json as _json
import os
import re
import shutil
import subprocess
import tempfile
from urllib.parse import quote, urlparse, urlunparse
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from uuid import uuid4
from typing import Optional

from common_utils.logging_config import get_logger

log = get_logger(__name__)

# ── Custom git-dir name (never ".git") ────────────────────────────────────
DEVACCEL_GIT_DIR = ".devaccel"


class GitProvider(str, Enum):
    GITHUB = "github"
    AZURE_DEVOPS = "azure_devops"
    GITLAB = "gitlab"


@dataclass
class GitRepoConfig:
    """Configuration for a remote Git repository."""
    provider: str  # "github", "azure_devops", or "gitlab"
    repo_url: str  # HTTPS clone URL
    default_branch: str = "main"
    # Auth
    pat_token: str = ""  # Personal Access Token
    username: str = ""   # Used by GitLab basic auth flows
    # Azure DevOps specific
    org_url: str = ""  # e.g. https://dev.azure.com/myorg
    project: str = ""  # ADO project name

    @property
    def authenticated_url(self) -> str:
        """Return the repo URL with embedded credentials for HTTPS auth.

        Handles ADO old-format URLs that already contain userinfo
        (e.g. ``https://OrgName@dev.azure.com/...``) by stripping
        existing credentials before inserting the PAT.
        """
        if not self.pat_token:
            return self.repo_url

        safe_token = quote(self.pat_token, safe="")

        # Strip any existing userinfo from the URL to avoid double-@ issues
        clean_url = self._strip_userinfo(self.repo_url)

        if self.provider == GitProvider.GITHUB:
            return re.sub(
                r"^https://",
                f"https://{safe_token}@",
                clean_url,
            )
        elif self.provider == GitProvider.AZURE_DEVOPS:
            return re.sub(
                r"^https://",
                f"https://{safe_token}@",
                clean_url,
            )
        elif self.provider == GitProvider.GITLAB:
            # GitLab PATs always use oauth2:TOKEN@ format.
            # username:TOKEN@ is only for Deploy Tokens (no @ in name).
            if self.username and "@" not in self.username:
                safe_user = quote(self.username, safe="")
                return re.sub(
                    r"^https://",
                    f"https://{safe_user}:{safe_token}@",
                    clean_url,
                )
            return re.sub(
                r"^https://",
                f"https://oauth2:{safe_token}@",
                clean_url,
            )
        return self.repo_url

    @staticmethod
    def _strip_userinfo(url: str) -> str:
        """Remove any existing user:pass@ or user@ from the URL."""
        try:
            parsed = urlparse(url)
            if parsed.username or parsed.password:
                # Rebuild without userinfo
                netloc = parsed.hostname or ""
                if parsed.port:
                    netloc += f":{parsed.port}"
                cleaned = parsed._replace(netloc=netloc)
                return urlunparse(cleaned)
        except Exception:
            pass
        return url


@dataclass
class GitResult:
    """Result of a Git operation."""
    success: bool
    message: str
    data: dict = field(default_factory=dict)


def _has_devaccel_repo(repo_dir: str) -> bool:
    """Check if a .devaccel git directory exists in repo_dir."""
    return Path(repo_dir).joinpath(DEVACCEL_GIT_DIR).exists()


_META_FILE = "devaccel_meta.json"


def _write_devaccel_meta(repo_dir: str, provider: str) -> None:
    """Write provider metadata to .devaccel/devaccel_meta.json."""
    meta_path = Path(repo_dir) / DEVACCEL_GIT_DIR / _META_FILE
    try:
        meta_path.write_text(_json.dumps({"provider": provider}), encoding="utf-8")
    except Exception:
        pass  # non-critical


def read_devaccel_meta(repo_dir: str) -> dict:
    """Read provider metadata from .devaccel/devaccel_meta.json."""
    meta_path = Path(repo_dir) / DEVACCEL_GIT_DIR / _META_FILE
    try:
        return _json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _git_dir_args(repo_dir: str) -> list[str]:
    """Return --git-dir and --work-tree args that point to .devaccel."""
    git_dir = str(Path(repo_dir) / DEVACCEL_GIT_DIR)
    return ["--git-dir", git_dir, "--work-tree", repo_dir]


def _isolation_env(repo_dir: str) -> dict[str, str]:
    """Env vars that prevent git from ever discovering a parent .git."""
    return {
        "GIT_CEILING_DIRECTORIES": str(Path(repo_dir).parent),
        "GIT_TERMINAL_PROMPT": "0",
    }


async def _run_git(
    args: list[str],
    cwd: str,
    env_extra: Optional[dict] = None,
) -> GitResult:
    """Run a git command asynchronously and return the result."""
    env = {**os.environ}
    env.update(_isolation_env(cwd))
    if env_extra:
        env.update(env_extra)

    cmd = ["git", "-c", "core.longpaths=true"] + args
    # Redact tokens from log output
    safe_cmd = " ".join(args).replace(env.get("_PAT", "NOPAT"), "***")
    log.info("git_command", cmd=safe_cmd, cwd=cwd)

    try:
        def _run_blocking() -> subprocess.CompletedProcess:
            return subprocess.run(
                cmd,
                cwd=cwd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                timeout=120,
                check=False,
            )

        proc = await asyncio.to_thread(_run_blocking)
        stdout = (proc.stdout or "").strip()
        stderr = (proc.stderr or "").strip()

        if proc.returncode != 0:
            log.warning("git_failed", returncode=proc.returncode, stderr=stderr)
            return GitResult(
                success=False,
                message=_enterprise_git_error(stderr, proc.returncode),
            )

        return GitResult(success=True, message=stdout)

    except subprocess.TimeoutExpired:
        log.error("git_timeout", cmd=safe_cmd)
        return GitResult(success=False, message="Source control operation timed out. Please retry.")
    except FileNotFoundError:
        return GitResult(success=False, message="Git is not available on this server environment.")
    except Exception as exc:
        err_detail = f"{type(exc).__name__}: {exc}"
        log.error("git_error", error=err_detail)
        return GitResult(success=False, message=_enterprise_git_error(err_detail, 1))


def _enterprise_git_error(stderr: str, returncode: int) -> str:
    """Map raw git stderr to end-user friendly enterprise-safe messages."""
    text = (stderr or "").lower()
    if "authentication failed" in text or "invalid username or password" in text:
        return "Authentication failed. Verify your source control credentials."
    if "could not resolve host" in text or "name or service not known" in text:
        return "Unable to reach the source control host. Check network and repository URL."
    if "repository not found" in text or ("does not appear to be a git repository" in text):
        return "Repository could not be located. Verify repository access and URL."
    if "couldn't find remote ref" in text or "remote ref does not exist" in text:
        return "Requested branch was not found in the remote repository."
    if "not allowed to download code" in text:
        return (
            "Access denied — your token does not have permission to download code. "
            "For GitLab, ensure your PAT includes the 'read_repository' scope."
        )
    if "non-fast-forward" in text or ("rejected" in text and ("push" in text or "fetch first" in text)):
        return "Push was rejected because the remote has newer changes. Pull and retry."
    if "rejected" in text:
        return "Source control update was rejected. Refresh and retry the operation."
    if "merge conflict" in text or "conflict" in text:
        return "Pull resulted in merge conflicts. Resolve conflicts and try again."
    if "permission denied" in text or "access denied" in text:
        return "Access denied for this repository operation."
    if "winerror 32" in text or "being used by another process" in text or "in use" in text:
        return "Local repository workspace is currently in use. Close open file handles and retry."
    if "no such file or directory" in text:
        return "Repository workspace path is unavailable on the server."
    if returncode:
        # Include the original message for debugging — strip credentials
        safe_msg = stderr.replace("\n", " ").strip()
        if len(safe_msg) > 200:
            safe_msg = safe_msg[:200] + "…"
        return f"Source control operation failed (exit {returncode}): {safe_msg}" if safe_msg else "Source control operation failed. Please retry or contact support if it persists."
    return "Source control operation could not be completed."


# ═══════════════════════════════════════════════════════════════════════════
#  CLONE  — creates a .devaccel repo (not .git)
# ═══════════════════════════════════════════════════════════════════════════

async def clone_repo(
    config: GitRepoConfig,
    target_dir: str,
    branch: Optional[str] = None,
) -> GitResult:
    """Clone a repository into target_dir using .devaccel as the git directory.

    Steps:
      1. Clone into a temp dir (standard .git)
      2. Move .git → .devaccel inside target_dir
    This ensures the working tree never has a .git folder.
    """
    url = config.authenticated_url
    td = Path(target_dir)

    # Wipe any previous workspace content
    if td.exists():
        try:
            shutil.rmtree(td)
        except Exception as exc:
            log.warning("clone_workspace_busy", target_dir=target_dir, error=str(exc))
            return GitResult(
                success=False,
                message="Local repository workspace is in use. Close files/processes and retry pull.",
            )
    td.mkdir(parents=True, exist_ok=True)

    # Clone into a temp sibling dir so we get a standard .git
    tmp_clone = td.parent / f".tmp_clone_{td.name}"
    if tmp_clone.exists():
        shutil.rmtree(tmp_clone, ignore_errors=True)

    # If a specific branch was requested, clone with --branch.
    # Otherwise clone without --branch so git uses the remote's default.
    if branch:
        clone_args = ["clone", "--branch", branch, "--single-branch", url, str(tmp_clone)]
    else:
        clone_args = ["clone", url, str(tmp_clone)]

    result = await _run_git(clone_args, cwd=str(td.parent))

    if not result.success:
        # Clean up any partial clone before returning
        if tmp_clone.exists():
            shutil.rmtree(tmp_clone, ignore_errors=True)
        return result

    # Detect which branch was actually checked out
    detect = await _run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=str(tmp_clone))
    actual_branch = detect.message if detect.success and detect.message else (branch or config.default_branch)

    # Move all files (except .git) into target_dir
    for item in tmp_clone.iterdir():
        if item.name == ".git":
            continue
        dest = td / item.name
        shutil.move(str(item), str(dest))

    # Rename .git → .devaccel and move into target_dir
    src_git = tmp_clone / ".git"
    dst_devaccel = td / DEVACCEL_GIT_DIR
    if src_git.exists():
        shutil.move(str(src_git), str(dst_devaccel))

    # Clean up temp dir
    if tmp_clone.exists():
        shutil.rmtree(tmp_clone, ignore_errors=True)

    # Ensure .devaccel is in the local exclude so it never shows in status
    _ensure_devaccel_excluded(target_dir)

    # Track which provider owns this clone
    _write_devaccel_meta(target_dir, config.provider)

    result.message = f"Cloned {config.repo_url} (branch: {actual_branch}) → .devaccel"
    result.data = {"branch": actual_branch, "directory": target_dir}
    return result


# ═══════════════════════════════════════════════════════════════════════════
#  PULL
# ═══════════════════════════════════════════════════════════════════════════

async def pull(
    config: GitRepoConfig,
    repo_dir: str,
    branch: Optional[str] = None,
) -> GitResult:
    """Pull latest changes from remote using the .devaccel git directory."""
    if not _has_devaccel_repo(repo_dir):
        return GitResult(success=False, message="No .devaccel repository found — pull first to clone")

    gd = _git_dir_args(repo_dir)

    # Set remote URL (with credentials)
    await _run_git(gd + ["remote", "set-url", "origin", config.authenticated_url], cwd=repo_dir)

    # If no branch specified, detect the current branch from the local repo
    if not branch:
        head_result = await _run_git(gd + ["rev-parse", "--abbrev-ref", "HEAD"], cwd=repo_dir)
        if head_result.success and head_result.message and head_result.message != "HEAD":
            branch = head_result.message

    # Fetch — always fetch all so remote tracking refs are up to date
    fetch_result = await _run_git(gd + ["fetch", "origin"], cwd=repo_dir)
    if not fetch_result.success:
        return fetch_result

    # If a specific branch was requested, verify it exists on the remote
    if branch:
        check = await _run_git(gd + ["rev-parse", "--verify", f"origin/{branch}"], cwd=repo_dir)
        if not check.success:
            # Branch doesn't exist on remote — report clearly
            return GitResult(
                success=False,
                message=f"Branch '{branch}' does not exist on the remote. Check the branch name and try again.",
                data={"branch": branch},
            )
    else:
        # Auto-detect the remote default branch
        remote_head = await _run_git(gd + ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], cwd=repo_dir)
        if remote_head.success and remote_head.message:
            branch = remote_head.message.replace("origin/", "")
        else:
            # Pick any remote branch
            br_list = await _run_git(gd + ["branch", "-r", "--format=%(refname:short)"], cwd=repo_dir)
            if br_list.success:
                for b in br_list.message.splitlines():
                    cleaned = b.replace("origin/", "").strip()
                    if cleaned and cleaned != "HEAD":
                        branch = cleaned
                        break
            if not branch:
                branch = config.default_branch

    # Checkout the branch
    checkout_result = await _run_git(gd + ["checkout", branch], cwd=repo_dir)
    if not checkout_result.success:
        checkout_result = await _run_git(
            gd + ["checkout", "-b", branch, f"origin/{branch}"], cwd=repo_dir
        )
        if not checkout_result.success:
            return checkout_result

    # Force-sync local branch to match remote exactly.
    reset_result = await _run_git(gd + ["reset", "--hard", f"origin/{branch}"], cwd=repo_dir)
    if not reset_result.success:
        return reset_result

    await _run_git(gd + ["clean", "-fd"], cwd=repo_dir)

    # Track which provider owns this clone
    _write_devaccel_meta(repo_dir, config.provider)

    return GitResult(
        success=True,
        message=f"Pulled latest from origin/{branch}",
        data={"branch": branch},
    )


# ═══════════════════════════════════════════════════════════════════════════
#  PUSH
# ═══════════════════════════════════════════════════════════════════════════

async def push(
    config: GitRepoConfig,
    repo_dir: str,
    branch: Optional[str] = None,
    commit_message: str = "Code generated by DevAccel AI Code Builder",
) -> GitResult:
    """Stage all changes, commit and push to remote using .devaccel."""
    if not _has_devaccel_repo(repo_dir):
        return GitResult(success=False, message="No .devaccel repository found — pull first to clone")

    gd = _git_dir_args(repo_dir)

    # Set remote URL
    await _run_git(gd + ["remote", "set-url", "origin", config.authenticated_url], cwd=repo_dir)

    branch = branch or config.default_branch

    # Ensure we're on the right branch
    current = await _run_git(gd + ["rev-parse", "--abbrev-ref", "HEAD"], cwd=repo_dir)
    if current.success and current.message != branch:
        checkout = await _run_git(gd + ["checkout", "-B", branch], cwd=repo_dir)
        if not checkout.success:
            return checkout

    # Ensure .devaccel is excluded before staging
    _ensure_devaccel_excluded(repo_dir)

    # Stage all changes
    add_result = await _run_git(gd + ["add", "-A"], cwd=repo_dir)
    if not add_result.success:
        return add_result

    # Check if there are staged changes
    diff_result = await _run_git(gd + ["diff", "--cached", "--quiet"], cwd=repo_dir)
    if not diff_result.success:
        # Has staged changes → commit
        commit_result = await _run_git(
            gd + ["commit", "-m", commit_message],
            cwd=repo_dir,
        )
        if not commit_result.success:
            return commit_result

    # Check if there are any commits at all
    has_commits = await _run_git(gd + ["rev-parse", "HEAD"], cwd=repo_dir)
    if not has_commits.success:
        return GitResult(
            success=False,
            message="Nothing to push — workspace has no files. Pull or create files first.",
            data={"branch": branch},
        )

    # Always push to remote (remote may not have local commits yet)
    result = await _run_git(gd + ["push", "origin", branch, "--set-upstream"], cwd=repo_dir)
    if result.success:
        result.message = f"Pushed to origin/{branch}"
        result.data = {"branch": branch}
    return result


# ═══════════════════════════════════════════════════════════════════════════
#  BRANCH OPERATIONS
# ═══════════════════════════════════════════════════════════════════════════


def _gitlab_api_base_and_project(repo_url: str) -> tuple[str, str] | None:
    """Extract the GitLab base URL and project path from a repo URL.

    Returns (base_url, project_path) where project_path uses forward slashes.
    E.g. ``https://gitlab.example.com/sub/group/repo.git``
      → (``https://gitlab.example.com/sub``, ``group/repo``)
    """
    parsed = urlparse(repo_url.strip().rstrip("/"))
    if not parsed.scheme or not parsed.netloc:
        return None
    path = parsed.path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    if not path:
        return None
    segments = [s for s in path.split("/") if s]
    if len(segments) < 2:
        return None
    return f"{parsed.scheme}://{parsed.netloc}", segments


async def _gitlab_api_list_branches(config: GitRepoConfig) -> GitResult | None:
    """List branches using the GitLab REST API (works with read_api scope).

    Uses the project search approach to get the numeric project ID first
    (avoids %2F encoding issues that break enterprise proxies), then fetches
    branches by numeric ID.

    Returns None if the config is not GitLab or can't be parsed.
    """
    if config.provider != GitProvider.GITLAB or not config.pat_token:
        return None

    parsed = _gitlab_api_base_and_project(config.repo_url)
    if not parsed:
        return None

    scheme_host, segments = parsed

    import urllib.request
    import urllib.error
    import ssl

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    headers = {
        "PRIVATE-TOKEN": config.pat_token,
        "Authorization": f"Bearer {config.pat_token}",
        "Accept": "application/json",
    }

    def _do_request() -> GitResult:
        project_name = segments[-1]

        # Try each possible base URL prefix
        for i in range(len(segments)):
            base = scheme_host + (("/" + "/".join(segments[:i])) if i > 0 else "")
            project_path = "/".join(segments[i:])

            # Step 1: Search for the project by name to get numeric ID
            search_url = (
                f"{base}/api/v4/projects"
                f"?search={quote(project_name, safe='')}&per_page=20"
            )
            log.info("gitlab_api_search", base=base, search_url=search_url[:120])

            req = urllib.request.Request(search_url)
            for k, v in headers.items():
                req.add_header(k, v)

            try:
                with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
                    data = _json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                log.info("gitlab_api_search_failed", base=base, status=e.code)
                continue
            except Exception as exc:
                log.info("gitlab_api_search_error", base=base, error=str(exc))
                continue

            if not isinstance(data, list):
                continue

            # Find project matching our expected path
            numeric_id = None
            access_level = None
            for p in data:
                pwn = (p.get("path_with_namespace") or "").lower()
                if pwn == project_path.lower():
                    numeric_id = p.get("id")
                    perms = p.get("permissions") or {}
                    pa = perms.get("project_access") or {}
                    access_level = pa.get("access_level")
                    break

            if numeric_id is None:
                candidates = [p.get("path_with_namespace") for p in data]
                log.info("gitlab_api_project_not_matched",
                         expected=project_path, candidates=candidates)
                continue

            # Step 2: Fetch branches using numeric ID (no %2F issues)
            branches_url = f"{base}/api/v4/projects/{numeric_id}/repository/branches?per_page=100"
            log.info("gitlab_api_branches_by_id", url=branches_url[:120])

            req2 = urllib.request.Request(branches_url)
            for k, v in headers.items():
                req2.add_header(k, v)

            try:
                with urllib.request.urlopen(req2, timeout=15, context=ctx) as resp2:
                    bdata = _json.loads(resp2.read().decode("utf-8"))
                    branches = [b["name"] for b in bdata if isinstance(b, dict) and "name" in b]
                    return GitResult(
                        success=True,
                        message=f"{len(branches)} branch(es) found via GitLab API",
                        data={"branches": sorted(branches)},
                    )
            except urllib.error.HTTPError as e:
                body = ""
                try:
                    body = e.read().decode("utf-8", errors="replace")[:200]
                except Exception:
                    pass
                log.warning("gitlab_api_branches_failed", status=e.code, body=body,
                            access_level=access_level)
                if e.code == 403 and access_level is not None and access_level < 20:
                    level_names = {10: "Guest", 20: "Reporter", 30: "Developer",
                                   40: "Maintainer", 50: "Owner"}
                    lvl = level_names.get(access_level, str(access_level))
                    return GitResult(
                        success=False,
                        message=(
                            f"GitLab repository access denied — your access level is '{lvl}' "
                            f"(level {access_level}). Repository read requires at least 'Reporter' "
                            f"(level 20). Ask a project Maintainer/Owner to upgrade your role."
                        ),
                    )
                continue
            except Exception as exc:
                log.warning("gitlab_api_branches_error", error=str(exc))
                continue

        return GitResult(success=False, message="GitLab API branch listing failed for all base URL candidates")

    return await asyncio.to_thread(_do_request)


async def list_branches(
    config: GitRepoConfig,
    repo_dir: Optional[str] = None,
) -> GitResult:
    """List remote branches. Uses git ls-remote first; for GitLab, falls back
    to the REST API if git fails (e.g. token lacks read_repository scope)."""

    url = config.authenticated_url
    tmp = Path(os.environ.get("TEMP", "/tmp")) / "devaccel_git_ls"
    tmp.mkdir(parents=True, exist_ok=True)
    result = await _run_git(["ls-remote", "--heads", url], cwd=str(tmp))
    if result.success:
        branches = []
        for line in result.message.splitlines():
            parts = line.split("\t")
            if len(parts) == 2 and parts[1].startswith("refs/heads/"):
                branches.append(parts[1].replace("refs/heads/", ""))
        result.message = "\n".join(branches)

    if result.success:
        branches = [
            b.replace("origin/", "")
            for b in result.message.splitlines()
            if b and b != "origin/HEAD"
        ]
        result.data = {"branches": sorted(set(branches))}
        result.message = f"{len(branches)} branch(es) found"
        return result

    # GitLab fallback: use REST API when git ls-remote fails
    if config.provider == GitProvider.GITLAB:
        log.info("gitlab_git_failed_trying_api", git_error=result.message[:100])
        api_result = await _gitlab_api_list_branches(config)
        if api_result and api_result.success:
            return api_result
        # Return the API error if it has a more specific message (e.g. access level info)
        if api_result and api_result.message and "access level" in api_result.message:
            return api_result
        # Generic fallback
        return GitResult(
            success=False,
            message=(
                "GitLab access denied. Your token may lack the 'read_repository' scope "
                "required for git operations. Branch listing via API also failed. "
                "Update your GitLab PAT with 'read_repository' and 'api' scopes."
            ),
        )

    return result


def _build_tree_from_paths(paths: list[str]) -> list[dict]:
    """Build a folder/file tree from repository-relative paths."""
    root: dict[str, dict] = {}
    for raw in paths:
        path = raw.strip().replace("\\", "/")
        if not path:
            continue
        parts = [p for p in path.split("/") if p]
        node = root
        current_parts: list[str] = []
        for index, part in enumerate(parts):
            current_parts.append(part)
            is_last = index == len(parts) - 1
            if is_last:
                node.setdefault(part, {
                    "name": part,
                    "path": "/".join(current_parts),
                    "type": "file",
                })
            else:
                folder = node.setdefault(part, {
                    "name": part,
                    "path": "/".join(current_parts),
                    "type": "folder",
                    "children": {},
                })
                node = folder["children"]

    def serialize(children: dict[str, dict]) -> list[dict]:
        entries = list(children.values())
        entries.sort(key=lambda item: (item["type"] == "file", item["name"].lower()))
        result: list[dict] = []
        for item in entries:
            if item["type"] == "folder":
                result.append({
                    "name": item["name"],
                    "path": item["path"],
                    "type": "folder",
                    "children": serialize(item["children"]),
                })
            else:
                result.append({
                    "name": item["name"],
                    "path": item["path"],
                    "type": "file",
                })
        return result

    return serialize(root)


async def preview_remote_tree(
    config: GitRepoConfig,
    branch: Optional[str] = None,
    max_files: int = 10000,
) -> GitResult:
    """Preview remote repository files without creating a local .devaccel clone."""
    tmp_parent = Path(tempfile.gettempdir()) / "devaccel_git_preview"
    tmp_parent.mkdir(parents=True, exist_ok=True)
    tmp_clone = tmp_parent / f"preview_{uuid4().hex}"

    try:
        clone_args = ["clone", "--depth", "1", "--filter=blob:none", "--no-checkout"]
        if branch:
            clone_args += ["--branch", branch]
        clone_args += [config.authenticated_url, str(tmp_clone)]

        clone_result = await _run_git(clone_args, cwd=str(tmp_parent))
        if not clone_result.success:
            return clone_result

        branch_result = await _run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=str(tmp_clone))
        detected_branch = branch_result.message if branch_result.success and branch_result.message else (branch or config.default_branch)

        files_result = await _run_git(["ls-tree", "-r", "--name-only", "HEAD"], cwd=str(tmp_clone))
        if not files_result.success:
            return files_result

        paths = [line.strip() for line in files_result.message.splitlines() if line.strip()]
        if len(paths) > max_files:
            paths = paths[:max_files]

        tree = _build_tree_from_paths(paths)
        return GitResult(
            success=True,
            message=f"Previewed {len(paths)} file(s) from remote branch '{detected_branch}'",
            data={
                "tree": tree,
                "count": len(paths),
                "branch": detected_branch,
                "truncated": len(paths) >= max_files,
            },
        )
    finally:
        if tmp_clone.exists():
            shutil.rmtree(tmp_clone, ignore_errors=True)


async def preview_remote_file_content(
    config: GitRepoConfig,
    file_path: str,
    branch: Optional[str] = None,
) -> GitResult:
    """Read a remote file without persisting a local repository workspace."""
    tmp_parent = Path(tempfile.gettempdir()) / "devaccel_git_preview"
    tmp_parent.mkdir(parents=True, exist_ok=True)
    tmp_clone = tmp_parent / f"preview_{uuid4().hex}"

    try:
        clone_args = ["clone", "--depth", "1", "--filter=blob:none", "--no-checkout"]
        if branch:
            clone_args += ["--branch", branch]
        clone_args += [config.authenticated_url, str(tmp_clone)]

        clone_result = await _run_git(clone_args, cwd=str(tmp_parent))
        if not clone_result.success:
            return clone_result

        safe_path = str(Path(file_path).as_posix()).lstrip("/")
        if not safe_path or safe_path.startswith(".."):
            return GitResult(success=False, message="Invalid remote file path")

        show_result = await _run_git(["show", f"HEAD:{safe_path}"], cwd=str(tmp_clone))
        if not show_result.success:
            return show_result

        branch_result = await _run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=str(tmp_clone))
        detected_branch = branch_result.message if branch_result.success and branch_result.message else (branch or config.default_branch)

        return GitResult(
            success=True,
            message=f"Previewed remote file '{safe_path}' from branch '{detected_branch}'",
            data={
                "path": safe_path,
                "content": show_result.message,
                "branch": detected_branch,
            },
        )
    finally:
        if tmp_clone.exists():
            shutil.rmtree(tmp_clone, ignore_errors=True)


async def current_branch(repo_dir: str) -> GitResult:
    """Get the current branch name from the .devaccel repo."""
    if not _has_devaccel_repo(repo_dir):
        return GitResult(success=False, message="No .devaccel repository found")
    gd = _git_dir_args(repo_dir)
    result = await _run_git(gd + ["rev-parse", "--abbrev-ref", "HEAD"], cwd=repo_dir)
    if result.success:
        result.data = {"branch": result.message}
    return result


async def git_status(repo_dir: str) -> GitResult:
    """Get short git status from the .devaccel repo."""
    if not _has_devaccel_repo(repo_dir):
        return GitResult(success=False, message="No .devaccel repository found")
    gd = _git_dir_args(repo_dir)

    # Ensure .devaccel is excluded so git never reports internal metadata
    _ensure_devaccel_excluded(repo_dir)

    result = await _run_git(gd + ["status", "--porcelain"], cwd=repo_dir)
    if result.success:
        changes = []
        for line in result.message.splitlines():
            if len(line) >= 3:
                status_code = line[:2].strip()
                file_path = line[3:]
                # Skip internal git metadata paths
                if file_path.startswith(".devaccel") or file_path.startswith(DEVACCEL_GIT_DIR):
                    continue
                status_map = {
                    "A": "added", "M": "modified", "D": "deleted",
                    "??": "untracked", "AM": "added", "MM": "modified",
                }
                changes.append({
                    "path": file_path,
                    "status": status_map.get(status_code, "modified"),
                })
        result.data = {"changes": changes, "total": len(changes)}
        result.message = f"{len(changes)} change(s)"
    return result


def _ensure_devaccel_excluded(repo_dir: str) -> None:
    """Add .devaccel to the repo's local exclude file so git ignores it."""
    exclude_dir = Path(repo_dir) / DEVACCEL_GIT_DIR / "info"
    exclude_file = exclude_dir / "exclude"
    try:
        exclude_dir.mkdir(parents=True, exist_ok=True)
        existing = exclude_file.read_text(encoding="utf-8") if exclude_file.exists() else ""
        if ".devaccel" not in existing:
            with open(exclude_file, "a", encoding="utf-8") as f:
                f.write("\n.devaccel\n")
    except Exception:
        pass  # best-effort — the filter in git_status still catches them


async def init_repo(
    repo_dir: str,
    config: Optional[GitRepoConfig] = None,
    branch: str = "main",
) -> GitResult:
    """Initialize a new .devaccel git repo in the given directory."""
    Path(repo_dir).mkdir(parents=True, exist_ok=True)

    git_dir_path = str(Path(repo_dir) / DEVACCEL_GIT_DIR)

    # Init with separate git-dir
    result = await _run_git(
        ["init", "--separate-git-dir", git_dir_path, "--initial-branch", branch],
        cwd=repo_dir,
    )
    if not result.success:
        # Fallback for older git without --initial-branch
        result = await _run_git(
            ["init", "--separate-git-dir", git_dir_path],
            cwd=repo_dir,
        )
        if result.success:
            gd = _git_dir_args(repo_dir)
            await _run_git(gd + ["checkout", "-b", branch], cwd=repo_dir)

    # git init --separate-git-dir creates a .git file (pointer), remove it
    pointer = Path(repo_dir) / ".git"
    if pointer.is_file():
        pointer.unlink()

    if result.success and config:
        gd = _git_dir_args(repo_dir)
        await _run_git(
            gd + ["remote", "add", "origin", config.authenticated_url],
            cwd=repo_dir,
        )

    if result.success:
        result.message = f"Initialized .devaccel repository on branch {branch}"
        result.data = {"branch": branch}
    return result


async def checkout_branch(
    config: GitRepoConfig,
    repo_dir: str,
    branch: str,
    create: bool = False,
) -> GitResult:
    """Checkout (or create) a branch using .devaccel."""
    if not _has_devaccel_repo(repo_dir):
        return GitResult(success=False, message="No .devaccel repository found")

    gd = _git_dir_args(repo_dir)

    await _run_git(gd + ["remote", "set-url", "origin", config.authenticated_url], cwd=repo_dir)

    if create:
        result = await _run_git(gd + ["checkout", "-b", branch], cwd=repo_dir)
    else:
        result = await _run_git(gd + ["checkout", branch], cwd=repo_dir)
        if not result.success:
            await _run_git(gd + ["fetch", "origin", branch], cwd=repo_dir)
            result = await _run_git(
                gd + ["checkout", "-b", branch, f"origin/{branch}"], cwd=repo_dir
            )

    if result.success:
        result.message = f"Switched to branch '{branch}'"
        result.data = {"branch": branch}
    return result


# Helper functions used by Code Builder settings -> git config resolution.


def build_config_from_settings(
    settings: dict,
    provider: Optional[str] = None,
) -> Optional[GitRepoConfig]:
    """Build a GitRepoConfig from project settings.

    Supported providers in this resolver: GitHub, Azure DevOps, and GitLab.
    """
    ado_integration = settings.get("azure_devops_config") or {}

    multi = settings.get("git_configs") or {}
    if provider and provider in (
        GitProvider.GITHUB,
        GitProvider.AZURE_DEVOPS,
        GitProvider.GITLAB,
    ) and provider in multi:
        cfg = multi[provider]
        return _build_one_with_ado_fallback(cfg, provider, ado_integration)

    if not provider:
        for prov, cfg in multi.items():
            if prov not in (
                GitProvider.GITHUB,
                GitProvider.AZURE_DEVOPS,
                GitProvider.GITLAB,
            ):
                continue
            built = _build_one_with_ado_fallback(cfg, prov, ado_integration)
            if built:
                return built

    git_cfg = settings.get("git_config")
    if git_cfg:
        prov = git_cfg.get("provider", "")
        if prov not in (
            GitProvider.GITHUB,
            GitProvider.AZURE_DEVOPS,
            GitProvider.GITLAB,
        ):
            return None
        if provider and prov != provider:
            pass
        else:
            built = _build_one_with_ado_fallback(git_cfg, prov, ado_integration)
            if built:
                return built

    # Legacy GitLab integration support
    if not provider or provider == GitProvider.GITLAB:
        gitlab_cfg = settings.get("gitlab_config") or {}
        git_urls = gitlab_cfg.get("git_urls") or []
        valid_urls = [u for u in git_urls if u and _looks_like_git_url(u)]
        repo_url = next((u for u in valid_urls if u.endswith(".git")), valid_urls[0] if valid_urls else "")
        if repo_url:
            return GitRepoConfig(
                provider=GitProvider.GITLAB,
                repo_url=repo_url,
                default_branch="main",
                pat_token=gitlab_cfg.get("access_token", ""),
                username=gitlab_cfg.get("username", ""),
            )

    return None


def get_available_providers(settings: dict) -> list[dict]:
    """Return configured source-control providers for Code Builder."""
    providers: list[dict] = []
    seen_providers: set[str] = set()

    multi = settings.get("git_configs") or {}
    for prov, cfg in multi.items():
        if prov not in (
            GitProvider.GITHUB,
            GitProvider.AZURE_DEVOPS,
            GitProvider.GITLAB,
        ):
            continue
        if cfg.get("repo_url"):
            providers.append(
                {
                    "provider": prov,
                    "repo_url": cfg.get("repo_url", ""),
                    "default_branch": cfg.get("default_branch", "main"),
                }
            )
            seen_providers.add(prov)

    git_cfg = settings.get("git_config")
    if git_cfg and git_cfg.get("repo_url"):
        prov = git_cfg.get("provider", "")
        if prov in (
            GitProvider.GITHUB,
            GitProvider.AZURE_DEVOPS,
            GitProvider.GITLAB,
        ) and prov not in seen_providers:
            providers.append(
                {
                    "provider": prov,
                    "repo_url": git_cfg.get("repo_url", ""),
                    "default_branch": git_cfg.get("default_branch", "main"),
                }
            )
            seen_providers.add(prov)

    if GitProvider.GITLAB not in seen_providers:
        gitlab_cfg = settings.get("gitlab_config") or {}
        git_urls = gitlab_cfg.get("git_urls") or []
        valid_urls = [u for u in git_urls if u and _looks_like_git_url(u)]
        repo_url = next((u for u in valid_urls if u.endswith(".git")), valid_urls[0] if valid_urls else "")
        if gitlab_cfg.get("access_token"):
            if repo_url:
                providers.append(
                    {
                        "provider": GitProvider.GITLAB,
                        "repo_url": repo_url,
                        "default_branch": "main",
                    }
                )
            else:
                providers.append(
                    {
                        "provider": GitProvider.GITLAB,
                        "repo_url": "",
                        "default_branch": "main",
                        "needs_repo_url": True,
                    }
                )

    ado_cfg = settings.get("azure_devops_config") or {}
    if "azure_devops" not in seen_providers and ado_cfg.get("pat_token"):
        ado_org_url = ado_cfg.get("org_url", "")
        ado_repo_url = ado_org_url if ado_org_url and "/_git/" in ado_org_url else ""
        if ado_repo_url:
            providers.append(
                {
                    "provider": "azure_devops",
                    "repo_url": ado_repo_url,
                    "default_branch": "main",
                    "org_url": ado_org_url,
                    "project": ado_cfg.get("project", ""),
                }
            )
        else:
            providers.append(
                {
                    "provider": "azure_devops",
                    "repo_url": "",
                    "default_branch": "main",
                    "org_url": ado_org_url,
                    "project": ado_cfg.get("project", ""),
                    "needs_repo_url": True,
                }
            )

    return providers


def _build_one_with_ado_fallback(
    cfg: dict,
    provider: str,
    ado_integration: dict,
) -> Optional[GitRepoConfig]:
    """Build a GitRepoConfig, inheriting ADO credentials when needed."""
    repo_url = cfg.get("repo_url", "")
    if not provider or not repo_url:
        return None

    pat = cfg.get("pat_token", "")
    org = cfg.get("org_url", "")
    project = cfg.get("project", "")

    if provider == "azure_devops" and ado_integration:
        if not pat:
            pat = ado_integration.get("pat_token", "")
        if not org:
            org = ado_integration.get("org_url", "")
        if not project:
            project = ado_integration.get("project", "")

    return GitRepoConfig(
        provider=provider,
        repo_url=repo_url,
        default_branch=cfg.get("default_branch", "main"),
        pat_token=pat,
        org_url=org,
        project=project,
        username=cfg.get("username", ""),
    )


def _looks_like_git_url(url: str) -> bool:
    """Best-effort validation that URL resembles a git repository URL."""
    from urllib.parse import urlparse

    try:
        parsed = urlparse(url.strip().rstrip("/"))
        if not parsed.scheme or not parsed.netloc:
            return False
        path = parsed.path.strip("/")
        if not path:
            return False
        if "/" not in path and not url.strip().endswith(".git"):
            return False
        return True
    except Exception:
        return False
