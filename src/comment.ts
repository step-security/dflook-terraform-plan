import * as core from '@actions/core'
import {
  GitHubClient,
  backendFingerprint,
  commentRequested,
  completeBackendConfig,
  findPlanComment,
  findPullRequest,
  formatPlanText,
  getSensitiveVariables,
  planCommentHeaders,
  planHighlighting,
  planSummaryLine,
  postPlanComment,
} from '@core'
import type { EventContext, TerraformModule } from '@core'
import type { Inputs } from './inputs.js'

/**
 * Publishing the plan to a pull request.
 *
 * The comment is what a human reviews and what `terraform-apply` later reads to
 * decide whether an apply is authorised, so the identity and the recorded hashes
 * matter more than the presentation. Both come from the shared core, which is
 * also what the apply action reads with.
 *
 * Everything here is best effort past the point the plan itself succeeded. A
 * plan that ran correctly should not be reported as a failure because a comment
 * could not be posted — except when the caller asked for a comment and no token
 * was supplied, which is a configuration mistake worth failing on.
 */

/** Events from which a pull request can be found. */
const COMMENTABLE_EVENTS = [
  'pull_request',
  'issue_comment',
  'pull_request_review_comment',
  'pull_request_target',
  'pull_request_review',
  'repository_dispatch',
]

/**
 * Whether this run could comment at all.
 *
 * Note this excludes `push`, which the apply action does accept. A plan is
 * posted for review before merging; there is nothing to review on a push, so
 * upstream does not comment there.
 */
export function canComment(eventName: string): boolean {
  return COMMENTABLE_EVENTS.includes(eventName)
}

export interface CommentContext {
  client: GitHubClient
  issueUrl: string
  headers: Record<string, string | undefined>
  existing?: Awaited<ReturnType<typeof findPlanComment>>
  description: string
}

export interface PrepareOptions {
  inputs: Inputs
  module: TerraformModule
  backendType: string
  dataDir: string
  token: string
  event: EventContext
}

/**
 * Describes the configuration the plan is for.
 *
 * Names any sensitive variables that were supplied, so a reviewer can tell that
 * values were passed without the values appearing. Their names are not secret;
 * omitting them entirely would leave a reviewer unable to see that a variable
 * was set at all.
 */
export function describe(inputs: Inputs, module: TerraformModule): string {
  const parts: string[] = []

  if (inputs.label) {
    parts.push(`Terraform plan for __${inputs.label}__`)
  } else {
    const where = relativeLabel(inputs)
    parts.push(`Terraform plan in __${where}__`)
    if (inputs.workspace !== 'default') {
      parts.push(`In workspace __${inputs.workspace}__`)
    }
  }

  const sensitive = getSensitiveVariables(module)
  const supplied = sensitive.filter((name) => mentions(inputs.variables, name))
  if (supplied.length > 0) {
    parts.push(`With sensitive variables: ${supplied.map((n) => `__${n}__`).join(', ')}`)
  }

  return parts.join('\n')
}

function relativeLabel(inputs: Inputs): string {
  const offset = inputs.path.slice(inputs.workspaceRoot.length).replace(/^\/+/, '')
  return offset || '.'
}

/** Whether a variables block assigns the named variable. */
function mentions(variables: string | undefined, name: string): boolean {
  if (!variables) return false
  return new RegExp(`^\\s*${name}\\s*=`, 'm').test(variables)
}

/**
 * Finds the pull request and any comment already there for this configuration.
 *
 * Returns undefined when this run cannot comment, which is not an error: most
 * plan runs on a schedule or a branch push have no pull request to talk to.
 */
export async function prepareComment(
  options: PrepareOptions
): Promise<CommentContext | undefined> {
  const client = new GitHubClient({ token: options.token, apiUrl: options.event.apiUrl })

  const prUrl = await findPullRequest(client, options.event)
  const pr = await client.getPullRequest(prUrl)
  const issueUrl = pr.issue_url

  const fingerprint = backendFingerprint({
    backendType: options.backendType,
    config: completeBackendConfig({
      module: options.module,
      backendConfig: options.inputs.backendConfig,
      backendConfigFile: options.inputs.backendConfigFile,
      workspaceRoot: options.inputs.workspaceRoot,
    }),
    modulePath: options.inputs.path,
    dataDir: options.dataDir,
  })

  const headers = planCommentHeaders(
    {
      workspace: options.inputs.workspace,
      label: options.inputs.label,
      backendType: options.backendType,
      backendFingerprint: fingerprint,
      planModifier: {
        target: options.inputs.target,
        replace: options.inputs.replace,
        destroy: options.inputs.destroy,
      },
    },
    issueUrl
  )

  return {
    client,
    issueUrl,
    headers,
    existing: await findPlanComment(client, issueUrl, headers),
    description: describe(options.inputs, options.module),
  }
}

export interface PostOptions {
  context: CommentContext
  mode: Exclude<CommentMode, 'false'>
  /** Plan text as Terraform produced it, already compacted. */
  planText: string
  changes: boolean
  /** Saved plan file, hashed so an apply can verify it. */
  planOut?: string
  /** Status line beneath the plan, usually linking to the run. */
  status: string
  planJobRef?: string
}

type CommentMode = Inputs['addGithubComment']

/** Posts or updates the comment for this plan. */
export async function postComment(options: PostOptions): Promise<void> {
  const { format, text } = formatPlanText(options.planText, process.env.TF_ACTIONS_PLAN_FORMAT)

  await postPlanComment({
    client: options.context.client,
    issueUrl: options.context.issueUrl,
    mode: options.mode,
    headers: options.context.headers,
    existing: options.context.existing,
    description: options.context.description,
    planText: options.planText,
    body: text,
    bodyFormat: format,
    bodyHighlighting: planHighlighting(format, options.changes),
    summary: planSummaryLine(options.planText, options.changes),
    status: options.status,
    changes: options.changes,
    planOut: options.planOut,
    planJobRef: options.planJobRef,
  })
}

/** True when the input asks for a comment. */
export { commentRequested }

/** Reference to the workflow that produced this plan, recorded in the comment. */
export function jobRef(): string | undefined {
  const repo = process.env.GITHUB_REPOSITORY
  const workflow = process.env.GITHUB_WORKFLOW_REF
  if (workflow) return workflow
  if (!repo) return undefined
  return `${repo}/${process.env.GITHUB_JOB ?? ''}`
}

/** Link back to the run, for the comment status line. */
export function runUrl(): string | undefined {
  const server = process.env.GITHUB_SERVER_URL
  const repo = process.env.GITHUB_REPOSITORY
  const runId = process.env.GITHUB_RUN_ID
  if (!server || !repo || !runId) return undefined
  return `${server}/${repo}/actions/runs/${runId}`
}

/** Reports a comment failure without failing a plan that succeeded. */
export function reportCommentFailure(error: unknown): void {
  core.warning(
    `Could not update the pull request comment: ${
      error instanceof Error ? error.message : String(error)
    }`
  )
}