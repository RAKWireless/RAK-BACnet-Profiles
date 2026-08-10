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
