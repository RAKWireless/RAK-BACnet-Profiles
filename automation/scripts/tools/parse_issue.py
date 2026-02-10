#!/usr/bin/env python3
import logging
import re
import json
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


def parse_issue_body(body: str):
    """
    Parses the GitHub Issue body into a structured JSON.
    Uses regex to find sections based on markdown headers.
    """
    sections = {
        "Device Vendor": "vendor",
        "设备厂商": "vendor",
        "Device Model": "model",
        "设备型号": "model",
        "Uplink Data Examples": "uplinkData",
        "上行数据示例": "uplinkData",
        "BACnet Object Mapping Requirements": "bacnetMapping",
        "BACnet 对象映射要求": "bacnetMapping",
        "LoRaWAN Class": "lorawanClass",
        "LoRaWAN 类别": "lorawanClass",
        "LoRaWAN Protocol Version": "lorawanVersion",
        "LoRaWAN 协议版本": "lorawanVersion",
        "Product Manual/Datasheet Link": "datasheet",
        "产品手册链接": "datasheet",
    }

    data = {}

    # Simple markdown section parser
    # Looks for ### Header and captures everything until the next ### or end of file
    pattern = r"###\s*(.*?)\n(.*?)(?=###|$)"
    matches = re.findall(pattern, body, re.DOTALL)

    for header, content in matches:
        header = header.strip()
        content = content.strip()

        field = sections.get(header)
        if field:
            data[field] = content

    # Handle multiple devices if vendor/model contains separators
    vendors = [
        v.strip() for v in re.split(r"[,;\n]", data.get("vendor", "")) if v.strip()
    ]
    models = [
        m.strip() for m in re.split(r"[,;\n]", data.get("model", "")) if m.strip()
    ]

    devices = []
    # If counts match, pair them up. Otherwise, repeat vendor for models.
    for i, model in enumerate(models):
        vendor = (
            vendors[i] if i < len(vendors) else (vendors[0] if vendors else "Unknown")
        )
        devices.append(
            {
                "vendor": vendor,
                "model": model,
                "uplinkData": data.get("uplinkData", ""),
                "bacnetMapping": data.get("bacnetMapping", ""),
                "lorawanClass": data.get("lorawanClass", ""),
                "lorawanVersion": data.get("lorawanVersion", ""),
                "datasheet": data.get("datasheet", ""),
            }
        )

    # Language detection
    zh_count = len(re.findall(r"[\u4e00-\u9fff]", body))
    lang = "zh" if zh_count / (len(body) + 1) > 0.1 else "en"

    return {"language": lang, "devices": devices}


def main():
    if len(sys.argv) < 2:
        logger.error("Usage: python parse_issue.py <issue_body_file> [output_file]")
        sys.exit(1)

    input_file = Path(sys.argv[1])
    output_file = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("parsed-issue.json")

    if not input_file.exists():
        logger.error(f"Input file not found: {input_file}")
        sys.exit(1)

    body = input_file.read_text(encoding="utf-8")
    result = parse_issue_body(body)

    output_file.parent.mkdir(parents=True, exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    logger.info(f"Successfully parsed issue into: {output_file}")


if __name__ == "__main__":
    main()
