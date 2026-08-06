# BACnet Profile Automation

Profile Automation turns a complete GitHub Profile Request into an uplink-only Draft PR. It is intentionally evidence-gated: missing or conflicting protocol facts stop the workflow and ask the submitter to edit the original Issue.

## Production flow

1. `profile-intake.yml` validates the Issue form without LLM secrets.
2. `profile-build.yml` extracts evidence, generates a candidate, and performs independent model reviews.
3. `profile-validate-candidate.yml` executes the generated codec in a no-network, read-only, resource-limited container with no secrets.
4. A Draft PR is created only after all model and JavaScript checks pass.
5. The PR head branch is explicitly dispatched to `validate-profiles.yml`, because PRs created with `GITHUB_TOKEN` do not emit a normal PR workflow run.
6. An authorized `Request changes` review regenerates the same PR. The bot never merges.
7. After merge, the Issue closes with `profile:unverified`; real-hardware verification remains separate.

The official document is downloaded and parsed in a separate job that has no model-provider secrets. Generated codec code is executed only in the isolated validation job.

Generation receives the complete, machine-validated uplink-only Profile and fixture under `automation/examples/canonical/` as its structural reference. It also receives the closest historical Profile's BACnet datatype and LoRaWAN metadata as a mapping reference; legacy codec code is intentionally not copied.

## Scope

- New Profiles only.
- Uplink-only devices only.
- Machine-readable PDF, HTML, or text documentation; OCR is not supported.
- BACnet mapping remains required in the Issue form.
- A known-answer payload is preferred but optional. Documentation-only profiles are clearly marked and remain `verified: false`.

## Repository configuration

Configure one primary OpenAI-compatible model:

| Type | Name |
|---|---|
| Secret | `PROFILE_MODEL_1_API_KEY` |
| Variable | `PROFILE_MODEL_1_BASE_URL` |
| Variable | `PROFILE_MODEL_1_NAME` |

An optional independent reviewer uses `PROFILE_MODEL_2_API_KEY`, `PROFILE_MODEL_2_BASE_URL`, and `PROFILE_MODEL_2_NAME`.

Each configured model must provide all three values. If the optional second model is omitted, the primary model performs both generation and review.

Model requests time out after 300 seconds and retry transient timeouts, HTTP 429, and HTTP 5xx responses up to two times. Set the optional repository variable `PROFILE_MODEL_TIMEOUT_MS` to override the per-request timeout in milliseconds.

Optional repository variable `PROFILE_APPROVERS` is a comma-separated GitHub login allowlist for automated `Request changes` handling. If omitted, collaborators with write, maintain, or admin permission are accepted.

In **Settings → Actions → General → Workflow permissions**, enable **Allow GitHub Actions to create and approve pull requests**. The automation uses that permission only to create or update a Draft PR; it never submits an approval or merges.

Set hard daily spending limits in each model provider account. GitHub Actions concurrency and the three-attempt limit prevent runaway retries, but provider-side budget controls are the final cost boundary.

Branch protection for `main` should require:

- `Validate BACnet Profiles / validate` to pass.
- One CODEOWNER approval.
- Stale approvals dismissed after new commits.
- No bot or administrator bypass for the automation token.

## Generated files

```text
profiles/<Vendor>/<Vendor>-<Model>.yaml
profiles/<Vendor>/tests/<Vendor>-<Model>.test.json
registry.json
```

All executable validation and test programs are `.js` files under `scripts/`. Test fixtures contain data only.

## Local checks

```bash
npm ci --prefix scripts
npm ci --prefix automation

node scripts/test-profile-automation.js
node scripts/validate-all.js
node scripts/validate-committed-fixtures.js
```

Validate a generated candidate:

```bash
node scripts/run-profile-ci.js \
  profiles/Acme/Acme-T100.yaml \
  --fixture profiles/Acme/tests/Acme-T100.test.json
```

## Shadow rollout

Run the `Profile Automation - Shadow Evaluation` workflow with a JSON list of 10–20 historical Issue numbers. It never creates a PR or changes an Issue. The final job measures the agreed target: at least 85% automatic success among requests that pass the eligibility gate.
