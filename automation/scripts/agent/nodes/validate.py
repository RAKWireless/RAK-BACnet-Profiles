"""Validate profile node - validates generated profiles."""

import logging

from agent.context import WorkflowContext
from agent.state import DeviceProfile, OverallState
from agent.utils import run_script

logger = logging.getLogger(__name__)


def validate_profile_node(state: OverallState, ctx: WorkflowContext) -> dict:
    """Validate profiles for all devices."""
    logger.info("Node: Validate profile")

    devices = state.get("devices", [])
    updated_devices = [_validate_single_device(device, ctx) for device in devices]

    return {"devices": updated_devices}


def _validate_single_device(
    device: DeviceProfile, ctx: WorkflowContext
) -> DeviceProfile:
    """Validate a single device profile."""
    device_name = device["device_name"]
    profile_path = device.get("profile_path")

    updated = ctx.copy_device(device)
    updated["validate_attempts"] = int(device.get("validate_attempts", 0)) + 1

    if not profile_path:
        return _mark_validation_skipped(updated, device_name)

    return _run_validation(updated, profile_path, device_name)


def _mark_validation_skipped(device: DeviceProfile, device_name: str) -> DeviceProfile:
    """Mark device as skipped when no profile exists."""
    logger.warning(f"No profile path for {device_name}, skipping validation")
    device["validation_passed"] = False
    device["validation_errors"] = ["Profile generation failed - no profile to validate"]
    return device


def _run_validation(
    device: DeviceProfile, profile_path: str, device_name: str
) -> DeviceProfile:
    """Run validation script on profile."""
    logger.info(f"Validating profile for {device_name}")
    success, output = run_script("validate-profile.js", profile_path)

    if success:
        return _mark_validation_passed(device, device_name)
    return _mark_validation_failed(device, device_name, output)


def _mark_validation_passed(device: DeviceProfile, device_name: str) -> DeviceProfile:
    """Mark device as validation passed."""
    logger.info(f"Validation passed for {device_name}")
    device["validation_passed"] = True
    device["validation_errors"] = []
    return device


def _mark_validation_failed(
    device: DeviceProfile, device_name: str, error: str
) -> DeviceProfile:
    """Mark device as validation failed."""
    logger.warning(f"Validation failed for {device_name}: {error}")
    device["validation_passed"] = False
    device["validation_errors"] = [error]
    return device
