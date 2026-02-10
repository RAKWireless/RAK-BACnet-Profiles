#!/usr/bin/env python3
"""
Test all profiles using the validation script.

Scans profiles/ directory for all YAML files and runs node scripts/validate-profile.js on each.
Reports pass/fail summary at the end.
"""

import logging
import subprocess
import sys
import os
from pathlib import Path

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Ensure UTF-8 encoding for Windows console output
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except AttributeError:
        # Python < 3.7, fallback to setting environment variable
        os.environ["PYTHONIOENCODING"] = "utf-8"

# Script location: automation/scripts/test-all-profiles.py
# Project root: automation/../ (two levels up)
SCRIPT_DIR = Path(__file__).parent
AUTOMATION_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = AUTOMATION_DIR.parent

VALIDATE_SCRIPT = PROJECT_ROOT / "scripts" / "validate-profile.js"
PROFILES_DIR = PROJECT_ROOT / "profiles"


def find_all_profile_yamls(profiles_dir: Path) -> list[Path]:
    """
    Find all YAML files under profiles/ directory.
    Excludes non-profile files like 7201_V2_modify_0619.yaml (based on naming pattern).
    """
    yamls = []
    for yaml_file in profiles_dir.rglob("*.yaml"):
        # Skip files in tests/ subdirectories (test data, not profiles)
        if "tests" in yaml_file.parts:
            continue
        yamls.append(yaml_file)
    return sorted(yamls)


def validate_profile(
    profile_path: Path, validate_script: Path, project_root: Path
) -> tuple[bool, str]:
    """
    Run node scripts/validate-profile.js on a profile YAML file.

    Returns:
        (success: bool, output: str)
    """
    if not validate_script.exists():
        return False, f"Error: Validation script not found: {validate_script}"
    if not profile_path.exists():
        return False, f"Error: Profile file not found: {profile_path}"
    try:
        result = subprocess.run(
            ["node", str(validate_script), str(profile_path)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(project_root),
            timeout=60,
        )
        output = (result.stdout or "").strip()
        stderr = (result.stderr or "").strip()
        combined = f"{output}\n{stderr}".strip() if stderr else output
        return result.returncode == 0, combined or (
            "Validation passed" if result.returncode == 0 else "Validation failed"
        )
    except subprocess.TimeoutExpired:
        return False, "Error: Validation timed out (60s)"
    except FileNotFoundError:
        return (
            False,
            "Error: Node.js not found. Install Node.js or run in an environment that has node.",
        )
    except Exception as e:
        return False, f"Error running validation: {e}"


def main() -> int:
    """
    Main entry point: find all profiles and validate each one.
    """
    if not VALIDATE_SCRIPT.exists():
        logger.error(f"Validation script not found: {VALIDATE_SCRIPT}")
        logger.error(f"Expected at: {VALIDATE_SCRIPT}")
        return 1
    if not PROFILES_DIR.exists():
        logger.error(f"Profiles directory not found: {PROFILES_DIR}")
        return 1

    profile_files = find_all_profile_yamls(PROFILES_DIR)
    if not profile_files:
        logger.error(f"No YAML files found in {PROFILES_DIR}")
        return 1

    logger.info(f"Found {len(profile_files)} profile(s) to validate")

    passed = []
    failed = []

    for i, profile_path in enumerate(profile_files, 1):
        rel_path = profile_path.relative_to(PROJECT_ROOT)
        logger.info(f"[{i}/{len(profile_files)}] Validating {rel_path}...")
        success, output = validate_profile(profile_path, VALIDATE_SCRIPT, PROJECT_ROOT)
        if success:
            logger.info(f"[{i}/{len(profile_files)}] {rel_path}: PASS")
            passed.append((rel_path, output))
        else:
            logger.error(f"[{i}/{len(profile_files)}] {rel_path}: FAIL")
            failed.append((rel_path, output))
            # Log error details for failed profiles
            if output and "Error" not in output[:50]:
                logger.error(f"  Output: {output[:200]}...")

    # Summary
    logger.info("=" * 60)
    logger.info(
        f"Summary: {len(passed)} passed, {len(failed)} failed out of {len(profile_files)} total"
    )

    if failed:
        logger.error("Failed profiles:")
        for rel_path, output in failed:
            logger.error(f"  - {rel_path}")
            if output:
                error_lines = output.split("\n")[:3]
                for line in error_lines:
                    if line.strip():
                        logger.error(f"    {line[:100]}")
        return 1

    logger.info("All profiles validated successfully!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
