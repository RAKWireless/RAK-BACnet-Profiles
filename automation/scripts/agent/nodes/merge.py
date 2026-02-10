"""Merge results node - aggregates final results."""

import logging

from langchain_core.messages import AIMessage

from agent.state import DeviceProfile, OverallState

logger = logging.getLogger(__name__)


def merge_results_node(state: OverallState) -> dict:
    """Merge all device results - implements Scheme C (continue on failure)."""
    logger.info("Node: Merge results")

    devices = state.get("devices", [])
    successful, failed = _categorize_devices(devices)
    all_files = _collect_generated_files(successful)

    _log_summary(devices, successful, failed, all_files)

    return {
        "all_generated_files": all_files,
        "messages": [AIMessage(content=_build_summary_message(successful, failed))],
    }


def _categorize_devices(
    devices: list[DeviceProfile],
) -> tuple[list[DeviceProfile], list[DeviceProfile]]:
    """Separate devices into successful and failed lists."""
    successful = [d for d in devices if d.get("validation_passed")]
    failed = [d for d in devices if not d.get("validation_passed")]
    return successful, failed


def _collect_generated_files(devices: list[DeviceProfile]) -> list[str]:
    """Collect all generated files from successful devices."""
    files = []
    for device in devices:
        files.extend(device.get("generated_files", []))
    return files


def _log_summary(
    all_devices: list[DeviceProfile],
    successful: list[DeviceProfile],
    failed: list[DeviceProfile],
    all_files: list[str],
) -> None:
    """Log execution summary."""
    logger.info(
        f"Summary: {len(all_devices)} devices, "
        f"{len(successful)} successful, "
        f"{len(failed)} failed, "
        f"{len(all_files)} files"
    )

    if failed:
        logger.warning("Failed devices:")
        for device in failed:
            device_name = device.get("device_name", "unknown")
            errors = device.get("validation_errors", [])
            logger.warning(f"  - {device_name}: {errors}")


def _build_summary_message(
    successful: list[DeviceProfile], failed: list[DeviceProfile]
) -> str:
    """Build summary message for workflow completion."""
    summary = f"Completed: {len(successful)} succeeded, {len(failed)} failed"
    if failed:
        failed_names = [d.get("device_name", "unknown") for d in failed]
        summary += f"\nFailed devices: {', '.join(failed_names)}"
    return summary
