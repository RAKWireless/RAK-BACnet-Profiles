# Profile Tooling

All validation and test programs are Node.js files under `scripts/`. Public commands stay at the directory root; reusable implementation code is under `lib/`, and data-only validation definitions are under `schemas/`.

## Layout

```text
scripts/
├── evaluate-shadow-run.js       # Evaluate the 85% shadow target
├── generate-expected-output.js  # Generate expected codec output
├── run-profile-ci.js            # Strict generated-profile CI entrypoint
├── test-profile-automation.js        # Profile Automation regression tests
├── test-codec.js                # Interactive and batch codec testing
├── update-registry.js           # Regenerate registry.json
├── validate-all.js              # Validate every committed Profile
├── validate-committed-fixtures.js
├── validate-profile.js          # Validate one Profile
├── validate-registry.js         # Validate registry.json
├── lib/
│   ├── codec-sandbox.js
│   ├── hex-converter.js
│   ├── units.js
│   ├── yaml-parser.js
│   └── validation/              # Reusable validation modules
└── schemas/                     # JSON Schemas and BACnet mapping rules
```

Files under `lib/` are internal modules. Workflows and documentation should invoke the root-level commands instead of depending on internal module paths.

## Install

From the repository root:

```bash
npm ci --prefix scripts
```

## Common commands

Run the complete local CI set:

```bash
npm run ci --prefix scripts
```

Validate all Profiles:

```bash
node scripts/validate-all.js
```

Validate one Profile:

```bash
node scripts/validate-profile.js profiles/Vendor/Vendor-Model.yaml
```

Run strict generated-profile validation with its committed fixture:

```bash
node scripts/run-profile-ci.js \
  profiles/Vendor/Vendor-Model.yaml \
  --fixture profiles/Vendor/tests/Vendor-Model.test.json
```

Test a codec payload:

```bash
node scripts/test-codec.js \
  --file profiles/Vendor/Vendor-Model.yaml \
  --port 10 \
  --uplink 01020304
```

Regenerate and validate the registry:

```bash
node scripts/update-registry.js
node scripts/validate-registry.js
```

## npm aliases

| Command | Purpose |
|---|---|
| `npm test --prefix scripts` | Run Profile Automation regression tests |
| `npm run test:codec --prefix scripts -- ...` | Run the codec CLI |
| `npm run test:fixtures --prefix scripts` | Validate committed `.test.json` fixtures |
| `npm run validate:all --prefix scripts` | Validate all Profile YAML files |
| `npm run validate:registry --prefix scripts` | Validate `registry.json` |
| `npm run registry:update --prefix scripts` | Regenerate `registry.json` |
| `npm run ci --prefix scripts` | Run the standard local CI suite |

## Conventions

- New executable tests and validators must be `.js` files under `scripts/`.
- Keep stable user-facing commands at the root of `scripts/`.
- Put shared code in `scripts/lib/` and validation definitions in `scripts/schemas/`.
- Test fixture files contain data only and live beside Profiles at `profiles/<Vendor>/tests/*.test.json`.
- Generated codec execution must use `run-profile-ci.js`, which applies static checks and the restricted codec runtime.
