# Fixture contract

Use schema version 1, set `strict: true`, and cover every unique Issue uplink payload. Include exact
`expectedOutput` for every payload whose values can be recomputed. Fixture
output order must match codec output order.

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

For `ignored`, do not add fPort-dependent branches and disable unknown,
alternate, and reserved-port checks. For all modes, keep truncation and seeded
fuzz checks enabled for new candidates.

Once a committed fixture has `strict: true`, repository CI permanently applies
candidate-strict validation to that Profile.

Documentation-only cases may warn about missing independent oracles, but every
declared channel still needs executable fixture coverage. Known-answer and
decoder-derived fixtures require complete expected output and are hard gates.
