# Complete Guide to Profile Test Fixtures

This guide explains how to create and maintain test fixtures for BACnet Profiles. Test fixtures validate uplink decoding and, when present, downlink encoding against the Profile's BACnet object mapping and known protocol vectors.

---

## 📂 Directory Structure

Each Profile carries exactly one committed test fixture:

```
profiles/
└── Vendor/
    ├── Vendor-Model.yaml          # Profile file
    └── tests/
        └── Vendor-Model.test.json # Test fixture (required)
```

The fixture file must be named after the Profile it tests, e.g. `Milesight-EM410-RDL.yaml` → `tests/Milesight-EM410-RDL.test.json`.

---

## 📋 What a Test Fixture Does

A single `.test.json` fixture contains both the test inputs and the expected outputs for one Profile:

- **Inputs**: uplink payloads (`fPort` + hex `input`) and their descriptions
- **Expected outputs**: the BACnet row array each payload should decode to
- **Downlink vectors**: BACnet `channel` + numeric `value`, expected fPort, and expected bytes
- **Metadata**: evidence level, data sources, and robustness policy

The validator runs every test case through the Profile Codec and checks:

1. Decoding succeeds and is deterministic
2. The decoded `data` array matches `expectedOutput` exactly (when present)
3. Every decoded entry is valid against the `datatype` mapping (channel, name, unit, value)
4. All non-output `datatype` channels are covered by the fixture
5. Robustness: truncated payloads and unknown fPorts are rejected cleanly (configurable)
6. Every downlink vector encodes deterministically to the expected bytes and fPort

---

## 🔧 Steps to Create a Test Fixture

### Step 1: Create the Tests Directory

```bash
mkdir -p profiles/Vendor/tests
```

### Step 2: Create the Fixture File

Create `profiles/Vendor/tests/Vendor-Model.test.json`:

```json
{
  "schemaVersion": 1,
  "profile": "Vendor-Model",
  "evidenceLevel": "known-answer",
  "reviewMode": "single-model",
  "sources": [
    {
      "type": "official-document",
      "reference": "Vendor-Model User Guide, payload section",
      "citation": "Periodic and alarm payload examples used as test vectors"
    }
  ],
  "robustness": {
    "checkTruncation": true,
    "checkUnknownFPort": true,
    "checkFuzz": false
  },
  "testCases": [
    {
      "name": "Normal periodic report",
      "fPort": 10,
      "input": "0175640500000482b3",
      "description": "Temperature=25.0C, Humidity=60%",
      "expectedOutput": [
        { "name": "Temperature", "channel": 1, "value": 25.0, "unit": "degreesCelsius" },
        { "name": "Humidity", "channel": 2, "value": 60, "unit": "percent" }
      ]
    },
    {
      "name": "High temperature alarm",
      "fPort": 10,
      "input": "0482c82701",
      "description": "Temperature alarm triggered",
      "expectedOutput": [
        { "name": "Temperature", "channel": 1, "value": 31.0, "unit": "degreesCelsius" },
        { "name": "High Temp Alarm", "channel": 3, "value": 1, "unit": null }
      ]
    }
  ]
}
```

---

## 📖 Fixture Field Reference

### Top-Level Fields

| Field | Required | Description |
|-------|----------|-------------|
| `schemaVersion` | ✅ | Schema version, must be `1` |
| `profile` | ✅ | Must exactly match the YAML file name (without extension), e.g. `Milesight-EM410-RDL` |
| `evidenceLevel` | ✅ | `known-answer`, `documentation-only`, or `decoder-derived` (see below) |
| `reviewMode` | ❌ | `single-model` (default) or `multi-model` |
| `sources` | ✅ | Evidence sources for the payloads (at least one) |
| `fPortPolicy` | ❌ | How fPort is treated: `fixed`, `agnostic`, or `ignored` |
| `robustness` | ❌ | Robustness check toggles: `checkTruncation`, `checkUnknownFPort`, `checkFuzz` |
| `strict` | ❌ | When `true`, enables stricter contract checks (see below) |
| `testCases` | ✅ | Array of test cases (at least one) |
| `downlinkTestCases` | ❌ | Required for strict Profiles with writable datatype channels |

