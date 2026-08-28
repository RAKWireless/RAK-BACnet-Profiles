# Profile contract

Generate only:

```text
profiles/<Vendor>/<Vendor>-<Model>.yaml
profiles/<Vendor>/tests/<Vendor>-<Model>.test.json
```

Use the exact paths supplied by `request.json`. The vendor directory, filename,
`model`, and `vendor` fields must agree. New Profiles start with
`profileVersion: 1.0.0` and a new UUID v4 `id`. Set `name` to the device model
from the request, without repeating the vendor or the full `<Vendor>-<Model>`
profile identifier. Do not add `verified`; verification state belongs to the
generated registry entry, not the Profile YAML schema.

Write top-level YAML sections in this exact order:

```text
codec
datatype
lorawan
model
profileVersion
name
vendor
id
```

Within each `datatype` channel, write fields in this order when present:
`name`, `type`, `units`, `covIncrement`, `updateInterval`, `fport`, `channel`.
Every new channel must declare `channel` explicitly. Do not alphabetize or
move metadata ahead of `codec`.

The automation supports one new device with uplink and requested downlink. Do
not add downlink objects or codec entrypoints when the request says the device
is uplink-only. Do not add multiple device variants or overwrite a Profile
already present on the base branch.

Map every requested BACnet point exactly. Channel numbers must be stable,
positive, and unique. Codec output `name`, `channel`, and `unit` must exactly
match `datatype`. Use supported repository BACnet types and units. Binary input
objects use `unit: null` in decoded output and do not declare YAML units.

For requested downlink, use the same stable positive channel as the writable
BACnet object. `AnalogOutputObject` and `BinaryOutputObject` are writable and
must declare `fport`. A Value object with an explicit `fport` is also writable.
Every downlink fPort must be an integer from 1 through 254. The Profile's
`datatype.<channel>.fport` is authoritative for transmission; do not derive or
guess it from an unrelated uplink port.

Do not edit `registry.json`; the publish job regenerates it deterministically.
Do not edit schemas, tests, workflows, Skills, or validation scripts.
