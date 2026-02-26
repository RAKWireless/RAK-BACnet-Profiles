## Overview

This is a **BACnet Profile Automation Agent** that generates device profiles from GitHub Issues using AI (LLM).

### Key Features

- **AI-Powered**: Uses Qwen (primary) and DeepSeek (fallback) LLMs
- **Deterministic**: LangGraph workflow with sequential processing
- **Smart Templates**: Automatic template selection based on device similarity
- **Self-Healing**: Auto-retry on validation failure (max 2 attempts)
- **Profile Reuse**: Skips regeneration when existing profile passes validation (use `--force-regenerate` to override)

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 18+
- API Keys: [Qwen](https://dashscope.aliyun.com/) + [DeepSeek](https://platform.deepseek.com/)

### Installation

```bash
cd automation
pip install -r requirements.txt
```

### Running the Agent

**Python (direct):**
```bash
cd automation
python scripts/run-agent.py --issue-body-file test/test-issue-body.txt --issue-number 1
```

**Docker (recommended for consistent local runs):**
```bash
cd automation
# Linux/macOS
./run-local-docker.sh test/test-issue-body.txt 1
# Windows PowerShell
.\run-local-docker.ps1 -IssueBodyFile test\test-issue-body.txt -IssueNumber 1
```

**Parameters:**
| Option | Required | Description |
|--------|----------|-------------|
| `--issue-body-file` | Yes | Path to Issue body text |
| `--issue-number` | Yes | Run identifier (logs, output dirs) |
| `--force-regenerate` | No | Overwrite existing validated profiles |

**Behavior:** Reuses existing profile if it passes validation (unless `--force-regenerate`). Results in `temp/run-{issue-number}-{timestamp}/` and `profiles/`.

## GitHub Actions Integration

### Trigger Methods

**1. Automatic Trigger (Production)**
- Create a GitHub Issue
- Workflow automatically runs and generates profile
- Results posted as PR and Issue comment

**2. Local Testing vs GitHub Actions**

| Scenario | Trigger | Input Source | Output |
|----------|---------|--------------|--------|
| Local Dev (Python) | Manual command | `test/test-issue-body.txt` (from `automation/`) | Local files in `temp/` |
| Local Dev (Docker) | Manual command | `automation/test/test-issue-body.txt` (from repo root) | Local files in `temp/` 
| Production | GitHub Issue created | Real Issue body | PR + Issue comment |

### Automatic Profile Generation
1. **Trigger**: Issue is opened/reopened
2. **Run**: GitHub Actions builds the Docker image and runs the Agent (same image as local)
3. **Generate**: Profile YAML + tests + changelog
4. **PR**: Creates Pull Request with changes
5. **Notify**: Comments on Issue with results

### Required Secrets

Configure these in your GitHub repository:

- `QWEN_API_KEY` - Qwen API key from Alibaba Cloud
- `DEEPSEEK_API_KEY` - DeepSeek API key

### Manual Trigger

You can also run validation manually:

```bash
# Validate all profiles
docker run --rm \
  --entrypoint python \
  profile-agent \
  /workspace/automation/scripts/validate-profiles.py --all
```

## Architecture

### Why Template Similarity Matching?

The agent uses **smart template selection** based on content similarity to improve generation quality:

| Problem | Solution |
|---------|----------|
| LLM hallucination | Reference similar existing profiles as examples |
| Inconsistent structure | Follow proven profile patterns |
| Wrong sensor mappings | Match by device type (temperature → use temp sensor template) |
| Invalid codec patterns | Copy working codec structures |

**How it works:**
1. Parse device requirements from Issue (vendor, model, sensor types)
2. Compare against all existing profiles using weighted scoring
3. Select best matching template as reference for LLM
4. LLM generates new profile following the reference structure

**Scoring Algorithm:**
- Device type matching: 40% (water/air/climate/etc.)
- BACnet object types: 30% (analog/binary inputs)
- Sensor count: 20% (how many sensors)
- LoRaWAN class: 10% (Class A/B/C)

```
GitHub Issue
    ↓
GitHub Actions
    ↓
┌─────────────────────────────────────┐
│       Agent Workflow (LangGraph)     │
│                                      │
│  Parse → Generate → Test → Validate  │
│    ↑         ↓              ↓        │
│    │    generate-expected    │       │
│    │      -output.js         │       │
│    └───── Retry (max 2) ────┘       │
│                                      │
│  Template Selection (Similarity)    │
└─────────────────────────────────────┘
    ↓
Pull Request
    ↓
Issue Comment
```

## Project Structure

All code is organized under `automation/` directory:

```
automation/
├── scripts/
│   ├── run-agent.py              # Main entry point - workflow orchestration
│   ├── comment-on-issue.py       # GitHub API - post comments to issues
│   ├── agent/                    # Core business logic (Clean Code)
│   │   ├── __init__.py
│   │   ├── config.py             # Configuration constants
│   │   ├── context.py            # Workflow context (state management)
│   │   ├── llm.py                # LLM integration (Qwen/DeepSeek)
│   │   ├── state.py              # Type definitions for workflow state
│   │   ├── template.py           # Smart template selection algorithm
│   │   ├── utils.py              # Utility functions (script execution)
│   │   ├── router.py             # Workflow routing logic
│   │   ├── workflow.py           # LangGraph workflow builder
│   │   └── nodes/                # Workflow nodes (each < 100 lines)
│   │       ├── __init__.py
│   │       ├── parse.py          # Parse issue and generate profile
│   │       ├── validate.py       # Validate generated profile
│   │       ├── test_gen.py       # Generate test data
│   │       ├── changelog.py      # Generate changelog
│   │       └── merge.py          # Merge results
│   └── tools/
│       ├── __init__.py
│       └── parse_issue.py        # Standalone issue parser
├── ../scripts/                   # Root-level scripts (shared with validation)
│   ├── validate-profile.js       # Profile validation
│   ├── generate-expected-output.js # Generate expected test outputs from codec
│   └── test-codec.js             # Codec testing utilities
├── tests/                        # Testing and validation tools
│   ├── validate-profiles.py      # Profile validation tool
│   └── test-all-profiles.py      # Batch testing tool
├── skills/                       # AI prompt templates
│   ├── parse-issue/
│   ├── generate-profile/
│   ├── validate-profile/
│   ├── generate-tests/
│   └── generate-changelog/
├── test/                         # Test data
│   ├── test-issue-body.txt
│   └── test-issue-body-zh.txt
├── temp/                         # Runtime temporary files
├── requirements.txt              # Python dependencies
├── run-local-docker.sh           # Local Docker run (Linux/macOS)
├── run-local-docker.ps1          # Local Docker run (Windows)
├── docker-entrypoint.sh          # Docker entry point
└── README.md                     # This file
```

### Design Principles

1. **Single Language**: All business logic in Python (no JavaScript in workflows)
2. **Clean Code**: Each function < 20 lines, each module < 300 lines
3. **No Global State**: Dependency injection via `WorkflowContext`
4. **Unified Logging**: All modules use `logging.getLogger(__name__)`
5. **Type Safety**: Full type hints on all functions

## Development

```bash
# Run agent (see "Running the Agent" above)
python scripts/run-agent.py --issue-body-file test/test-issue-body.txt --issue-number 1

# Force regenerate even when profile exists
python scripts/run-agent.py --issue-body-file test/test-issue-body.txt --issue-number 1 --force-regenerate

# Validate all profiles
python tests/validate-profiles.py --all
```

#### Test Node Workflow

The **Test** node in the workflow does two things:

1. **Generate Test Data** (`test-data.json`)
   - Parses all uplink examples (supports multiple fPorts)
   - Creates one test case per uplink example
   - Saved to `profiles/{vendor}/tests/test-data.json`

2. **Generate Expected Output** (`expected-output.json`) 
   - Uses profile's codec to decode test data
   - Executes `scripts/generate-expected-output.js`
   - Produces expected sensor values (temperature, humidity, etc.)
   - Saved to `profiles/{vendor}/tests/expected-output.json`

**Purpose**: 
- Enables CI/CD testing - validate that codec changes don't break existing functionality
- Documents expected decoding results for each device
- Allows regression testing when profiles are modified

**If script is missing**: Test node will only generate `test-data.json` without expected outputs.

## Configuration

### Environment Variables

The agent requires these environment variables:

- `QWEN_API_KEY` - Qwen API key from Alibaba Cloud
- `DEEPSEEK_API_KEY` - DeepSeek API key

### Setup by Deployment Method

**1. Local Development**

Create `.env` file in `automation/` directory:
```bash
cd automation
cp .env.example .env
# Edit .env and add your API keys
```

Or export directly:
```bash
export QWEN_API_KEY="your_qwen_key"
export DEEPSEEK_API_KEY="your_deepseek_key"
```

**2. Docker**

Pass via `-e` flag:
```bash
docker run --rm \
  -e QWEN_API_KEY="your_key" \
  -e DEEPSEEK_API_KEY="your_key" \
  profile-agent \
  --issue-body-file /workspace/test.txt
```

Or mount `.env` file:
```bash
docker run --rm \
  -v $(pwd)/automation/.env:/workspace/automation/.env \
  profile-agent \
  --issue-body-file /workspace/test.txt
```

**3. GitHub Actions**

Configure in repository settings:
1. Go to Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add `QWEN_API_KEY` and `DEEPSEEK_API_KEY`

The workflow will automatically use these secrets.

## Troubleshooting

### Common Issues

**API Key Errors**
```
ValueError: QWEN_API_KEY not set
```
→ Check configuration section above for your deployment method

**Validation Failures**
→ Check `automation/temp/run-*/agent.log` for details

**Node.js Not Found**
→ Install Node.js 18+ for validation scripts

### Debug Mode

Set `LOG_LEVEL=debug` to see detailed execution logs.

## Pull Request Template

When submitting a PR for automated profile generation, please use this template:

```markdown
## Automated Profile Generation

This PR was automatically generated by the BACnet Profile Agent from issue #ISSUE_NUMBER.

### Changes

- [ ] Added new BACnet device profile
- [ ] Generated test data and expected outputs
- [ ] Created CHANGELOG.md

### Validation Checklist

- [ ] Profile YAML syntax is valid
- [ ] Codec functions work correctly
- [ ] Test data passes validation
- [ ] All required fields are present
- [ ] File naming follows convention (Vendor-Model.yaml)

### Review Notes

**Maintainers:** Please review before merging.

1. Check that the device type and sensors are correctly identified
2. Verify BACnet object mappings are appropriate
3. Confirm LoRaWAN class and version are correct
4. Test the codec with real uplink data if possible

---
*This is an automated PR. If changes are needed, please comment on the original issue.*
```

## Extending the System

### Adding New Fields to Device Profiles

When you need to add new fields to device profiles (e.g., new sensor types, configuration options), you need to modify the following components:

#### 1. **Update Issue Parser** (`scripts/tools/parse_issue.py`)

Add the new field to the sections mapping and data extraction:

```python
# In parse_issue_body() function, add to sections dict:
sections = {
    # ... existing fields ...
    "New Field Name": "newFieldKey",  # Add here
}

# The field will be automatically extracted and included in device_info
```

#### 2. **Update SKILL.md** (`skills/generate-profile/SKILL.md`)

Update the AI instructions to include the new field:

```markdown
#### Required Fields

Add your new field to the table:
| Field | Type | Description |
|-------|------|-------------|
| ... existing fields ... |
| newFieldKey | string | Description of new field |
```

Update the examples section to show usage:
```markdown
<good_example>
name: "Device Name"
newFieldKey: "value"  # Add example
</good_example>
```

#### 3. **Update LLM Prompt** (Optional)

If the new field requires special handling, update `scripts/agent/llm.py`:

```python
def create_profile_prompt(skill, device_json, template_content):
    content = f"""You are a BACnet profile generator.

{skill}

REQUIREMENTS:
- ... existing requirements ...
- Include newFieldKey in the datatype section when applicable
"""
```

#### 4. **Update State Type** (Optional)

If you need strict type checking, update `scripts/agent/state.py`:

```python
class DeviceProfile(TypedDict):
    # ... existing fields ...
    new_field: str  # Add type definition
```

#### 5. **Update Template Selection** (Optional)

If the new field affects template matching, update `scripts/agent/template.py`:

```python
SECTIONS = {
    # ... existing mappings ...
    "New Field": "newFieldKey",
}
```

#### Data Flow

```
GitHub Issue (markdown)
    ↓
parse_issue.py (extracts to device_info["newFieldKey"])
    ↓
SKILL.md (instructs LLM how to use the field)
    ↓
LLM generates profile with new field
    ↓
save_and_register() persists to YAML
```

#### Testing New Fields

1. **Update test data** (`test/test-issue-body.txt`):
```markdown
### New Field Name
Value here
```

2. **Run locally** (add `--force-regenerate` to overwrite existing profile):
```bash
python scripts/run-agent.py --issue-body-file test/test-issue-body.txt --issue-number 999
```

3. **Check output** in `temp/run-999-*/` directory

#### Example: Adding "Firmware Version" Field

1. **parse_issue.py**:
```python
sections = {
    # ... existing ...
    "Firmware Version": "firmwareVersion",
}
```

2. **SKILL.md**:
```markdown
### Step 1: Load Input Data
Extract from device_info:
- **firmwareVersion**: Device firmware version (e.g., "1.2.3")

#### Required Fields
| Field | Type | Description |
| firmwareVersion | string | Firmware version (optional) |
```

3. **Test**:
```bash
python scripts/run-agent.py --issue-body-file test/test-issue-body.txt --issue-number 1
```