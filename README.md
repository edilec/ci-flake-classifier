# CI Flake Classifier

Offline, read-only classification of **exported** CI attempt history. It never reruns tests, queries a CI service, changes a build, or assigns blame. Identity, revision and environment must all match before outcomes are compared.

## Run

Node.js 22+, zero dependencies. From this repository:

```sh
node bin/ci-flake-classifier.mjs --root examples --input passing.json
node bin/ci-flake-classifier.mjs --root examples --input failing.json
npm run check
```

`--root` confines reads by real path; `--input` is a relative file inside it. Optional `--human` prints one summary on stderr. Stdout is only the JSON report. There is no output-file option. Unknown/duplicate arguments or missing root/input: exit 2 and empty stdout. Unreadable, malformed, non-UTF-8, partial or unsupported evidence: incomplete JSON and exit 2. Classified intermittent/repeatable failure: exit 1. All sufficiently sampled groups pass: exit 0.

## Export and classifications

Input is `{"schemaVersion":"1","complete":true,"attempts":[...]}`. Each attempt has opaque `testId`, `revision`, `environment`, `result` (`pass` or `fail`) and optional ignored `note`. The array order is the retry order. A group is the exact tuple `(testId, revision, environment)`; different revisions/environments never combine. At least three attempts per group are needed to distinguish patterns.

| Group outcomes | Label / finding | Overall result |
| --- | --- | --- |
| all pass, at least 3 | `clean` | pass 0 |
| all fail, at least 3 | `repeatable`, `repeatable-failure` | fail 1; never labeled flaky |
| pass and fail, at least 3 | `intermittent`, `intermittent-failure` | fail 1 |
| fewer than 3 | `inconclusive`, `insufficient-reruns` | incomplete 2 |
| invalid/empty/partial export or limit | named rule | incomplete 2 |

`classifications` retains every source ordinal and pass/fail outcome in order; no attempt is truncated. Confidence is a documented **sample-size heuristic**, not a statistical probability: `high` requires at least five attempts (and at least two of each outcome for intermittent); other classified groups are `medium`; fewer than three are `insufficient`. A mixed-outcome label is evidence of intermittence in the export, not proof of a root cause. `@export` is a logical source role for `--input`; finding pointers and source ordinals locate the exact rows. Raw IDs, revision strings, environment names, notes and host paths are not emitted. Findings use UTF-16 code-unit sorting by `(location.file, location.pointer, ruleId)`.

## Limits and non-goals

1,048,576 UTF-8 bytes; 200 attempts; JSON depth 3 from root depth 0; 5,000 ms with injectable library clock. Exact N accepted, N+1 incomplete. Strict UTF-8 and duplicate JSON key rejection (including escaped keys) prevent ambiguous evidence. CLI file read has a 5-second abort. No network, retry execution, statistical significance claim, owner attribution, or auto-fix.
