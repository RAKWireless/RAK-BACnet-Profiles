"""Generate changelog node - creates changelog files."""

import logging
from datetime import date
from pathlib import Path

from agent.context import WorkflowContext
from agent.state import DeviceProfile, OverallState

logger = logging.getLogger(__name__)


def generate_changelog_node(state: OverallState, ctx: WorkflowContext) -> dict:
    """Generate changelog for all devices."""
    logger.info("Node: Generate changelog")

    devices = state.get("devices", [])
    updated_devices = [
        _generate_changelog_for_device(device, ctx) for device in devices
    ]

    return {"devices": updated_devices}


def _generate_changelog_for_device(
    device: DeviceProfile, ctx: WorkflowContext
) -> DeviceProfile:
    """Generate changelog for a single device."""
    if not device.get("profile_path"):
        return device

    return _create_changelog_file(device, ctx)


def _create_changelog_file(
    device: DeviceProfile, ctx: WorkflowContext
) -> DeviceProfile:
    """Create changelog file for device."""
    device_name = device["device_name"]
    profile_path = Path(device["profile_path"])
    changelog_path = profile_path.parent / "CHANGELOG.md"

    logger.info(f"Generating changelog for {device_name}")

    content = _build_changelog_content(device_name)
    ctx.save_file(changelog_path, content)

    return _update_device_with_changelog(device, changelog_path)


def _build_changelog_content(device_name: str) -> str:
    """Build changelog content."""
    today = date.today()
    return f"""# Changelog - {device_name}

## [1.0.0] - {today}

### Added
- Initial BACnet profile for {device_name}
- Codec functions for data encoding/decoding
- Test data and expected outputs
"""


def _update_device_with_changelog(
    device: DeviceProfile, changelog_path: Path
) -> DeviceProfile:
    """Update device with changelog path."""
    updated = device.copy()
    updated["changelog_path"] = str(changelog_path)
    updated["generated_files"] = list(device.get("generated_files", [])) + [
        str(changelog_path)
    ]
    return updated
