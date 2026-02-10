---
name: generate-tests
description: Deterministically generate test data and expected output
---

# Generate Tests Skill

## Instructions

### Step 1: Generate test-data.json
1. Read `/automation/temp/parsed-issue.json`.
2. Extract the `uplinkData` examples.
3. Format as a `testCases` array in JSON.
4. Call `save_and_register("/profiles/{vendor}/tests/test-data.json", content)`.

### Step 2: Generate expected-output.json (NO Mental Math)
1. DO NOT try to calculate the output yourself.
2. Call `run_generate_expected_output_script(profile_path)`:
   - `profile_path`: The virtual path to the YAML you just generated (e.g., `/profiles/Senso8/Senso8-LRS20100.yaml`).
3. This script will execute the actual JavaScript codec logic and create the `expected-output.json` file.

### Step 3: Registration
1. Since the script created the file, you must register it.
2. Call `register_generated_file("/profiles/{vendor}/tests/expected-output.json")`.

## Important Notes
- Calculating hex outputs manually is FORBIDDEN. Use the script.
