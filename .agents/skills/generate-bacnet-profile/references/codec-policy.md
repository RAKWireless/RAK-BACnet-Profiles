# Codec policy

Provide both `Decode(fPort, data, variables)` and `decodeUplink(input)`.
`Decode` is the authoritative parser and returns the BACnet row array directly.
`decodeUplink` must call `Decode` and wrap a successful result as
`{ data: rows }`; never make `Decode` delegate to `decodeUplink`. Omit `errors`
on successful results instead of returning `errors: []`. Invalid, truncated,
unsupported, or internally inconsistent frames must fail closed as
`{ data: [], errors: [message] }`. Do not return partially decoded BACnet data
after a frame error.

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

## Downlink encoding

When the request supports downlink, provide both `Encode(data, variables)` and
`encodeDownlink(input)`. `Encode` is authoritative and returns the byte array
directly. `encodeDownlink` must call `Encode` and wrap success as
`{ bytes: bytes }`; never make `Encode` delegate to `encodeDownlink`. The
transmit fPort comes from the matching `datatype` channel's `fport` field, not
from an invented codec default.

Accept only a positive integer `data.channel` declared as writable and a finite
numeric `data.value`. Apply documented enum, range, scale, rounding,
endianness, length, and checksum rules. Successful bytes must be a non-empty
array of at most 255 integers from 0 through 255. The same input must always
produce the same result.

Unsupported channels, non-numeric values, and values rejected by the protocol
must fail closed as `{ bytes: [], errors: [message] }`. Omit `errors` on
success. Do not emit an empty byte array as a successful command, silently
clamp an out-of-range value, or guess a command from the object name. Issue
known vectors and complete official documentation are downlink evidence; the
optional uplink decoder is not a downlink authority unless it explicitly
contains independently verifiable encoding logic.
