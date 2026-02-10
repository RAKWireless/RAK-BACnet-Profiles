"""
Workflow routing logic.

This module determines the flow of execution through the workflow graph.
After validation, it decides whether to retry failed devices or continue
to changelog generation.

Context:
    - Used by: workflow.py (conditional edges)
    - Triggered: After validate_profile node completes
    - Decisions:
        - "parse_issue" -> retry generation (if attempts < MAX_RETRY_ATTEMPTS)
        - "generate_changelog" -> continue to final steps

Retry Logic:
    - MAX_RETRY_ATTEMPTS = 2 means: initial attempt + 1 retry
    - Failed devices loop back to parse_issue with preserved state
    - Passed devices continue forward
"""

import logging

from agent.config import MAX_RETRY_ATTEMPTS
from agent.state import OverallState

logger = logging.getLogger(__name__)


def route_after_validate(state: OverallState) -> str:
    """Route after validation - check if any device needs retry."""
    devices = state.get("devices", [])

    for device in devices:
        if _needs_retry(device):
            logger.info(
                f"Retrying generation for {device['device_name']} "
                f"(attempt {device.get('validate_attempts', 0) + 1})"
            )
            return "parse_issue"

    logger.info("Max retries reached or all passed, continuing to changelog")
    return "generate_changelog"


def _needs_retry(device: dict) -> bool:
    """Check if device needs retry."""
    attempts = int(device.get("validate_attempts", 0))
    passed = device.get("validation_passed", False)
    return not passed and attempts < MAX_RETRY_ATTEMPTS
