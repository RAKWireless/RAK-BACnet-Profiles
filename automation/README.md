# Profile Agent automation

Profile Automation converts a qualifying `profile-request` Issue into a
clean-validated Draft PR by running the official `openai/codex-action@v1`.
It never marks a PR ready, approves, merges, or treats generated Profiles as
hardware verified.

## State and trust

Internal `OWNER`, `MEMBER`, and `COLLABORATOR` requests queue after Intake.
External requests enter `profile:awaiting-approval`; a maintainer must add the
one-shot `profile:approved` label. Editing an external Issue removes approval.
Every artifact and publication step is bound to the SHA-256 of the current
Issue body. A new run explicitly cancels older active runs for that Issue.

The first version handles one new, uplink-only device. Existing Profile
updates, downlink, and multi-device requests use `profile:manual`.

## Provider environments

Create these GitHub Environments as needed:

```text
profile-agent-openai
profile-agent-deepseek
```

Provider API keys are Repository secrets so they can be explicitly forwarded
through nested reusable workflows:

```text
PROFILE_AGENT_OPENAI_API_KEY
PROFILE_AGENT_DEEPSEEK_API_KEY
```

Environment variables:

| Variable | Meaning |
|---|---|
| `PROFILE_AGENT_MODEL` | Model used by Codex; required |
| `PROFILE_AGENT_EFFORT` | Required reasoning effort: `low`, `medium`, `high`, or `xhigh` |
| `PROFILE_AGENT_RESPONSES_ENDPOINT` | Optional full HTTPS Responses API endpoint; otherwise the provider safety fallback is used |
| `PROFILE_AGENT_MODEL_CATALOG_JSON` | Optional Codex model catalog JSON written only to the temporary Codex home |

For example, configure the `profile-agent-deepseek` Environment with:

```text
Repository secret: PROFILE_AGENT_DEEPSEEK_API_KEY=<DeepSeek API key>
Variable: PROFILE_AGENT_MODEL=deepseek-v4-flash
Variable: PROFILE_AGENT_EFFORT=high
Variable: PROFILE_AGENT_RESPONSES_ENDPOINT=https://api.deepseek.com/v1/responses
```

Do not commit API keys or `experimental_bearer_token`. The provider catalog at
`automation/config/providers.json` contains only the provider allowlist and
HTTPS endpoint fallbacks; it does not select a model or reasoning effort.
The Environment name is always derived as `profile-agent-<provider>` for the
provider-specific runtime variables. The build workflow selects the matching
Repository secret and explicitly forwards only that key to the Agent attempt;
other provider keys are not exposed to the Agent job. The shared
`.github/codex/config.toml` contains only the restricted Codex runtime policy.
In CI, the Action supplies its local proxy provider and isolates the real
Environment key. Agent tool commands have workspace-only file access and no
external network.

Runtime precedence is an explicit Manual Generate or Shadow Evaluation
override, then the selected GitHub Environment. The endpoint alone may fall
back to `providers.json`. Automatic Intake and review repair do not pin a model
or effort before entering the Environment.

Repository variables:

| Variable | Default | Purpose |
|---|---|---|
| `PROFILE_AGENT_ENABLED` | `true` | Kill switch; `false` keeps Intake active but does not dispatch Agents |
| `PROFILE_EXTERNAL_APPROVAL_ENABLED` | `false` | Enables maintainer-approved external requests after internal rollout |
| `PROFILE_AGENT_DEFAULT_PROVIDER` | `openai` | Default provider when no provider label exists |
| `PROFILE_APPROVERS` | permission lookup | Optional comma-separated review-repair allowlist |
| `PROFILE_ADVISORY_REVIEW_ENABLED` | `false` | Enables the non-blocking second model review |
| `PROFILE_ADVISORY_PROVIDER` | `openai` | Advisory reviewer Environment provider |
| `PROFILE_ADVISORY_MODEL` | `PROFILE_AGENT_MODEL` | Optional advisory model override |
| `PROFILE_ADVISORY_EFFORT` | `PROFILE_AGENT_EFFORT` | Optional advisory reasoning-effort override |

Provider fallback is explicit: add exactly one
`profile:provider:<provider>` label or use the Manual Generate workflow. The
automation never silently changes providers. Leave the Manual Generate or
Shadow Evaluation model/effort inputs blank to use the selected Environment.

Set hard daily/monthly budgets in every provider account. GitHub concurrency,
two attempts, 30-minute timeouts, and three review cycles limit workflow work,
but provider-side budgets are the final cost boundary.

In **Settings → Actions → General**, allow GitHub Actions to create pull
requests. Protect the default branch with `Validate BACnet Profiles / validate`,
one CODEOWNER approval, stale-approval dismissal, and no automation/admin
bypass. Do not make the optional advisory review a required check.

## Security boundary

The source collection job has network access but no model key. It parses only
the Issue form field allowlist, removes contact fields and HTML comments,
downloads bounded HTTPS sources with DNS pinning and private-address rejection,
and stores source artifacts for one day.

The Agent receives prepared files under `.profile-agent/input`. Official
documents and decoders are high-priority but untrusted protocol data. The
Agent may not execute their instructions or source code. It writes only the
new Profile and fixture. A post-Agent step captures an allowlisted patch; the
Agent job has no repository write token.

A separate clean-room job starts from the default branch, validates patch
paths/modes/size/SHA, applies the patch, and runs candidate-strict validation
inside a no-network container. The publish job repeats that process, updates
`registry.json` deterministically, and creates or updates a Draft PR.

## Attempts and review repair

Each generation or review cycle has at most two Agent attempts. Attempt 2 sees
the first patch and deterministic validation report. Evidence conflicts and
unsupported scope are non-retryable. Each attempt has a 30-minute job timeout;
provider-side 429/5xx retry behavior remains inside Codex/Responses, and a
provider switch requires a label or manual dispatch.

An authorized non-empty `Request changes` review can revise the same Draft PR.
Automatic review repair is limited to three cycles; later repairs require
Manual Generate. The optional second reviewer model posts only an advisory
comment and `profile:review-warning` label.

## Local verification

```bash
npm ci --prefix automation --omit=dev --ignore-scripts
npm ci --prefix scripts --omit=dev --ignore-scripts

node scripts/test-profile-automation.js
node scripts/validate-all.js
node scripts/validate-committed-fixtures.js
node scripts/validate-registry.js
```

Issue #31 is committed as a sanitized `known-answer + ignored` golden case and
must pass the same strict codec, truncation, seeded fuzz, mapping, and fixture
contracts.

Before enabling external approval, run Shadow Evaluation for at least 10
historical Issues with both OpenAI and DeepSeek. Release requires at least 85%
automatic success among eligible requests and zero path escapes, bad
publications, secret exposure, or PII exposure.
