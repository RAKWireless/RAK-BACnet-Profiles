"""
LLM (Large Language Model) integration for profile generation.

This module handles communication with AI models (Qwen, DeepSeek) to generate
BACnet profile YAML files. It abstracts the model-specific details so other
modules just call `create_llm()` and `generate_profile()`.

Context:
    - Used by: nodes/parse.py (profile generation)
    - External APIs: Qwen (Alibaba), DeepSeek
    - Authentication: Environment variables QWEN_API_KEY, DEEPSEEK_API_KEY

Model Selection:
    - Primary: qwen-turbo (Chinese model, good for device specs)
    - Fallback: deepseek-chat (alternative if Qwen fails)
"""

import os

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from agent.config import MODEL_NAME_PRIMARY, MODEL_NAME_FALLBACK


def create_llm(model_name: str) -> ChatOpenAI:
    """Create LLM instance."""
    if model_name == MODEL_NAME_PRIMARY:
        return _create_qwen_llm()
    elif model_name == MODEL_NAME_FALLBACK:
        return _create_deepseek_llm()
    else:
        raise ValueError(f"Unknown model: {model_name}")


def _create_qwen_llm() -> ChatOpenAI:
    """Create Qwen LLM instance."""
    api_key = os.getenv("QWEN_API_KEY")
    if not api_key:
        raise ValueError("QWEN_API_KEY not set")
    return ChatOpenAI(
        model="qwen-turbo",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_key=api_key,
        temperature=0,
    )


def _create_deepseek_llm() -> ChatOpenAI:
    """Create Deepseek LLM instance."""
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise ValueError("DEEPSEEK_API_KEY not set")
    return ChatOpenAI(
        model="deepseek-chat",
        base_url="https://api.deepseek.com",
        api_key=api_key,
        temperature=0,
    )


def create_profile_prompt(
    skill: str, device_json: str, template_content: str
) -> SystemMessage:
    """Create system prompt for profile generation."""
    content = f"""You are a BACnet profile generator.

{skill}

Device Info:
{device_json}

Reference Template:
{template_content}

REQUIREMENTS:
- The YAML must include root-level fields: name, model, vendor, profileVersion, lorawan, codec, datatype.
- lorawan must include: macVersion, supportClassB, supportClassC.
- codec must include a Decode function.
- Output raw YAML starting with 'name:' - no markdown code blocks.
"""
    return SystemMessage(content=content)


def create_profile_user_prompt() -> HumanMessage:
    """Create user prompt for profile generation."""
    return HumanMessage(content="Generate the BACnet profile YAML for this device.")
