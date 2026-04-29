# Profile Validation Scripts

This directory contains Node.js scripts for validating and testing BACnet Profile configuration files.

## 📦 Install Dependencies

```bash
cd scripts
npm install
```

## 🛠️ Tool List

### 1. update-registry.js - Registry Update Tool 🆕

**Purpose**: Automatically scan the profiles directory and generate or update the `registry.json` registry file.

**Usage**:
```bash
# Scan all Profiles and update registry.json
node scripts/update-registry.js
```

**Features**:
- ✅ Automatically scan all YAML files in vendor directories
- ✅ Extract device information (vendor, model, version)
- ✅ Detect test data existence
- ✅ Automatically identify device types
- ✅ Generate statistics (grouped by vendor, device type)
- ✅ Sort by vendor and model
- ✅ Generate JSON Schema compliant registry

**Output Example**:
```
🔍 Scanning profiles directory...
✅ Found 20 profiles
📝 Registry updated: D:\work\rak\RAK-BACnet-Profiles\registry.json

📊 Statistics:
   Total Profiles: 20
   With Tests: 10 | Without Tests: 10

📦 By Vendor:
   Carrier: 2
   Dragino: 4
   Milesight: 2
   MOKOSMART: 1
   Sensedge: 1
   Senso8: 9

✨ Done!
```

**When to Run**:
- ✨ After adding new Profile files
- ✨ After modifying existing Profile information
- ✨ After adding test data to Profiles
- ✨ When statistics need updating

---

### 2. validate-registry.js - Registry Validation Tool

**Purpose**: Validate that `registry.json` complies with JSON Schema and check consistency and file integrity.

**Usage**:
```bash
# Validate registry.json
node scripts/validate-registry.js
```

**Validation Content**:
- ✅ JSON format validity
- ✅ Schema compliance (conforms to registry-schema.json)
- ✅ Data consistency (statistics match actual counts)
- ✅ File path validity (all referenced files exist)

**Output Example**:
```
🔍 Validating registry.json...

✅ Registry JSON parsed successfully
✅ Schema JSON parsed successfully

✅ Registry validation PASSED

📊 Registry Statistics:
   Version: 1.0.0
   Last Update: 2026-01-16
   Total Profiles: 19
   With Tests: 10 | Without Tests: 9

🔍 Checking consistency...
✅ Profile count is consistent
✅ Vendor statistics are consistent
✅ Test data statistics are consistent

🔍 Checking file paths...
✅ All profile files exist

✨ Validation complete!
```

---

### 3. validate-all.js - Batch Validation Tool ⭐

**Purpose**: Validate all Profile files at once, quickly check the entire project (excludes test data validation).

**Usage**:
```bash
# Validate all files in profiles directory
node scripts/validate-all.js

# Validate specific directory
node scripts/validate-all.js profiles/Senso8

# JSON format output (for CI/CD)
node scripts/validate-all.js --json
```

**Validation Content**:
- ✅ YAML syntax check
- ✅ Profile structure validation (Schema)
- ✅ Required fields check
- ✅ Codec function syntax validation
- ✅ BACnet object type compliance
- ✅ File naming convention
- ⏭️ Skip test data execution (fast validation)

**Output Example**:
```
🔍 Scanning directory: profiles

📦 Found 16 Profile files

======================================================================

[1/16] profiles/Becasmart/Becasmart-BAC006.yaml
----------------------------------------------------------------------
✅ Pass

[2/16] profiles/Dragino/Dragino-LDS02.yaml
----------------------------------------------------------------------
✅ Pass

...

======================================================================

📊 Validation Summary:

  Total: 16
  Passed: 15 ✅
  Failed: 1 ❌
  Success Rate: 93.8%

❌ Failed files:
  - profiles/Senso8/Senso8-LRS10701.yaml

======================================================================
```

---

### 4. validate-profile.js - Single File Validation Tool

**Purpose**: Comprehensive validation of a single Profile, including syntax, structure, Codec functions, and test data.