### evidenceLevel

| Value | Meaning | Requirement |
|-------|---------|-------------|
| `known-answer` | Expected outputs verified against an independent source (official document, customer data) | At least one `expectedOutput`; missing channel coverage is an **error** |
| `documentation-only` | Values derived from documentation, no independent oracle | Coverage gaps are **warnings** only |
| `decoder-derived` | Expected outputs produced by the decoder itself | At least one `expectedOutput` |

### sources

```json
"source": {
  "type": "official-document",
  "reference": "Milesight EM410-RDL User Guide",
  "citation": "Periodic and alarm payload examples"
}
```

- `type`: one of `issue`, `official-document`, `vendor-decoder`, `customer-data`
- `reference` (required): document name, URL, or issue reference
- `citation` (optional): where exactly the test vector came from

### fPortPolicy

Describes how the decoder treats the LoRaWAN fPort, which changes the robustness checks:

```json
// Fixed set of known ports
{ "mode": "fixed", "ports": [85, 86], "citation": "Port 85 for data, 86 for config" }

// Decoder ignores the port (any application port decodes the same)
{ "mode": "agnostic", "representativeFPort": 85, "citation": "Payloads are port-agnostic" }

// fPort is not meaningful for this device
{ "mode": "ignored", "representativeFPort": 85, "reason": "Device does not use fPort routing" }
```

### robustness

All three checks default as shown:

| Field | Default | Behavior |
|-------|---------|----------|
| `checkTruncation` | `true` | Truncates each input at many lengths; the decoder must return an `errors` array and no BACnet `data` |
| `checkUnknownFPort` | `true` | Runs inputs on an unused fPort; the decoder must return an `errors` array and no `data` |
| `checkFuzz` | `false` | Runs 16 seeded fuzz inputs; output must be deterministic and well-formed |

### testCases

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✅ | Unique test case name |
| `messageType` | ❌ | Optional label, e.g. `periodic`, `alarm`, `boot` |
| `fPort` | ✅ | LoRaWAN port, integer 1–254 |
| `input` | ✅ | Uplink payload in hex. Spaces and dashes are allowed (e.g. `"01 75 64 05"` or `"01-75-64-05"`) |
| `description` | ❌ | Human-readable meaning of the payload |
| `expectedOutput` | ❌ | Expected decoded `data` array (see below) |

### expectedOutput

`expectedOutput` is an array that directly corresponds to the `data` array returned by `decodeUplink`. Each entry has four fields:

```json
{ "name": "Temperature", "channel": 1, "value": 25.0, "unit": "degreesCelsius" }
```

- `name` — must exactly match the `datatype.<channel>.name` in the Profile
- `channel` — positive integer, must be declared in `datatype`
- `value` — finite number (SQLite REAL storage). Use integers for whole values and floats for scaled values
- `unit` — must be a **canonical BACnet unit name** from the allowed list, or `null` when the object has no unit (e.g. `BinaryInputObject`)

⚠️ Do not use display units like `"°C"` or `"%"`. Use the canonical names:

| Measurement | Canonical unit name |
|-------------|---------------------|
| Temperature | `degreesCelsius` |
| Humidity (RH) | `percent` or `percentRelativeHumidity` |
| Battery / level | `percent` |
| Distance | `millimeters` |
| Gas concentration | `partsPerMillion` |
| Signal strength | `decibels` |
| Voltage | `millivolts` |
| Light intensity | `luxes` |
| Unitless (binary/status) | `null` |

The full allowed unit list lives in `scripts/lib/units.js` (`ALLOWED_UNITS`). The unit in `expectedOutput` must match `datatype.<channel>.units`.

### downlinkTestCases

```json
{
  "name": "Close Valve",
  "channel": 10,
  "value": 1,
  "expectedFPort": 5,
  "expectedBytes": "73 01",
  "citation": "Issue #38 Downlink Command Examples"
}
```

- `channel` and `value` are passed to `Encode`.
- `expectedFPort` must equal the writable datatype object's `fport` and be in the range 1–254.
- `expectedBytes` is an exact hexadecimal oracle from a known payload or complete official protocol documentation.
- Strict fixtures must cover every writable datatype channel. Unknown channels and non-numeric values must fail closed with an empty `bytes` array and a non-empty `errors` array.
- Passing this check verifies codec behavior, not the physical device action; hardware verification remains separate.

