"""
Configuration constants for BACnet Profile Automation Agent.

This module contains all configuration constants used throughout the agent.
Centralizing configuration makes it easy to modify behavior without hunting
through multiple files.

Context:
    - Used by: All other modules
    - Purpose: Single source of truth for configuration
    - Importance: High - changes here affect entire system behavior
"""

from pathlib import Path

# ============================================================================
# Path Configuration
# ============================================================================

WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
SKILLS_DIR = WORKSPACE_ROOT / "automation" / "skills"
TEMP_ROOT_DIR = WORKSPACE_ROOT / "automation" / "temp"
PROFILES_DIR = WORKSPACE_ROOT / "profiles"
SCRIPTS_DIR = WORKSPACE_ROOT / "scripts"

# ============================================================================
# Model Configuration
# ============================================================================

MODEL_NAME_PRIMARY = "qwen-trubo"
MODEL_NAME_FALLBACK = "deepseek-chat"

# ============================================================================
# Retry Configuration
# ============================================================================

MAX_RETRY_ATTEMPTS = 2

# ============================================================================
# Template Matching Weights
# ============================================================================

WEIGHT_DEVICE_TYPE = 0.40
WEIGHT_OBJECT_TYPE_ANALOG = 0.15
WEIGHT_OBJECT_TYPE_BINARY = 0.15
WEIGHT_SENSOR_COUNT = 0.20
WEIGHT_LORAWAN_CLASS = 0.10

# ============================================================================
# Template Matching Keywords
# ============================================================================

SENSOR_KEYWORDS = [
    "temperature",
    "humidity",
    "co2",
    "pressure",
    "button",
    "switch",
]

DEVICE_TYPE_KEYWORDS = {
    "water": ["water", "leak", "flood", "moisture"],
    "air": ["co2", "air quality", "iaq", "gas"],
    "climate": ["temperature", "humidity", "th", "climate", "weather"],
    "binary": ["binary", "button", "switch", "door", "window"],
    "location": ["gps", "location", "tracker", "position", "geolocation"],
    "energy": ["power", "energy", "current", "voltage", "electricity"],
}
