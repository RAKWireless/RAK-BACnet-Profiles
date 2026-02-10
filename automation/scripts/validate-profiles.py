#!/usr/bin/env python3
"""
Validate BACnet profiles using scripts/validate-profile.js.

Default: validate all *.yaml under profiles/<Vendor>/ (one level deep).
Optional: validate only generated files listed in automation/temp/generated-files-list.txt.
"""

from __future__ import annotations

import argparse
import logging
import subprocess
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


def _run_validator(validator: Path, profile_path: Path) -> int:
    result = subprocess.run(
        ["node", str(validator), str(profile_path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    output = result.stdout if result.stdout else result.stderr
    for line in output.strip().split("\n"):
        if line:
            logger.info(line)
    return result.returncode


def _collect_profiles(profiles_root: Path, one_level_only: bool) -> list[Path]:
    if one_level_only:
        profiles = []
        for vendor_dir in profiles_root.iterdir():
            if not vendor_dir.is_dir():
                continue
            for path in vendor_dir.glob("*.yaml"):
                profiles.append(path)
        return profiles
    return list(profiles_root.rglob("*.yaml"))


def _collect_generated(generated_list: Path) -> list[Path]:
    if not generated_list.exists():
        return []
    lines = [
        line.strip() for line in generated_list.read_text(encoding="utf-8").splitlines()
    ]
    return [Path(line) for line in lines if line.endswith(".yaml")]


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    validator = root / "scripts" / "validate-profile.js"
    profiles_root = root / "profiles"
    generated_list = root / "automation" / "temp" / "generated-files-list.txt"

    parser = argparse.ArgumentParser(description="Validate BACnet profile YAML files.")
    parser.add_argument(
        "--all",
        action="store_true",
        help="Validate all *.yaml under profiles (recursive).",
    )
    parser.add_argument(
        "--only-generated",
        action="store_true",
        help="Validate only files in generated-files-list.txt.",
    )
    parser.add_argument(
        "--one-level-only",
        action="store_true",
        help="Validate only profiles/<Vendor>/*.yaml.",
    )
    args = parser.parse_args()

    if args.only_generated:
        profiles = _collect_generated(generated_list)
    elif args.all:
        profiles = _collect_profiles(profiles_root, one_level_only=False)
    else:
        profiles = _collect_profiles(profiles_root, one_level_only=True)

    if not profiles:
        logger.error("No profiles found to validate.")
        return 1

    failed = 0
    for profile in profiles:
        logger.info(f"Validating: {profile}")
        code = _run_validator(validator, profile)
        if code != 0:
            failed += 1

    logger.info(f"Validation completed. Failed: {failed}/{len(profiles)}")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
