# Profile contract

Generate only:

```text
profiles/<Vendor>/<Vendor>-<Model>.yaml
profiles/<Vendor>/tests/<Vendor>-<Model>.test.json
```

Use the exact paths supplied by `request.json`. The vendor directory, filename,
`model`, and `vendor` fields must agree. New Profiles start with
`profileVersion: 1.0.0`, `verified: false` when supported by the schema, and a
new UUID v4 `id`.

The first version supports one new device and uplink only. Do not add `Encode`,
`encodeDownlink`, output object types, downlink fPorts, or multiple device
variants. Do not overwrite a Profile already present on the base branch.

Map every requested BACnet point exactly. Channel numbers must be stable,
positive, and unique. Codec output `name`, `channel`, and `unit` must exactly
match `datatype`. Use supported repository BACnet types and units. Binary input
objects use `unit: null` in decoded output and do not declare YAML units.

Do not edit `registry.json`; the publish job regenerates it deterministically.
Do not edit schemas, tests, workflows, Skills, or validation scripts.
