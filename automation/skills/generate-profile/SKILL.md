---
name: generate-profile
description: Generate BACnet Profile YAML configuration files based on device information and example profiles
---

# Generate Profile Skill

## Overview
This skill defines the strict procedure for generating a BACnet Profile YAML.

## Instructions

### Step 1: Load Input Data
1. Read the parsed result from `/automation/temp/parsed-issue.json`.
2. Extract vendor, model, and device capabilities.

### Step 2: Select Template
1. Read the standard example: `/examples/standard-profile/standard-temp-humidity-sensor.yaml`.
2. Smart Match: Based on keywords in `bacnetMapping`:
   - "Binary", "Button", "Switch" -> `/profiles/Moko/Moko-LW013SB.yaml`
   - "CO2", "Carbon" -> `/profiles/Senso8/Senso8-LRS10701.yaml`
   - "Temperature", "Humidity" -> `/profiles/Senso8/Senso8-LRS20100.yaml`
   - "Water", "Leak" -> `/profiles/Senso8/Senso8-LRS20310.yaml`
   - Default -> `/profiles/Senso8/Senso8-LRS20100.yaml`

### Step 3: Draft YAML Content
Compose the YAML strictly following the root-level structure:
- `codec`: | Full JavaScript functions (Decode, Encode, decodeUplink, encodeDownlink).
- `datatype`: Channel object mappings.
- `model`, `name`, `vendor`, `profileVersion` (1.0.0), `lorawan`.

**FORBIDDEN:** 
- Do NOT use `device:` wrapper. 
- Do NOT use short strings for `codec` (e.g., "lorawan-1.0.3").
- Do NOT use "datatype: json".

### Step 4: Execution & Registration
1. Construct the path: `/profiles/{vendor}/{vendor}-{model}.yaml`.
2. **Action**: Call `save_and_register(file_path, content)`. Do NOT use `write_file`.
3. If file already exists, the tool will overwrite it.

### Step 5: Verification
Call `run_validation_script` on the saved path.
- If Success: Mark this skill as complete.
- If Fail: Analyze the exact error message from the script output (e.g., "must have required property 'model'"). 
- Fix the Draft YAML by ensuring it matches the root-level structure of the examples.
- Repeat Step 4 and 5 (max 3 attempts).

## Important Notes
- All paths must be virtual (start with /).
- `save_and_register` is MANDATORY for all output files.
- The YAML must be valid and follow the examples exactly.
