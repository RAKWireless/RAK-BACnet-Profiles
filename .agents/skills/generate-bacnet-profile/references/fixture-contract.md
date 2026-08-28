# Fixture contract

Use schema version 1, set `strict: true`, and cover every unique Issue uplink
payload. Include exact `expectedOutput` for every payload whose values can be
recomputed. Fixture output order must match codec output order. When downlink
is requested, also include a `downlinkTestCases` entry for every complete Issue
vector and enough cases to cover every writable datatype channel. Official
documentation may supply deterministic expected bytes when no Issue vector is
available.

Use this canonical top-level and nested shape. Replace the example values but
do not rename keys, turn source objects into strings, wrap the payload in an
object, or omit `name`, `fPort`, or string `input` from a test case.

<!-- canonical-fixture:start -->
```json
{
  "schemaVersion": 1,
  "strict": true,
  "profile": "Vendor-Model",
  "evidenceLevel": "known-answer",
  "reviewMode": "single-model",
  "fPortPolicy": {
    "mode": "fixed",
    "ports": [85],
    "citation": "Prepared evidence citation"
  },
  "sources": [
    {
      "type": "issue",
      "reference": "Prepared Issue evidence",
      "citation": "Known uplink payload"
    }
  ],
  "robustness": {
    "checkTruncation": true,
    "checkUnknownFPort": true,
    "checkFuzz": true
  },
  "testCases": [
    {
      "name": "Known uplink sample",
      "fPort": 85,
      "input": "0102",
      "expectedOutput": [
        {
          "name": "Temperature",
          "channel": 1,
          "value": 23.5,
          "unit": "degreesCelsius"
        }
      ]
    }
  ],
  "downlinkTestCases": [
    {
      "name": "Set temperature",
      "channel": 11,
      "value": 22.5,
      "expectedFPort": 85,
      "expectedBytes": "55 01 00 02 05 2D 8A",
      "description": "Known downlink command",
      "citation": "Prepared Issue or official-document evidence"
    }
  ]
}
```
<!-- canonical-fixture:end -->

Omit the entire `downlinkTestCases` key when the request is uplink-only. When
downlink is requested, the key is required and must contain at least one case.

The `profile` value is the Profile filename without `.yaml`. Allowed source
`type` values are `issue`, `official-document`, `vendor-decoder`, and
`customer-data`.

Select one evidence level: `known-answer`, `documentation-only`, or
`decoder-derived`. List sources without embedding private contact information,
full documents, or decoder source.

Select one fPort policy:

- `fixed`: evidence identifies one or more real fPorts and the codec rejects
  other ports.
- `agnostic`: evidence proves all fPorts 1-254 behave identically;
  use a representative application port and reject 0 and 255.
- `ignored`: neither Issue nor protocol evidence specifies fPort and the codec
  is entirely payload-driven. Use `representativeFPort: 1` only as a test-call
  placeholder and explain why. Do not claim it is the device's actual fPort.

The fixture's `evidenceLevel` and complete `fPortPolicy` object must match the
final structured Agent result exactly. Reuse the same values and citation text;
do not shorten or rephrase them when producing the result JSON.

Every new strict candidate must include this exact robustness shape:

```json
"robustness": {
  "checkTruncation": true,
  "checkUnknownFPort": true,
  "checkFuzz": true
}
```

For `ignored`, do not add fPort-dependent branches and set
`robustness.checkUnknownFPort` to `false`. For all modes,
`robustness.checkTruncation` and `robustness.checkFuzz` must remain explicitly
set to `true`; omitting them is a validation error.

Once a committed fixture has `strict: true`, repository CI permanently applies
candidate-strict validation to that Profile.

Each downlink case uses the BACnet `channel` and finite numeric `value` passed
to `Encode`, the `expectedFPort` declared on that datatype object, and exact
hexadecimal `expectedBytes`. Include all complete Issue vectors even when
several exercise the same channel. On strict fixtures the validator also
requires unknown channels and non-numeric values to fail closed.

Documentation-only cases may warn about missing independent oracles, but every
declared channel still needs executable fixture coverage. Known-answer and
decoder-derived fixtures require complete expected output and are hard gates.
