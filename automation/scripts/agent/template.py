"""
Template selection based on content similarity.

This module provides smart template selection by comparing device requirements
against existing profiles. Uses a weighted scoring algorithm to find the best
matching template.

Context:
    - Used by: nodes/parse.py (before calling LLM)
    - Input: Device info (vendor, model, sensor types)
    - Output: Path to best matching template YAML file

Scoring Algorithm:
    - Device type matching: 40% (water/air/climate/etc.)
    - BACnet object types: 30% (analog/binary inputs)
    - Sensor count: 20% (how many sensors)
    - LoRaWAN class: 10% (Class A/B/C)

Why template selection?
    - LLM performs better with reference examples
    - Ensures consistent profile structure
    - Reduces generation errors

The default hex bytes "01 64 00 C8" represent sample LoRaWAN uplink data:
    - 0x01: Sensor type ID (temperature/humidity sensor)
    - 0x64 (100): Temperature value (divide by 100 = 1.00°C)
    - 0x00C8 (200): Humidity value (divide by 100 = 2.00%)
Used when issue doesn't provide hex example data.
"""

import functools
import logging
import re
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)

from agent.config import (
    PROFILES_DIR,
    WORKSPACE_ROOT,
    DEVICE_TYPE_KEYWORDS,
    SENSOR_KEYWORDS,
    WEIGHT_DEVICE_TYPE,
    WEIGHT_OBJECT_TYPE_ANALOG,
    WEIGHT_OBJECT_TYPE_BINARY,
    WEIGHT_SENSOR_COUNT,
    WEIGHT_LORAWAN_CLASS,
)


def select_template_path(device_info: dict) -> Path:
    """Select best matching template based on content similarity."""
    profiles = _load_all_profile_features()
    if not profiles:
        return _get_default_template_path()
    return _find_best_match(device_info, profiles)


def _get_default_template_path() -> Path:
    """Get default template path."""
    return WORKSPACE_ROOT / "examples" / "standard-profile" / "profile.yaml"


def _find_best_match(device_info: dict, profiles: list[dict]) -> Path:
    """Find best matching template from profiles."""
    scored_profiles = [
        (profile, _calculate_similarity(device_info, profile)) for profile in profiles
    ]
    scored_profiles.sort(key=lambda x: x[1], reverse=True)

    if scored_profiles:
        best_match = scored_profiles[0]
        return best_match[0]["path"]

    return _get_default_template_path()


@functools.lru_cache(maxsize=1)
def _load_all_profile_features() -> list[dict]:
    """Load and cache features from all existing profiles."""
    features = []
    for profile_path in PROFILES_DIR.rglob("*.yaml"):
        if _should_skip_profile(profile_path):
            continue
        feature = _extract_profile_features(profile_path)
        if feature:
            features.append(feature)
    return features


def _should_skip_profile(profile_path: Path) -> bool:
    """Check if profile should be skipped."""
    return profile_path.name == "profile.yaml" or "tests" in str(profile_path)


def _extract_profile_features(profile_path: Path) -> dict | None:
    """Extract features from a profile file."""
    try:
        content = yaml.safe_load(profile_path.read_text(encoding="utf-8"))
        if not content:
            return None
        return _build_feature_dict(profile_path, content)
    except Exception as e:
        logger.warning(f"Failed to extract features from {profile_path}: {e}")
        return None


def _build_feature_dict(profile_path: Path, content: dict) -> dict:
    """Build feature dictionary from profile content."""
    return {
        "path": profile_path,
        "vendor": content.get("vendor", "").lower(),
        "model": content.get("model", "").lower(),
        "name": content.get("name", "").lower(),
        "device_type": _extract_device_type(content),
        "object_types": _extract_object_types(content),
        "object_count": len(content.get("datatype", {})),
        "lorawan_class": content.get("lorawan", {}).get("deviceClass", ["A"]),
    }


def _extract_device_type(content: dict) -> list[str]:
    """Extract device type keywords from profile content."""
    text = f"{content.get('name', '')} {content.get('model', '')}".lower()
    keywords = set()
    for category, words in DEVICE_TYPE_KEYWORDS.items():
        if any(word in text for word in words):
            keywords.add(category)
    return list(keywords)


def _extract_object_types(content: dict) -> list[str]:
    """Extract BACnet object types from datatype section."""
    types = set()
    datatype = content.get("datatype", {})
    for key, value in datatype.items():
        if isinstance(value, dict):
            obj_type = value.get("type", "")
            if obj_type:
                types.add(obj_type)
    return list(types)


def _calculate_similarity(device_info: dict, profile: dict) -> float:
    """Calculate similarity score between device and profile."""
    score = 0.0
    device_text = _build_device_text(device_info)
    profile_types = set(profile.get("device_type", []))

    score += _calculate_device_type_score(device_text, profile_types)
    score += _calculate_object_type_score(device_info, profile)
    score += _calculate_sensor_count_score(device_info, profile)
    score += _calculate_lorawan_class_score(device_info, profile)

    return score


def _build_device_text(device_info: dict) -> str:
    """Build searchable text from device info."""
    return f"{device_info.get('vendor', '')} {device_info.get('model', '')} {device_info.get('bacnetMapping', '')}".lower()


def _calculate_device_type_score(device_text: str, profile_types: set) -> float:
    """Calculate device type matching score."""
    for category, words in DEVICE_TYPE_KEYWORDS.items():
        if category in profile_types and any(word in device_text for word in words):
            return WEIGHT_DEVICE_TYPE
    return 0.0


def _calculate_object_type_score(device_info: dict, profile: dict) -> float:
    """Calculate object type matching score."""
    score = 0.0
    device_mapping = device_info.get("bacnetMapping", "").lower()
    profile_objects = set(profile.get("object_types", []))

    if "analog" in device_mapping and any("Analog" in obj for obj in profile_objects):
        score += WEIGHT_OBJECT_TYPE_ANALOG
    if "binary" in device_mapping and any("Binary" in obj for obj in profile_objects):
        score += WEIGHT_OBJECT_TYPE_BINARY

    return score


def _calculate_sensor_count_score(device_info: dict, profile: dict) -> float:
    """Calculate sensor count similarity score."""
    device_mapping = device_info.get("bacnetMapping", "").lower()
    estimated_count = len([w for w in device_mapping.split() if w in SENSOR_KEYWORDS])
    actual_count = profile.get("object_count", 1)

    if estimated_count > 0:
        diff = abs(estimated_count - actual_count)
        return max(0, WEIGHT_SENSOR_COUNT - diff * 0.05)
    return 0.0


def _calculate_lorawan_class_score(device_info: dict, profile: dict) -> float:
    """Calculate LoRaWAN class matching score."""
    device_class = device_info.get("lorawanClass", "A")
    if device_class in profile.get("lorawan_class", ["A"]):
        return WEIGHT_LORAWAN_CLASS
    return 0.0


def extract_hex_bytes(text: str) -> str:
    """Extract hex byte sequence from text.

    Raises:
        ValueError: If no hex byte sequence found in text.
    """
    match = re.search(r"([0-9a-fA-F]{2}(?:\s+[0-9a-fA-F]{2})+)", text or "")
    if match:
        return match.group(1)
    raise ValueError(
        "No hex byte sequence found in issue text. Please provide example uplink data like '01 64 00 C8'"
    )