---

## 🔍 Running Validation

### Step 3: Decode a Single Payload Interactively

```bash
node scripts/test-codec.js \
  -f profiles/Vendor/Vendor-Model.yaml \
  -p 10 \
  -u 0175640500000482b3
```

Output shows the decoded `data` array, which is what you should put into `expectedOutput` (after independently confirming it is correct).

### Step 4: Validate One Profile with Its Fixture

```bash
node scripts/run-profile-ci.js \
  profiles/Vendor/Vendor-Model.yaml \
  --fixture profiles/Vendor/tests/Vendor-Model.test.json
```

`run-profile-ci.js` is the strict CI entrypoint used by the Profile Automation workflow. It runs:
- YAML syntax, JSON Schema, required fields
- Codec static safety analysis and syntax
- BACnet object configuration and file naming
- Profile semantics (datatype ordering, units, mapping rules)
- Full fixture execution

Each check prints `PASS` or `FAIL` with detailed errors.

### Step 5: Validate All Committed Fixtures

```bash
node scripts/validate-committed-fixtures.js
```

This finds every `*.test.json` under `profiles/`, pairs it with its Profile, and validates it. It is one of the required repository checks:

```bash
node scripts/validate-all.js                  # All Profile YAML files (basic)
node scripts/validate-committed-fixtures.js   # All committed test fixtures
node scripts/validate-registry.js             # registry.json
node scripts/test-profile-automation.js       # Automation regression tests
```

---

## ✅ What the Fixture Validator Checks

For every test case the validator:

1. **Runs the decoder twice** and requires identical output (determinism)
2. **Compares the `data` array** with `expectedOutput` using deep equality (array order matters, object key order does not)
3. **Validates each decoded entry**:
   - `channel` is a positive integer declared in `datatype`
   - No duplicate channels in one decode result
   - `name` equals `datatype.<channel>.name`
   - `unit` equals `datatype.<channel>.units` (or `null`)
   - `value` is a finite number
4. **Checks channel coverage**: every non-output `datatype` channel must appear in at least one test result. For `known-answer`/`decoder-derived` fixtures a gap is an error; for `documentation-only` it is a warning
5. **Runs robustness checks** according to `robustness` and `fPortPolicy`
6. **Runs every downlink case twice**, checks exact bytes and fPort, and requires all writable channels to be covered in strict fixtures

Additional contract checks apply to `strict: true` fixtures:
- BinaryInputObject values must be exactly `0` or `1`
- On success the decoder must omit `errors`; on failure it must return a non-empty string array and no `data`

---

## ⚠️ Common Errors and Solutions

### Error 1: Fixture profile mismatch

```
Fixture profile 'Vendor-Model' must equal 'Vendor-ModelX'
```

The `profile` field must exactly match the YAML filename (without extension).

### Error 2: Unit mismatch

```
Channel 1 unit '°C' does not match datatype unit 'degreesCelsius'
```

Use the canonical BACnet unit names from `scripts/lib/units.js`. Display strings such as `°C` or `%` are not allowed.

### Error 3: known-answer fixture has no expectedOutput

```
known-answer fixtures must contain at least one expectedOutput
```

`known-answer` and `decoder-derived` fixtures must embed expected outputs. Only `documentation-only` fixtures may omit them.

### Error 4: Decoded channel not declared in datatype

```
Decoded channel 9 is not declared in datatype
```

Every entry the decoder produces must map to a channel in the Profile's `datatype`. Add the channel or fix the decoder.

### Error 5: Missing channel coverage

```
Test fixtures do not cover datatype channels: 4, 5
```

Add test cases that produce these channels, or (for `documentation-only`) accept the warning.

### Error 6: Truncation / unknown fPort robustness failure

```
truncated length 4: decoder must return an errors array
```

The decoder must gracefully reject invalid input by returning `{ data: [], errors: ["..."] }` (or `{ errors: [...] }`) instead of throwing or returning partial data. `fPortPolicy` controls which fPorts are considered valid.

### Error 7: Actual output does not match expectedOutput

