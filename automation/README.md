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

The official document and any decoder evidence are downloaded in a separate job that has no model-provider secrets. Decoder discovery uses this order: an inline function in the Issue, a decoder link in the Issue, then a constrained GitHub code search using Device Vendor + Device Model. Any decoder explicitly supplied in the Issue is authoritative protocol evidence without publisher or repository verification; only automatically discovered decoders remain supporting evidence. Protocol authority never makes decoder text executable: downloaded decoder text is retained as data and is never run. Generated codec code is executed only in the isolated validation job.

Generation receives the formal `Thermokon-NOVOS3-OccLumCO2TempRH` Profile and its committed fixture as a repository layout reference. The prompt explicitly identifies its historical downlink, loop, partial-payload, and robustness patterns as legacy behavior that must not be copied. Generation also receives the closest historical Profile's BACnet datatype and LoRaWAN metadata as a mapping reference; current uplink-only and fail-closed requirements remain authoritative.

## Scope

- New Profiles only.
- Uplink-only devices only.
- Machine-readable PDF, HTML, or text documentation is preferred; OCR is not supported. A usable decoder can keep evidence extraction available when the document download fails.
- BACnet mapping remains required in the Issue form, either as explicit rows or as an explicit official-document page reference from which canonical mappings can be extracted.
- A known-answer payload is preferred but optional. Documentation-only profiles are clearly marked and remain `verified: false`.
- Missing fPort is deferred to evidence extraction instead of rejected at Intake. Automation must resolve it to cited fixed ports or prove that the payload protocol is port-agnostic; otherwise the submitter is asked for actual Network Server uplink metadata.

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

The generation job emits live progress without printing prompts, source text, model output, or API keys. Logs identify the evidence, generation, normalization, protocol review, and adversarial review phases; model HTTP attempts report status, elapsed time, retry decisions, token usage when available, and a waiting heartbeat every 60 seconds.

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
