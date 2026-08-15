# Fixture contract

Use schema version 1, set `strict: true`, and cover every unique Issue uplink payload. Include exact
`expectedOutput` for every payload whose values can be recomputed. Fixture
output order must match codec output order.

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
  ]
}
```
<!-- canonical-fixture:end -->

The `profile` value is the Profile filename without `.yaml`. Allowed source
`type` values are `issue`, `official-document`, `vendor-decoder`, and
`customer-data`.

Select one evidence level: `known-answer`, `documentation-only`, or
`decoder-derived`. List sources without embedding private contact information,
full documents, or decoder source.

Select one fPort policy:

- `fixed`: evidence identifies one or more real fPorts and the codec rejects
  other ports.
- `agnostic`: evidence proves all application fPorts 1-223 behave identically;
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

Documentation-only cases may warn about missing independent oracles, but every
declared channel still needs executable fixture coverage. Known-answer and
decoder-derived fixtures require complete expected output and are hard gates.
