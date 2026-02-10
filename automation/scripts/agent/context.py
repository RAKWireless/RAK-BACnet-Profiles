"""
Workflow context for managing run state.

This module provides WorkflowContext class that encapsulates per-run state
(file paths, counters) to avoid global variables. Each workflow run gets
its own context instance.

Context:
    - Used by: All node functions (passed as parameter)
    - Purpose: Dependency injection, testability, no global state
    - Lifecycle: Created in main.py → passed to all nodes → persists for one run

Why not global variables?
    - Global state makes testing hard
    - Can't run multiple workflows concurrently
    - Hidden dependencies between functions
"""

import time
from pathlib import Path

from agent.config import TEMP_ROOT_DIR
from agent.state import DeviceProfile


class WorkflowContext:
    """Encapsulates workflow state and utilities to avoid global variables."""

    def __init__(self):
        self.run_dir: Path | None = None
        self.generated_files_list: Path | None = None

    def setup(self, issue_number: int) -> None:
        """Setup context for a new run."""
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        self.run_dir = TEMP_ROOT_DIR / f"run-{issue_number}-{timestamp}"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.generated_files_list = self.run_dir / "generated-files-list.txt"

        self._clear_generated_files_list()

    def _clear_generated_files_list(self) -> None:
        """Clear the generated files list if it exists."""
        if self.generated_files_list and self.generated_files_list.exists():
            self.generated_files_list.unlink()

    def save_file(self, file_path: Path, content: str) -> None:
        """Save file and register it in the generated files list."""
        if self.generated_files_list is None:
            raise RuntimeError("Context not initialized. Call setup() first.")

        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content, encoding="utf-8")
        self._register_file(file_path)

    def _register_file(self, file_path: Path) -> None:
        """Register a file in the generated files list."""
        with open(self.generated_files_list, "a", encoding="utf-8") as f:
            f.write(f"{file_path}\n")

    def copy_device(self, device: DeviceProfile, **overrides) -> DeviceProfile:
        """Create a copy of device profile with optional field overrides.

        Args:
            device: Source device profile
            **overrides: Fields to override in the copy

        Returns:
            New DeviceProfile with copied values and applied overrides
        """
        # Start with shallow copy of all fields
        copied = {**device}

        # Deep copy mutable fields to avoid shared references
        copied["generated_files"] = list(device.get("generated_files", []))
        copied["validation_errors"] = list(device.get("validation_errors", []))

        # Apply overrides
        copied.update(overrides)

        return DeviceProfile(**copied)
