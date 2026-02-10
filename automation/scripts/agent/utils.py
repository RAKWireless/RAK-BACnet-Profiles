"""Script execution utilities."""

import subprocess
import sys

from agent.config import WORKSPACE_ROOT, SCRIPTS_DIR


def run_script(script_name: str, *args, script_type: str = "node") -> tuple[bool, str]:
    """Run a script (Node.js or Python) and return (success, output)."""
    cmd = _build_command(script_name, args, script_type)
    if not cmd:
        return False, f"Unknown script type: {script_type}"
    return _execute_command(cmd)


def _build_command(script_name: str, args: tuple, script_type: str) -> list[str] | None:
    """Build command list for script execution."""
    if script_type == "node":
        script_path = SCRIPTS_DIR / script_name
        return ["node", str(script_path), *args]
    elif script_type == "python":
        script_path = WORKSPACE_ROOT / "automation" / "scripts" / "tools" / script_name
        return [sys.executable, str(script_path), *args]
    return None


def _execute_command(cmd: list[str]) -> tuple[bool, str]:
    """Execute command and return result."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=str(WORKSPACE_ROOT),
            timeout=60,
        )
        return _parse_result(result)
    except Exception as e:
        return False, str(e)


def _parse_result(result: subprocess.CompletedProcess) -> tuple[bool, str]:
    """Parse subprocess result."""
    success = result.returncode == 0
    stdout = result.stdout or ""
    stderr = result.stderr or ""
    output = stdout if success else (stderr if stderr.strip() else stdout)
    return success, output


def load_skill(skill_name: str) -> str:
    """Load SKILL.md content."""
    from agent.config import SKILLS_DIR

    skill_path = SKILLS_DIR / skill_name / "SKILL.md"
    if not skill_path.exists():
        return f"Skill {skill_name} not found"
    return skill_path.read_text(encoding="utf-8")


def slugify(text: str) -> str:
    """Convert text to slug format."""
    return "-".join([t for t in text.replace("/", "-").split() if t]).strip("-")
