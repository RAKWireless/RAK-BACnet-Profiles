---
name: parse-issue
description: Deterministically extract device data from Issue body into structured JSON
---

# Parse Issue Skill

## Instructions

### Step 1: Execute Independent Parser
1. Call `run_parse_issue_script(issue_body_path, output_path)`:
   - `issue_body_path`: `/automation/temp/current-issue-body.txt`
   - `output_path`: `/automation/temp/parsed-issue.json`

### Step 2: Validate Result
1. Read `/automation/temp/parsed-issue.json`.
2. Check if the `devices` array is populated.
3. **If parser failed or data is missing**: 
   - Manually extract the missing fields from the Issue body.
   - Use `write_file` to fix or create `/automation/temp/parsed-issue.json`.

## Important Notes
- Always prefer the script over manual extraction.
