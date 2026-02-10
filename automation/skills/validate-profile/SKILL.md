---
name: validate-profile
description: Execute the Node.js validation script and interpret results
---

# Validate Profile Skill

## Overview
This skill defines how to use the objective validation script to ensure profile quality.

## Instructions

### Step 1: Run Script
1. Identify the profile to validate (from `generate-profile` step).
2. Call `run_validation_script(file_path)` using the virtual path.

### Step 2: Interpret Output
1. Check the first line of the output.
2. **If "Validation passed"**:
   - Skill Complete.
3. **If "Validation failed"**:
   - Look for specific failure categories: "Checking Profile structure", "Checking required fields", "Checking Codec functions".
   - Identify the specific field or function that failed.
   - Return to `generate-profile` Step 3 to fix the specific error.

### Step 3: Handle Test Failures
1. If "Running test data validation" section shows Fail:
   - Identify the test case name and the mismatch (Actual vs Expected).
   - Fix the `codec` logic in the YAML.
   - Call `save_and_register` again.
   - Re-run this skill.

## Important Notes
- Do NOT guess the error. Read the STDOUT from the script.
- The script is the ONLY authority on whether a profile is correct.
