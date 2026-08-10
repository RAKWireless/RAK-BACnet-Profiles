# Codec policy

Provide both `Decode(fPort, data, variables)` and `decodeUplink(input)`.
Return BACnet rows as an array. Invalid, truncated, unsupported, or internally
inconsistent frames must fail closed: return no BACnet data and include a
non-empty `errors` array from `decodeUplink`. Do not return partially decoded
BACnet data after a frame error.

Allowed protocol techniques include fixed and dynamic layouts, byte cursors,
bounded `for`, `while`, and `do...while` loops, repeated records, bit fields,
bounded varints, and `try/catch`. Loop conditions must depend on a finite array
length or explicit small bound; cursor variables must advance monotonically on
every continuing path; maximum nesting depth is two. Bound varints explicitly
and reject overlong values. Payloads never exceed 255 bytes.

Forbidden behavior includes `eval`, `new Function`, string-based constructors,
dynamic import, `require`, module/global/process access, networking, timers,
workers, nondeterministic time or randomness, recursion, prototype traversal,
and generated WebAssembly.

Check the complete frame structure before publishing data: minimum lengths,
declared lengths, record boundaries, selectors, and required trailers. Avoid
reading beyond the byte array. Use explicit endian and signed conversions.
Never execute the supplied decoder; independently reproduce only its verified
protocol logic.

Every decoded `value` is persisted in a SQLite `REAL` column and must therefore
be a finite JavaScript number. Never emit a string, boolean, `null`, `NaN`, or
infinity as a BACnet value. Encode boolean semantics as `false = 0` and
`true = 1`; `BinaryInputObject` values must be exactly `0` or `1`.

For enums, events, modes, versions, and other symbolic values, preserve the
documented protocol or decoder numeric code/bitmask whenever one exists. If the
evidence defines only labels, assign stable numeric codes `1, 2, 3, ...` in
evidence order. Put an adjacent codec comment that declares every code-to-label
mapping, and record the same mapping in the evidence matrix. Do not renumber a
documented code, derive a value from label text, or emit the label itself.
