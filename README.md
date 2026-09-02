[![StepSecurity Maintained Action](https://raw.githubusercontent.com/step-security/maintained-actions-assets/main/assets/maintained-action-banner.png)](https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions)

# terraform-plan action

A StepSecurity maintained drop-in replacement for
[dflook/terraform-plan](https://github.com/dflook/terraform-plan), with the same
inputs and outputs.

Runs `terraform plan` and posts the result to the pull request, so the change can
be reviewed before it is applied. The comment it writes is what
[`terraform-apply`](https://github.com/step-security/dflook-terraform-apply)
later checks against, so a plan reviewed here is the plan that gets applied.

No state lock is taken and nothing is written, so it is safe to run alongside
other operations.

## Usage

```yaml
name: Plan

on: [pull_request]

permissions:
  contents: read
  pull-requests: write

jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - name: Plan
        uses: step-security/dflook-terraform-plan@v3
        with:
          path: infra
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`pull-requests: write` is needed to post the comment. Without `GITHUB_TOKEN` the
action fails rather than silently skipping the comment, since being asked to
comment and not doing so is a configuration mistake worth surfacing.

To branch on whether anything is changing:

```yaml
      - name: Plan
        id: plan
        uses: step-security/dflook-terraform-plan@v3

      - name: Something is changing
        if: steps.plan.outputs.changes == 'true'
        run: echo "${{ steps.plan.outputs.to_add }} to add, ${{ steps.plan.outputs.to_destroy }} to destroy"
```

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `path` | `.` | Directory holding the root module to plan. |
| `workspace` | `default` | Workspace to select before planning. |
| `label` | | Name for the environment, shown in the comment instead of the path. |
| `variables` | | Variable definitions in Terraform syntax, as in a tfvars file. |
| `var_file` | | Paths to tfvars files, one per line, relative to the workspace. |
| `backend_config` | | Backend settings as `key=value`, one per line. |
| `backend_config_file` | | Paths to backend config files, one per line, relative to the workspace. |
| `replace` | | Resource addresses to plan for replacement, one per line. |
| `target` | | Resource addresses to limit the plan to, one per line. |
| `destroy` | `false` | Plan the destruction of everything the module manages. |
| `refresh` | `true` | Set `false` to skip reconciling state with real resources first. |
| `add_github_comment` | `true` | Whether and how to comment. See below. |
| `parallelism` | `0` | Maximum concurrent operations. `0` leaves the limit to Terraform. |

`destroy` and `refresh` are changed only by the exact string `true` or `false`.
Anything else leaves the default in place.

### Commenting

`add_github_comment` takes four values:

- **`true`** — one comment per configuration, edited in place as the plan changes.
- **`changes-only`** — the same, except a plan with no changes will update an
  existing comment but never create one. A pull request that never had a plan
  does not get a comment just to say nothing is happening.
- **`always-new`** — supersede the previous comment and post a replacement, so
  the newest plan is the newest comment. The old one is marked superseded and
  collapsed, and can no longer approve an apply.
- **`false`** — post nothing.

Only runs triggered by a pull request related event can comment:
`pull_request`, `pull_request_target`, `pull_request_review`,
`pull_request_review_comment`, `issue_comment` and `repository_dispatch`.
Anything else is skipped with a note in the log rather than failing.

A pull request touching several modules gets a comment each. They are told apart
by workspace, `label`, the backend, and the arguments that shape the plan, so
each module's plan stays attached to its own comment.

### Variables

`variables` and `var_file` are both written into the module as auto-loaded
`.tfvars` files, so they apply to every command rather than only the one this
action runs directly. They are named so `variables` loads last, which is what
makes it override `var_file`:

```yaml
      - uses: step-security/dflook-terraform-plan@v3
        with:
          var_file: |
            common.tfvars
            production.tfvars
          variables: |
            image_id = "${{ secrets.AMI_ID }}"
```

The generated files are removed when the step finishes, including on failure, so
they cannot leak into a later step or an uploaded artifact.

Variables marked `sensitive` in the configuration are **named** in the comment
when supplied, without their values, so a reviewer can see that a value was
passed. The names themselves are not secret.

Because these change the plan, an apply must be given the same values or it will
find the plan has changed.

## Outputs

| Name | Value |
| --- | --- |
| `changes` | `true` when there is something to apply, `false` otherwise. |
| `plan_path` | Workspace-relative path to the saved plan file. |
| `json_plan_path` | Workspace-relative path to the plan in JSON format. |
| `text_plan_path` | Workspace-relative path to the plan as text. |
| `to_add` | Resources the plan would create. |
| `to_change` | Resources the plan would update in place. |
| `to_destroy` | Resources the plan would destroy. |
| `to_move` | Resources the plan would move. |
| `to_import` | Resources the plan would import. |
| `run_id` | Remote run identifier, for `remote` and `cloud` backends. |
| `failure_reason` / `failure-reason` | `state-locked` when the lock was held. |
| `lock_info` / `lock-info` | JSON describing who holds the state lock. |

The `to_*` counts are set only when there are changes, so check `changes` first.

`plan_path` is what `terraform-apply` accepts as its own `plan_path` input, which
skips regenerating the plan. It is not set for backends that cannot save a plan,
such as `remote`.

`json_plan_path` comes from `terraform show -json` locally. For a plan that ran
remotely there is no local file, so it is fetched from the Terraform Cloud API
using the token from your backend configuration or `~/.terraformrc`; it is only
set if that succeeded.

`failure_reason` distinguishes a state lock, which is usually worth retrying,
from a broken configuration, which is not. It is left unset for any other
failure.

**`json_plan_path` holds the plan in full, including sensitive values.** Do not
upload it as an artifact from a public repository.

## Terraform version

The version to run is worked out from your configuration, using the first of
these that applies:

1. a `required_version` constraint in the Terraform configuration
2. a `.tfswitchrc` file
3. an `.opentofu-version` file
4. a `.terraform-version` file
5. a `terraform` entry in `.tool-versions` (asdf), searching upwards to the workspace root
6. the `TERRAFORM_VERSION` environment variable
7. the version recorded in local state, when state has been written
8. otherwise, the latest release

Configuration beats environment deliberately. `required_version` describes what
the code needs, so a workflow-wide `TERRAFORM_VERSION` default does not silently
override a module that pins something narrower.

Set `OPENTOFU_VERSION`, or `OPENTOFU: true`, to use OpenTofu instead. Downloads
are compared against the published `SHA256SUMS` before being extracted.

**Use the same version for plan and apply.** A plan produced by one version may
render differently under another, which an apply would see as the plan having
changed.

## Redacting plan output

The plan reaches both the job log and the pull request comment, so values under
attribute names that look like credentials are replaced with `*` first. Resource
types that exist to hold generated secrets — `random_id`, `kubernetes_secret`,
`acme_certificate` — have their ids masked too.

This matches the redaction the upstream action applies, including its limits:

- It works on **attribute names**, not on Terraform's own `sensitive` marking, so
  a sensitive value under an innocuous name is not masked.
- The pattern requires a non-alphabetic character before the keyword, so
  `db_password` is masked but a bare `password` is not.

Treat it as a safety net rather than the reason it is safe to publish a plan. Set
`TFMASK_VALUES_REGEX` for a stricter pattern of your own.

A plan too large for a comment is truncated with a pointer to the log. Truncation
does not affect approval: the hash is taken over the full plan.

## Environment variables

| Name | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Required to post the comment, unless `add_github_comment` is `false`. |
| `TERRAFORM_VERSION` | Version or constraint to run. See above for precedence. |
| `OPENTOFU_VERSION` / `OPENTOFU` | Use OpenTofu instead of Terraform. |
| `GITHUB_DOT_COM_TOKEN` | Token for github.com when running on GitHub Enterprise, used only to download OpenTofu releases. |
| `TERRAFORM_CLOUD_TOKENS` | `host=token` pairs, one per line, for the `remote` backend and the module registry. |
| `TERRAFORM_HTTP_CREDENTIALS` | `host=user:password` pairs, one per line, for fetching modules over HTTP or `git::https`. First match wins. |
| `TERRAFORM_SSH_KEY` | PEM-format private key for fetching modules over SSH. |
| `TERRAFORM_PRE_RUN` | Shell commands to run after Terraform is installed and before it is used. |
| `TF_ACTIONS_PLAN_FORMAT` | `diff` (default) renders the comment as a coloured diff; `text` leaves it plain. |
| `TFMASK_VALUES_REGEX` | Overrides which attribute names have their values masked. |
| `TF_PLAN_COLLAPSE_LENGTH` | Line count above which the plan in the comment is collapsed. |

`TERRAFORM_PRE_RUN` runs with `-x`, `-e` and `-o pipefail`, so it stops at the
first failing command rather than continuing into Terraform with a half-prepared
environment. Workflow commands are suspended while it runs, so a line of its
output cannot masquerade as an instruction to the runner.

## Development

Version resolution, downloading, backend init, workspace selection, plan
execution, output redaction and the comment machinery are shared with the sibling
Terraform actions through
[`dflook-terraform-actions-core`](https://github.com/step-security/dflook-terraform-actions-core),
included here as a submodule at `vendor/core`. The submodule is bundled into
`dist/` at build time, so consumers never need to fetch it.

```bash
git clone --recurse-submodules https://github.com/step-security/dflook-terraform-plan.git
npm ci
npm test
npm run build   # regenerates dist/, which is committed
```

An existing clone needs `git submodule update --init` once, or the build cannot
resolve `@core`.
