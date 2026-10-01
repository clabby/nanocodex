# Offline App Intents processor fixtures

This is experimental research, **not integrated with IPA creation or signing**.

- `inbox.swiftconstvalues.json`, `widgets.swiftconstvalues.json`: sanitized actual
  Linux compiler outputs from build 1790730578. Only source `file`/`line` fields
  were removed. All compiler AST fields, wrappers, runtime unknowns and aliases
  remain. Exact original input SHA256s are recorded in the task evidence report.
- `ota-{main,widgets}.{extract.actionsdata,version.json}`: exact bytes extracted
  from independently downloaded current public Mac-built OTA 1790623764. The
  full IPA SHA256 is `a852b91c70381a86cf68fd7d33f3f69af43cd47af07a01450544e9a354d08450`.
  Generator is `xcode-tools` `17F113`. `provenance.json` records hashes of all
  metadata files, including main-app NLU files kept in the task evidence tree.

The two builds are **not a proven paired-source/compiler reference**. Tests find
101 exact comparable compiler facts matching the main metadata and 22 matching
widget metadata. This does not determine universal meanings of private numeric
codes, unknown compiler Runtime values, or prove Siri/device discovery. No real
emission profile has been created from the old OTA metadata.

The unit tests' `synthetic_reference()` payloads are container-contract mocks,
not Apple output. Their type/mode/auth codes use obvious string sentinels instead
of pretending to know numeric mappings.

## Run

```
python3 apple/scripts/test-appintents-processor-linux.py -v
python3 apple/scripts/appintents-linux.py analyze --module NanocodexInbox \
  --const-values apple/xtool/appintents-fixtures/inbox.swiftconstvalues.json \
  --output /path/to/new-inbox-ir.json
python3 apple/scripts/appintents-linux.py compare-reference --module NanocodexInbox \
  --const-values apple/xtool/appintents-fixtures/inbox.swiftconstvalues.json \
  --actionsdata apple/xtool/appintents-fixtures/ota-main.extract.actionsdata \
  --version-json apple/xtool/appintents-fixtures/ota-main.version.json \
  --output /path/to/new-comparison.json
```

`analyze` emits path-independent, validated semantic IR. It preserves 12 main
and 5 widget actions; all seven shortcuts; 19 main and 3 widget typed parameters;
entity/defaultquery/query aliases; parameter defaults/summary/keypaths; localized
strings; symbolic auth/mode AST. Unknown Runtime nodes are listed explicitly
(66 main, 9 widget), not converted into defaults. Unknown value kinds, novel
primitive parameter types, nested/conditional shortcut builders, incomplete
references, broken peers and duplicate JSON keys fail closed.

## Narrow reference replay, not a schema synthesizer

`reference` requires the SAME-BUILD Apple compiler constants, actual extractor
pair and capture provenance; compiler/metadata comparisons must agree. It binds
exact compiler semantics, complete Swift source manifest and explicit build
context (`sdkBuild`, `swiftCompilerVersion`, `targetTriple`, `bundleIdentifier`,
`buildMode`). Every declaration source must lie inside the source root.

For shortcuts, a complete `--metadata-dir` capture with opaque NLU sidecars is
required: a pair-only main reference is rejected to prevent silently losing NLU.
`emit` replays the captured bytes only after all bindings and checksums match.
It refuses existing outputs. It cannot change identities, SDK/compiler defaults,
policy or modes, and cannot generate new NLU data. Operator capture evidence is
not cryptographic Apple attestation; accurate same-build pairing is required.
The public OTA fixture alone cannot establish this pairing.

There is **no general Linux Apple-schema metadata synthesis**, no real build
injection, no signing/deploy work and no Siri-on-device proof here. That is the
remaining boundary, not hidden behind generic type 0 or guessed policy bitfields.

## Superseding same-build Mac update

Root supplied15-file safe envelope verifiedSHA256
b4e61c7e0fbf3fb8094532ae0f100da18de9df63ecabb952871b0b12d4fbb6ee; allcontenthashes
matched. Six SAME-DerivedData compiler input copies in mac-compiler-inputs/{app,widgets}
normalize EXACTLY to the current Linux declarations (zero semantic differences).
This resolves the earlier missing reference compiler-input boundary, and is tested.
CLI calibrate verifies Linux input against paired Mac compiler facts and metadata,
recording exact AST/code bindings in THIS capture only; it emits calibration
evidence, NOT a metadata profile or general synthesis. Universal numeric meanings,
immutable complete source/buildcontext, Runtime SDK defaults, query methods and
NLU generation remain separately unproven. No production metadata injection.


## Recovery review (2026-09-30)

`mac-metadata/{app,widgets}` now holds exact captured metadata bytes, and
`mac-paired-provenance.json` records original/sanitized hashes and explicit
source/SDK/NLU limitations. The paired compiler inputs have identical normalized
semantics to Linux fixtures; metadata are NOT byte-identical to public OTA
(array ordering differs). Calibration tests compare 101 app and 22 widget facts.
Neither calibration output nor this provenance file is an emission profile.

`reference` uses v2 profiles only and additionally requires
`--reference-source-manifest`, `--reference-context`, and `--metadata-inventory`
(filename-to-SHA256 map of the complete capture). Inventory includes the pair
and every opaque NLU sidecar. Separate operator capture records must match the
current source manifest, context, compiler facts and all payloads exactly.
These are consistency checks, not cryptographic Apple attestations. The supplied
Mac safe envelope has no NLU sidecars or immutable source/SDK context binding:
**it cannot provide a real main-app replay profile**.

The focused suite has 64 tests, including app/widget calibration CLI success
and failure, null/unsupported declarations, source symlink and location guards,
separate source/context bindings, sidecar inventory loss/tamper/path collisions,
and profile revalidation. Replay success controls use wholly MOCK source/context
and mock opaque sidecars in temporary directories; no production output is made.
The captured summary `table: NilLiteral` form is supported for comparison;
non-nil/runtime localization tables and unknown trailing forms fail closed.