**Usage**:
```bash
# Validate a single Profile
node scripts/validate-profile.js profiles/Senso8/Senso8-LRS20600.yaml

# Validate specific model (automatically filters test cases)
node scripts/validate-profile.js profiles/Senso8/Senso8-LRS20100.yaml
# Only runs test cases with model: "LRS20100" and generic test cases
```

**Validation Items**:
- ✅ YAML syntax check
- ✅ Profile structure validation (Schema)
- ✅ Required fields check
- ✅ Codec function syntax validation
- ✅ BACnet object type compliance
- ✅ File naming convention
- ✅ Test data execution (complete validation)

**Options**:
```bash
# Skip test data validation
node scripts/validate-profile.js profiles/xxx.yaml --no-tests

# JSON format output (for CI/CD)
node scripts/validate-profile.js profiles/xxx.yaml --json
```

---

### 5. test-codec.js - Codec Function Testing

**Purpose**: Test Profile encode/decode functions independently.

**Single Test**:
```bash
node scripts/test-codec.js \
  -f profiles/Senso8/Senso8-LRS20600.yaml \
  -p 10 \
  -u 040164010000000f41dc
```

**Batch Testing**:
```bash
node scripts/test-codec.js --batch \
  profiles/Senso8/Senso8-LRS20600.yaml \
  examples/minimal-profile/tests/test-data.json
```

**Parameters**:
- `-f, --file`: Profile YAML file path
- `-p, --port`: LoRaWAN fPort (default: 10)
- `-u, --uplink`: Uplink data (hexadecimal format)
- `-b, --batch`: Batch test mode

---

### 4. profile-schema.json - Profile Schema Definition

**Purpose**: Define the standard structure of Profile YAML files for automatic validation.

**Supported BACnet Object Types**:
- `AnalogInputObject`
- `AnalogOutputObject`
- `AnalogValueObject`
- `BinaryInputObject`
- `BinaryOutputObject`
- `BinaryValueObject`
- `OctetStringValueObject`

---

## 🔧 Utility Function Library

### utils/hex-converter.js

Hexadecimal data conversion tools:

```javascript
const { hexToBytes, bytesToHex, formatHex } = require('./utils/hex-converter');

// Hexadecimal string → Byte array
const bytes = hexToBytes('040164');  // [4, 1, 100]

// Byte array → Hexadecimal string
const hex = bytesToHex([4, 1, 100]);  // "04 01 64"

// Format hexadecimal string
const formatted = formatHex('040164');  // "04 01 64"
```

### utils/yaml-parser.js

YAML parsing and validation tools:

```javascript
const {
  loadYAML,
  extractCodec,
  validateRequiredFields,
  validateBACnetObjects
} = require('./utils/yaml-parser');

// Load YAML file
const profile = loadYAML('profiles/xxx.yaml');

// Extract Codec functions
const codec = extractCodec(profile);

// Validate required fields
const result = validateRequiredFields(profile);

// Validate BACnet objects
const bacnetResult = validateBACnetObjects(profile);
```

---

## 📋 Validation Process

### Complete Validation Flow

```
1. YAML syntax check
   ↓
2. Schema structure validation
   ↓
3. Required fields check
   ↓
4. Codec function syntax check
   ↓
5. BACnet object compliance validation
   ↓
6. File naming convention check
   ↓
7. Test data execution validation
   ↓
Generate validation report
```

### Validation Levels

**Level 1 - Basic Validation** (`--no-tests`):
- YAML syntax
- Profile structure
- Required fields
- File naming

**Level 2 - Standard Validation**:
- Basic validation +
- Codec function syntax
- BACnet object configuration

**Level 3 - Complete Validation** (default):
- Standard validation +
- Run actual test data
- Execute decode and verify success

**Level 4 - Strict Validation** (automatically enabled):
- Level 3 validation +
- **Deep comparison of decode output**
- Ensure output completely matches expected results
- Requires `expected-output.json`

---

## 🧪 Test Data Format

Validation scripts support two test files located in the `tests/` folder in the same directory as the Profile:

```
profiles/Vendor/
├── Vendor-Model.yaml
└── tests/
    ├── test-data.json          # Required: Test input
    └── expected-output.json    # Optional: Expected output (recommended)
```

### 1. test-data.json (Required)

Define test input data:

```json
{
  "description": "Test data set description",
  "testCases": [
    {
      "name": "Test case name",
      "model": "LRS20100",
      "fPort": 10,
      "input": "040164010000000f41dc",
      "description": "Case description (optional)"
    }
  ]
}
```

**Field Descriptions**:
- `name` (Required): Test case name
- `model` (Optional): Device model, used to filter test cases
  - If `model` is specified, the test case will only run when validating the corresponding model Profile
  - If `model` is not specified, the test case applies to all models
  - Model name is automatically extracted from the Profile filename (e.g., `Senso8-LRS20100.yaml` → `LRS20100`)
- `fPort` (Required): LoRaWAN port number
- `input` (Required): Uplink data in hexadecimal format
- `description` (Optional): Test case description

### 2. expected-output.json (Optional, Recommended)

Define expected output results for **automatic output correctness validation**:

```json
{
  "description": "Expected output",
  "testCases": [
    {
      "name": "Test case name",
      "model": "LRS20100",
      "expectedOutput": [
        {
          "name": "Temperature",
          "channel": 1,
          "value": 25.5,
          "unit": "°C"
        },
        {
          "name": "Humidity",
          "channel": 2,
          "value": 60.0,
          "unit": "%"
        }
      ]
    }
  ]
}
```

**Field Descriptions**:
- `name` (Required): Test case name, must match the name in `test-data.json`
- `model` (Optional): Device model, should match the `model` field in `test-data.json`
- `expectedOutput` (Required): Expected output array

### 3. Multi-Model Test Case Management

When multiple model Profiles exist under the same vendor directory, you can manage test cases for all models in a single `tests` directory:

```
profiles/Senso8/
├── Senso8-LRS20100.yaml      # Temperature & Humidity Sensor
├── Senso8-LRS20200.yaml      # Temperature Sensor
├── Senso8-LRS20600.yaml      # Door Sensor
└── tests/
    ├── test-data.json
    └── expected-output.json
```

`test-data.json` example:
```json
{
  "description": "Senso8 Series Test Cases",
  "testCases": [
    {
      "name": "LRS20100 Temperature & Humidity Test",
      "model": "LRS20100",
      "fPort": 10,
      "input": "01016400e901ef00000000"
    },
    {
      "name": "LRS20200 Temperature Test",
      "model": "LRS20200",
      "fPort": 10,
      "input": "01010064000000000000"
    },
    {
      "name": "Generic Battery Test",
      "fPort": 10,
      "input": "010164006400640000"
    }
  ]
}
```

Validation behavior:
- Validate `Senso8-LRS20100.yaml` → Only runs test cases with `model: "LRS20100"` and tests without `model` field
- Validate `Senso8-LRS20200.yaml` → Only runs test cases with `model: "LRS20200"` and tests without `model` field
- Validate `Senso8-LRS20600.yaml` → Only runs test cases without `model` field (generic tests)

**Important Notes**:
- ✅ `expectedOutput` is an **array** corresponding to the `data` field returned by `decodeUplink`
- ✅ Test case order must match `test-data.json` consistently
- ✅ When this file is provided, validation performs **deep comparison** to ensure output matches completely
- ⚠️ If this file is not provided, validation only checks if decode executes successfully, not output content

### Validation Behavior Comparison

| File Configuration | Validation Behavior | Test Result Display |
|-------------------|---------------------|---------------------|
| Only `test-data.json` | Only checks decode execution success | `✓ Test case name [Output not verified]` |
| Both files provided | **Strict validation**: Deep comparison of output | `✓ Test case name [Output matched]` |
| Output mismatch | Validation fails, shows differences | `✗ Test case name: Output does not match` |

---

## 🔄 Workflow Integration

### Add Scripts to package.json

```json
{
  "scripts": {
    "validate": "node scripts/validate-profile.js",
    "test": "node scripts/test-codec.js"
  }
}
```

### Git Pre-commit Hook