```
Test case 'X': Actual output does not match expectedOutput
```

Re-decode the payload with `test-codec.js`, confirm the correct values, then update `expectedOutput`. Watch for numeric format (`25` vs `25.0` is fine in JSON, but the arrays must otherwise match exactly) and array element order.

---

## 🏢 Multiple Models

There is no `model` field inside test cases. Each fixture is bound to exactly one Profile via the `profile` field and the file name. When a vendor ships several models, create one fixture per model:

```
profiles/Senso8/
├── Senso8-LRS20100.yaml
├── Senso8-LRS20200.yaml
├── Senso8-LRS20600.yaml
└── tests/
    ├── Senso8-LRS20100.test.json
    ├── Senso8-LRS20200.test.json
    └── Senso8-LRS20600.test.json
```

Use `reviewMode: "multi-model"` in each fixture to signal the models share a protocol family.

---

## 🎯 Best Practices

### 1. Cover Every Channel

The validator enforces that all non-output `datatype` channels appear in at least one test case. Plan test cases so each channel is produced at least once, including alarm/status channels.

### 2. Use Real Payloads

Prefer payloads captured from real devices, official documents, or the requesting Issue. Mark where each vector came from in `sources` with `type`, `reference`, and `citation`.

### 3. Set the Correct evidenceLevel

- Only use `known-answer` when the expected values are independently confirmed
- Use `documentation-only` when values are parsed from documentation alone
- Use `decoder-derived` for outputs produced by the decoder under review

### 4. Keep Units Canonical

Never use display units in `expectedOutput`. Copy the unit from `datatype` (`degreesCelsius`, `percent`, `partsPerMillion`, `millimeters`, etc.) or use `null` for unitless objects.

### 5. Write Clear Descriptions

```json
{
  "name": "Low temperature alarm",
  "fPort": 10,
  "input": "0801640100000000ffdc",
  "description": "Temperature=-5C, triggers low temperature alarm, battery=100%"
}
```

### 6. Run Validation After Every Codec Change

```bash
node scripts/run-profile-ci.js \
  profiles/Vendor/Vendor-Model.yaml \
  --fixture profiles/Vendor/tests/Vendor-Model.test.json
node scripts/validate-committed-fixtures.js
```

---

## 🛠️ Debugging Tips

### Inspect a Single Payload

```bash
node scripts/test-codec.js -f profiles/Vendor/Vendor-Model.yaml -p 10 -u 0175640500000482b3
```

### Batch-Test an Existing Data File

`test-codec.js` also supports a batch mode against a JSON test-data file:

```bash
node scripts/test-codec.js --batch profiles/Vendor/Vendor-Model.yaml \
  examples/minimal-profile/tests/test-data.json
```

### Validate JSON Syntax

```bash
jq . profiles/Vendor/tests/Vendor-Model.test.json
```

---

## ✅ Checklist

Confirm before submitting a Profile:

- [ ] Created `tests/Vendor-Model.test.json` next to the Profile
- [ ] `schemaVersion: 1` and `profile` matches the YAML filename
- [ ] `evidenceLevel` and `sources` describe where the vectors came from
- [ ] At least one `expectedOutput` (unless `documentation-only`)
- [ ] Every non-output `datatype` channel is covered by at least one test case
- [ ] `expectedOutput` uses canonical BACnet units that match `datatype`
- [ ] When writable datatype channels exist, `downlinkTestCases` covers every writable channel
- [ ] `node scripts/run-profile-ci.js` passes for the Profile and its fixture
- [ ] `node scripts/validate-committed-fixtures.js` passes

---

## 📚 Examples

Real committed fixtures:

- `profiles/Milesight/tests/Milesight-EM410-RDL.test.json`
- `profiles/Milesight/tests/Milesight-WT304.test.json`
- `profiles/QingPing/tests/QingPing-CGP22CLH.test.json`
- `profiles/Thermokon/tests/Thermokon-NOVOS3-OccLumCO2TempRH.test.json`
- `profiles/Eddy-Solutions/tests/Eddy-Solutions-LoRa-IQ-V2.test.json` (includes Issue #38 downlink vectors)

---

**Last Updated**: 2026-08-28
