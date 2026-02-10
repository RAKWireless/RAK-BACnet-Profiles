"""Parse issue node - extracts device info and generates profiles."""

import json
import logging

from langchain_core.messages import AIMessage

from agent.config import MAX_RETRY_ATTEMPTS, PROFILES_DIR, MODEL_NAME_PRIMARY
from agent.context import WorkflowContext
from agent.llm import create_llm, create_profile_prompt, create_profile_user_prompt
from agent.state import DeviceProfile, OverallState
from agent.template import select_template_path
from agent.utils import load_skill, run_script, slugify

logger = logging.getLogger(__name__)


def parse_issue_node(state: OverallState, ctx: WorkflowContext) -> dict:
    """Parse GitHub Issue and generate all profiles sequentially."""
    logger.info("Node: Parse issue")

    parsed_data = _parse_issue_body(state, ctx)
    if not parsed_data:
        return _create_error_result("Parse issue failed")

    devices = _generate_profiles_for_devices(parsed_data, state.get("devices", []), ctx)

    return _create_success_result(parsed_data, devices)


def _parse_issue_body(state: OverallState, ctx: WorkflowContext) -> dict | None:
    """Parse issue body and extract device information."""
    _save_issue_body(state["issue_body"], ctx)
    return _run_parse_script(ctx)


def _save_issue_body(issue_body: str, ctx: WorkflowContext) -> None:
    """Save issue body to temporary file."""
    if ctx.run_dir is None:
        raise RuntimeError("Context not initialized. Call setup() first.")
    issue_file = ctx.run_dir / "current-issue-body.txt"
    issue_file.write_text(issue_body, encoding="utf-8")


def _run_parse_script(ctx: WorkflowContext) -> dict | None:
    """Run parse script to extract device info."""
    parsed_file = ctx.run_dir / "parsed-issue.json"
    issue_file = ctx.run_dir / "current-issue-body.txt"
    success, output = run_script(
        "parse_issue.py", str(issue_file), str(parsed_file), script_type="python"
    )

    if not success:
        logger.error(f"Parse script failed: {output}")
        return None

    return json.loads(parsed_file.read_text(encoding="utf-8"))


def _generate_profiles_for_devices(
    parsed_data: dict, existing_devices: list[DeviceProfile], ctx: WorkflowContext
) -> list[DeviceProfile]:
    """Generate profiles for all devices in parsed data."""
    devices = []
    existing_map = {d["device_name"]: d for d in existing_devices}

    for device_info in parsed_data.get("devices", []):
        device_info = _enrich_device_info(device_info)
        device = _process_single_device(device_info, existing_map, ctx)
        devices.append(device)

    return devices


def _enrich_device_info(device_info: dict) -> dict:
    """Enrich device info with normalized name."""
    vendor = slugify(device_info.get("vendor", "Unknown"))
    model = slugify(device_info.get("model", "Unknown"))
    device_info["name"] = f"{vendor}-{model}"
    device_info["vendor"] = vendor
    device_info["model"] = model
    return device_info


def _process_single_device(
    device_info: dict, existing_map: dict, ctx: WorkflowContext
) -> DeviceProfile:
    """Process a single device - either use existing or generate new profile."""
    device_name = device_info["name"]

    if device_name in existing_map:
        existing = existing_map[device_name]
        if _should_use_existing(existing):
            logger.info(f"Keeping existing profile for {device_name}")
            return existing
        logger.info(f"Retrying generation for {device_name}")

    return _generate_or_error(device_info, existing_map, ctx)


def _should_use_existing(existing: DeviceProfile) -> bool:
    """Check if existing device should be reused."""
    attempts = int(existing.get("validate_attempts", 0))
    return existing.get("validation_passed", False) or attempts >= MAX_RETRY_ATTEMPTS


def _generate_or_error(
    device_info: dict, existing_map: dict, ctx: WorkflowContext
) -> DeviceProfile:
    """Generate profile or return error state."""
    try:
        return _generate_single_profile(device_info, existing_map, ctx)
    except Exception as e:
        logger.error(f"Failed to generate profile for {device_info['name']}: {e}")
        return _create_error_device(device_info, existing_map)


