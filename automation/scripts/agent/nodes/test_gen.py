"""Generate tests node - creates test data and expected outputs."""

import json
import logging
from pathlib import Path

from agent.context import WorkflowContext
from agent.state import DeviceProfile, OverallState
from agent.template import extract_hex_bytes
from agent.utils import run_script

logger = logging.getLogger(__name__)


def generate_tests_node(state: OverallState, ctx: WorkflowContext) -> dict:
    """Generate test data for all devices."""
    logger.info("Node: Generate tests")

    devices = state.get("devices", [])
    updated_devices = [_generate_tests_for_device(device, ctx) for device in devices]

    return {"devices": updated_devices}


def _generate_tests_for_device(
    device: DeviceProfile, ctx: WorkflowContext
) -> DeviceProfile:
    """Generate tests for a single device."""
    if not device.get("profile_path"):
        return device

    return _create_test_files(device, ctx)


def _create_test_files(device: DeviceProfile, ctx: WorkflowContext) -> DeviceProfile:
    """Create test data and expected output files."""
    profile_path = Path(device["profile_path"])
    tests_dir = profile_path.parent / "tests"
    tests_dir.mkdir(parents=True, exist_ok=True)

    test_data_path = _save_test_data(device, tests_dir, ctx)
    expected_path = _generate_expected_output(device, test_data_path, tests_dir, ctx)

    return _update_device_with_test_paths(device, test_data_path, expected_path)


def _save_test_data(
    device: DeviceProfile, tests_dir: Path, ctx: WorkflowContext
) -> Path:
    """Save test data JSON file."""
    test_data = _build_test_data(device)
    test_data_path = tests_dir / "test-data.json"
    ctx.save_file(test_data_path, json.dumps(test_data, indent=2, ensure_ascii=False))
    return test_data_path


def _build_test_data(device: DeviceProfile) -> dict:
    """Build test data structure from device info."""
    device_name = device["device_name"]
    uplink_data = device["device_info"].get("uplinkData", "")

    return {
        "device": device_name,
        "testCases": [
            {
                "name": "Issue example",
                "model": device_name,
                "fPort": 2,
                "input": extract_hex_bytes(uplink_data),
            }
        ],
    }


def _generate_expected_output(
    device: DeviceProfile,
    test_data_path: Path,
    tests_dir: Path,
    ctx: WorkflowContext,
) -> Path | None:
    """Generate expected output JSON using validation script."""
    profile_path = device["profile_path"]
    success, output = run_script(
        "generate-expected-output.js", profile_path, str(test_data_path)
    )

    expected_path = tests_dir / "expected-output.json"

    if success:
        logger.info(f"Generated expected output for {device['device_name']}")
        ctx.save_file(expected_path, expected_path.read_text(encoding="utf-8"))
        return expected_path

    logger.error(
        f"Failed to generate expected output for {device['device_name']}: {output}"
    )
    return None


def _update_device_with_test_paths(
    device: DeviceProfile, test_data_path: Path, expected_path: Path | None
) -> DeviceProfile:
    """Update device with test file paths."""
    updated = device.copy()
    updated["test_data_path"] = str(test_data_path)

    if expected_path:
        updated["expected_output_path"] = str(expected_path)
        updated["generated_files"] = list(device.get("generated_files", [])) + [
            str(test_data_path),
            str(expected_path),
        ]

    return updated
