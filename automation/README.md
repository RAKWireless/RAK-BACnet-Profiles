## Overview

This is a **BACnet Profile Automation Agent** that generates device profiles from GitHub Issues using AI (LLM).

### Key Features

- **AI-Powered**: Uses Qwen (primary) and DeepSeek (fallback) LLMs
- **Deterministic**: LangGraph workflow with sequential processing
- **Smart Templates**: Automatic template selection based on device similarity
- **Self-Healing**: Auto-retry on validation failure (max 2 attempts)
- **Clean Code**: Modular architecture following Clean Code principles

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

### Run Locally

```bash
python scripts/run-agent.py \
  --issue-body-file test/test-issue-body.txt \
  --issue-number 1
```

**Parameters:**
- `--issue-body-file`: Path to the file containing the GitHub Issue body
- `--issue-number`: GitHub Issue number (used for:
  - Creating unique temp directory: `temp/run-{issue-number}-{timestamp}/`
  - Naming result files: `agent-result-{issue-number}.json`
  - Logging: identifying which issue this run is for
  - Example: `1`, `42`, `999` - any unique number works for local testing)

## GitHub Actions Integration

### Automatic Profile Generation

When a new Issue is created with the label `new-device`:

1. **Trigger**: Issue is opened/reopened
2. **Run**: GitHub Actions executes the Agent
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

```
GitHub Issue
    ↓
GitHub Actions
    ↓
┌─────────────────────────────────────┐
│       Agent Workflow (LangGraph)     │
│                                      │
│  Parse → Generate → Test → Validate  │
│    ↑                        ↓        │
│    └───── Retry (max 2) ────┘       │
│                                      │
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
│   ├── validate-profiles.py      # Profile validation tool
│   ├── test-all-profiles.py      # Batch testing tool
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
### Testing

```bash
# Run agent with test data (use any number for local testing)
python scripts/run-agent.py --issue-body-file test/test-issue-body.txt --issue-number 1

# Validate profiles
python scripts/validate-profiles.py --all
```

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

## License

MIT