def _generate_single_profile(
    device_info: dict, existing_map: dict, ctx: WorkflowContext
) -> DeviceProfile:
    """Generate profile for a single device using LLM."""
    device_name = device_info["name"]
    logger.info(f"Generating profile for {device_name}")

    yaml_content = _call_llm_for_profile(device_info)
    profile_path = _save_generated_profile(device_info, yaml_content, ctx)

    return _create_device_profile(
        device_name, device_info, profile_path, yaml_content, existing_map
    )


def _call_llm_for_profile(device_info: dict) -> str:
    """Call LLM to generate profile YAML."""
    skill = load_skill("generate-profile")
    device_json = json.dumps(device_info, indent=2, ensure_ascii=False)
    template_path = select_template_path(device_info)
    template_content = (
        template_path.read_text(encoding="utf-8") if template_path.exists() else ""
    )

    llm = create_llm(MODEL_NAME_PRIMARY)
    system_msg = create_profile_prompt(skill, device_json, template_content)
    user_msg = create_profile_user_prompt()
    response = llm.invoke([system_msg, user_msg])

    return _clean_yaml_content(response.content)


def _clean_yaml_content(content: str) -> str:
    """Remove markdown code blocks from YAML content."""
    content = content.strip()
    if content.startswith("```"):
        lines = content.split("\n")
        content = "\n".join(lines[1:-1]) if len(lines) > 2 else content
    return content


def _save_generated_profile(
    device_info: dict, yaml_content: str, ctx: WorkflowContext
) -> Path:
    """Save generated profile to file."""
    vendor = device_info["vendor"]
    model = device_info["model"]
    profile_path = PROFILES_DIR / vendor / f"{vendor}-{model}.yaml"
    ctx.save_file(profile_path, yaml_content)
    return profile_path


def _create_device_profile(
    device_name: str,
    device_info: dict,
    profile_path: Path,
    yaml_content: str,
    existing_map: dict,
) -> DeviceProfile:
    """Create DeviceProfile with preserved attempt count if retrying."""
    attempts = _get_preserved_attempts(device_name, existing_map)

    return DeviceProfile(
        device_name=device_name,
        device_info=device_info,
        profile_path=str(profile_path),
        profile_content=yaml_content,
        generated_files=[str(profile_path)],
        validation_passed=False,
        validation_errors=[],
        validate_attempts=attempts,
        test_data_path=None,
        expected_output_path=None,
        changelog_path=None,
    )


def _get_preserved_attempts(device_name: str, existing_map: dict) -> int:
    """Get preserved attempt count from existing device."""
    if device_name in existing_map:
        return int(existing_map[device_name].get("validate_attempts", 0))
    return 0


def _create_error_device(device_info: dict, existing_map: dict) -> DeviceProfile:
    """Create error state device profile."""
    device_name = device_info.get("name", "unknown")
    attempts = _get_preserved_attempts(device_name, existing_map)

    return DeviceProfile(
        device_name=device_name,
        device_info=device_info,
        profile_path=None,
        profile_content=None,
        generated_files=[],
        validation_passed=False,
        validation_errors=["Profile generation failed"],
        validate_attempts=attempts,
        test_data_path=None,
        expected_output_path=None,
        changelog_path=None,
    )


def _create_error_result(error_message: str) -> dict:
    """Create error result dict."""
    return {
        "errors": [error_message],
        "parsed_data": None,
        "devices": [],
    }


def _create_success_result(parsed_data: dict, devices: list[DeviceProfile]) -> dict:
    """Create success result dict."""
    num_devices = len(parsed_data.get("devices", []))
    return {
        "parsed_data": parsed_data,
        "devices": devices,
        "messages": [
            AIMessage(
                content=f"Parsed {num_devices} devices, generated {len(devices)} profiles"
            )
        ],
    }