```bash
#!/bin/sh
# .git/hooks/pre-commit

# Validate all modified Profile files
for file in $(git diff --cached --name-only | grep 'profiles/.*\.yaml$'); do
  node scripts/validate-profile.js "$file"
  if [ $? -ne 0 ]; then
    echo "❌ Profile validation failed: $file"
    exit 1
  fi
done
```

### GitHub Actions

See `.github/workflows/validate-profiles.yml` for complete CI/CD configuration.

---

## 📊 Output Format

### Console Output

```
======================================================================
Validating Profile: profiles/Senso8/Senso8-LRS20600.yaml
======================================================================

📝 Checking YAML syntax...
  ✓ Pass

📋 Checking Profile structure...
  ✓ Pass

📦 Checking required fields...
  ✓ Pass

🔧 Checking Codec functions...
  ✓ Pass
  ⚠ Optional function not found: encodeDownlink (downlink control will be unavailable)

🏢 Checking BACnet object configuration...
  ✓ Pass

📁 Checking file naming convention...
  ✓ Pass

🧪 Running test data validation...
  Model detected: LRS20600
  Running 2 of 5 test cases
  ✓ Pass

Test result details:
  ✓ Normal temperature data [LRS20600] [Output matched]
  ✓ Negative temperature data [LRS20600] [Output matched]

======================================================================
✅ Validation passed
======================================================================
```

**Description**:
- `Model detected: LRS20600` - Model automatically extracted from filename `Senso8-LRS20600.yaml`
- `Running 2 of 5 test cases` - Indicates 2 test cases were run out of 5 total matching this model
- `[LRS20600]` - Displays the model this test case belongs to

### JSON Output

```json
{
  "file": "profiles/Senso8/Senso8-LRS20600.yaml",
  "timestamp": "2025-10-23T15:30:00.000Z",
  "valid": true,
  "checks": {
    "yamlSyntax": { "valid": true, "errors": [] },
    "schema": { "valid": true, "errors": [] },
    "requiredFields": { "valid": true, "errors": [] },
    "codec": { 
      "valid": true, 
      "errors": [],
      "warnings": ["Optional function not found: encodeDownlink"]
    },
    "bacnet": { "valid": true, "errors": [] },
    "naming": { "valid": true, "errors": [], "warnings": [] },
    "tests": {
      "valid": true,
      "errors": [],
      "results": [
        {
          "name": "Normal temperature data",
          "status": "PASS",
          "matched": true
        }
      ]
    }
  }
}
```

---

## 🐛 Frequently Asked Questions

### Q: npm install fails?
A: Ensure Node.js version >= 14.0.0 and network connection is stable.

### Q: Validation script error "Module not found"?
A: Run `npm install` in the scripts/ directory to install dependencies.

### Q: Where is the test data?
A: Test data should be placed in the `tests/` subdirectory in the same directory as the Profile file:
- `tests/test-data.json` - Test input (required)
- `tests/expected-output.json` - Expected output (optional)

### Q: Why does my test show "[Output not verified]"?
A: Because the `expected-output.json` file is missing. Validation only checked if decode succeeded, but didn't verify output content. It's recommended to add an expected output file for strict validation.

### Q: How to generate expected-output.json?
A: Follow these steps:
1. First run `test-codec.js` to view actual output
2. After confirming output is correct, copy to `expected-output.json`
3. Run validation again to ensure match

```bash
# View actual output
node scripts/test-codec.js -f profiles/Vendor/Model.yaml -p 10 -u <hex>

# Copy the "data" part of output to the expectedOutput field in expected-output.json
```

### Q: Validation fails with "Output does not match", what to do?
A: Validation will show detailed differences between expected and actual output. Check:
1. **Data correctness**: Confirm input data in `test-data.json` is correct
2. **Expected output correctness**: Expected output may be wrong, needs updating
3. **Codec function issue**: Codec decode logic may have a bug

### Q: How to add custom validation rules?
A: Modify `validate-profile.js` or extend `profile-schema.json`.

---


**Last Updated**: 2025-10-23
