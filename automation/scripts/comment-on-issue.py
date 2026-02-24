#!/usr/bin/env python3
"""
Comment on GitHub Issue with agent results.

This script reads the agent execution result and posts a comment
to the specified GitHub Issue.

Usage:
    python comment-on-issue.py <issue_number>

Environment Variables:
    GITHUB_TOKEN - GitHub API token
    GITHUB_REPOSITORY - Repository in format "owner/repo"
    BASE_BRANCH - Base branch for diff (default: main). Use repo default branch in CI.
"""

import json
import logging
import os
import subprocess
import sys
from pathlib import Path

import requests

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


def find_latest_result(temp_dir: Path) -> dict:
    """Find and read the latest agent result file."""
    result_files = sorted(
        [f for f in temp_dir.rglob("agent-result-*.json")],
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )

    if not result_files:
        logger.error("No result file found in %s", temp_dir)
        return {
            "success": False,
            "generated_files": [],
            "errors": ["No result file found"],
        }

    logger.info("Found result file: %s", result_files[0])
    return json.loads(result_files[0].read_text(encoding="utf-8"))


# GitHub comment body limit (leave margin)
MAX_COMMENT_LENGTH = 60000


def _repo_root() -> Path:
    """Repo root (parent of automation/)."""
    return Path(__file__).resolve().parents[2]


def _read_file_content(file_path: Path) -> str | None:
    """Read file content if it exists."""
    try:
        if file_path.exists():
            return file_path.read_text(encoding="utf-8")
    except Exception as e:
        logger.warning("Could not read %s: %s", file_path, e)
    return None


def _normalize_path(path_str: str) -> str:
    """Extract path relative to repo root (handles full paths from Actions)."""
    if "profiles/" in path_str:
        return path_str[path_str.index("profiles/") :]
    if "automation/" in path_str and "profiles/" not in path_str:
        return path_str
    return path_str.replace("\\", "/").lstrip("/")


def _get_git_file_status(repo_root: Path, issue_number: int) -> dict[str, str]:
    """Get file status from git diff (base...PR branch). Returns path -> 'new'|'modified'|'unchanged'|'reused'.

    Diffs against origin/auto-profile-{issue_number} when it exists; falls back to HEAD otherwise.
    BASE_BRANCH env var configures the base (default: main).
    """
    status_map: dict[str, str] = {}
    base_branch = os.environ.get("BASE_BRANCH", "main").strip()
    pr_branch = f"origin/auto-profile-{issue_number}"

    # Prefer origin/base when base looks like a branch name
    base_refs = [f"origin/{base_branch}", base_branch] if base_branch else ["origin/main", "main"]

    for base_ref in base_refs:
        for pr_ref in (pr_branch, "HEAD"):
            try:
                result = subprocess.run(
                    ["git", "diff", "--name-status", f"{base_ref}...{pr_ref}"],
                    cwd=repo_root,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if result.returncode == 0:
                    for line in (result.stdout or "").strip().split("\n"):
                        if not line:
                            continue
                        parts = line.split("\t", 1)
                        if len(parts) == 2:
                            code, path = parts
                            path = path.replace("\\", "/")
                            if code == "A":
                                status_map[path] = "new"
                            elif code == "M":
                                status_map[path] = "modified"
                    return status_map
            except Exception as e:
                logger.debug("git diff %s...%s failed: %s", base_ref, pr_ref, e)
    return status_map


def _file_status_label(rel_path: str, status_map: dict[str, str]) -> str:
    """Return (new), (modified), (reused), or (unchanged) for display."""
    status = status_map.get(rel_path)
    if status == "new":
        return " (new)"
    if status == "modified":
        return " (modified)"
    # Not in diff: profile yaml = reused, others = unchanged
    if rel_path.endswith(".yaml") or rel_path.endswith(".yml"):
        return " (reused)"
    return " (unchanged)"


def build_comment_body(result: dict, issue_number: int) -> str:
    """Build the comment body from result."""
    lines = ["## Profile Generation Agent Results", ""]

    if result.get("success"):
        lines.extend(
            [
                "SUCCESS: Profile generated successfully!",
                "",
                f"**Generated {len(result.get('generated_files', []))} files:**",
            ]
        )
        generated = result.get("generated_files", [])
        repo_root = _repo_root()
        status_map = _get_git_file_status(repo_root, issue_number)
        for file in generated:
            rel = _normalize_path(file)
            label = _file_status_label(rel, status_map)
            lines.append(f"- `{rel}`{label}")

        # Render file contents in collapsible blocks (deduplicate by path)
        seen_paths: set[str] = set()
        for file in generated:
            rel_path = _normalize_path(file)
            if rel_path in seen_paths:
                continue
            seen_paths.add(rel_path)
            full_path = repo_root / rel_path
            content = _read_file_content(full_path)
            if content is not None:
                ext = Path(rel_path).suffix.lower()
                lang = "yaml" if ext in (".yaml", ".yml") else "json" if ext == ".json" else "markdown" if ext == ".md" else ""
                code_fence = f"```{lang}\n" if lang else "```\n"
                block = f"\n<details>\n<summary>{Path(rel_path).name}</summary>\n\n{code_fence}{content}\n```\n\n</details>\n"
                if len("\n".join(lines) + block) < MAX_COMMENT_LENGTH:
                    lines.append(block)
                else:
                    lines.append(f"\n<details><summary>{Path(rel_path).name}</summary>\n*(Content omitted - comment too long)*\n</details>\n")

        lines.extend(["", "A Pull Request has been created with these changes."])
    else:
        lines.extend(["FAILED: Profile generation failed", ""])
        if result.get("errors"):
            lines.append("**Errors:**")
            for error in result.get("errors", []):
                lines.append(f"- {error}")
        lines.extend(["", "Please check the workflow logs for more details."])

    return "\n".join(lines)


def post_comment(repo: str, issue_number: int, body: str, token: str) -> None:
    """Post comment to GitHub Issue."""
    url = f"https://api.github.com/repos/{repo}/issues/{issue_number}/comments"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
    }
    data = {"body": body}

    response = requests.post(url, headers=headers, json=data)
    response.raise_for_status()

    logger.info("Comment posted successfully to issue #%d", issue_number)


def main() -> int:
    """Main entry point."""
    if len(sys.argv) < 2:
        logger.error("Usage: python comment-on-issue.py <issue_number>")
        return 1

    issue_number = int(sys.argv[1])
    temp_dir = Path(__file__).parent.parent / "temp"

    logger.info("Processing issue #%d", issue_number)

    # Read result
    result = find_latest_result(temp_dir)

    # Build comment
    body = build_comment_body(result, issue_number)

    # Post comment
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    token = os.environ.get("GITHUB_TOKEN", "")

    if not repo or not token:
        logger.error("GITHUB_REPOSITORY and GITHUB_TOKEN must be set")
        return 1

    post_comment(repo, issue_number, body, token)

    return 0


if __name__ == "__main__":
    sys.exit(main())
