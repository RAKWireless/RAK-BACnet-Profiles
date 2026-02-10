"""
Workflow state definitions for LangGraph.

This module defines the data structures that flow through the workflow.
LangGraph uses these TypedDict definitions to track state across nodes.

Context:
    - Used by: workflow.py, all node modules
    - Purpose: Type-safe state management
    - Key concepts:
        - DeviceProfile: Tracks a single device's processing state
        - OverallState: Global workflow state passed between nodes

State Flow:
    Parse Issue → Generate Profile → Generate Tests → Validate → Changelog → Merge
         ↓              ↓                ↓              ↓           ↓         ↓
    parsed_data   devices[]       devices[]      devices[]   devices[]   all_files[]
"""

from operator import add
from typing import Annotated, TypedDict
from langchain_core.messages import BaseMessage


def replace_devices(
    existing: list["DeviceProfile"], new: list["DeviceProfile"]
) -> list["DeviceProfile"]:
    """Replace devices list (for updates)."""
    return new


class DeviceProfile(TypedDict):
    """Single device profile processing state."""

    device_name: str
    device_info: dict
    profile_path: str | None
    profile_content: str | None
    validation_passed: bool
    validation_errors: list[str]
    validate_attempts: int
    test_data_path: str | None
    expected_output_path: str | None
    changelog_path: str | None
    generated_files: list[str]


class OverallState(TypedDict):
    """Overall workflow state."""

    issue_body: str
    issue_number: int
    parsed_data: dict | None
    devices: Annotated[list[DeviceProfile], replace_devices]
    all_generated_files: Annotated[list[str], add]
    errors: Annotated[list[str], add]
    messages: Annotated[list[BaseMessage], add]
