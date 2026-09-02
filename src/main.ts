import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import * as core from '@actions/core'
import {
  PLAN_CHANGES,
  PLAN_ERROR,
  acquire,
  backendConfigArgs,
  candidateVersions,
  cannotSavePlan,
  compactPlan,
  completeBackendConfig,
  deleteAutoTfVars,
  fetchCloudJsonPlan,
  getBackendType,
  getLockInfo,
  getOpenTofuVersions,
  getRemoteRunId,
  getTerraformVersions,
  initBackendWorkspace,
  isRemoteExecution,
  loadModule,
  planArgs,
  planCounts,
  resolveVersion,
  runPlan,
  runPreRunCommands,
  runTool,
  writeAutoTfVars,
  writeCredentials,
} from '@core'
import type { TerraformModule } from '@core'
import { InputError, loadInputs } from './inputs.js'
import type { Inputs } from './inputs.js'
import {
  canComment,
  commentRequested,
  jobRef,
  postComment,
  prepareComment,
  reportCommentFailure,
  runUrl,
} from './comment.js'
import type { CommentContext } from './comment.js'
import { validateSubscription } from './subscription.js'

/** Directory inside the workspace where plan artifacts are written. */
const ARTIFACT_DIR = '.terraform-plan'

function openTofuRequested(): boolean {
  return process.env.OPENTOFU_VERSION !== undefined || process.env.OPENTOFU === 'true'
}

interface Prepared {
  binary: string
  env: NodeJS.ProcessEnv
  dataDir: string
  tempDir: string
  backendType: string
  module: TerraformModule
}

/**
 * Installs the tool and prepares the environment.
 *
 * Ordering is upstream's: the tool is installed before `TERRAFORM_PRE_RUN`, and
 * `TF_WORKSPACE` is cleared so a value inherited from the job cannot silently
 * override the `workspace` input.
 */
async function prepare(inputs: Inputs): Promise<Prepared> {
  const tempDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'terraform-plan-'))
  const dataDir = join(tempDir, 'terraform-data-dir')
  const pluginCache = join(homedir(), '.terraform.d', 'plugin-cache')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(pluginCache, { recursive: true })

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TF_DATA_DIR: dataDir,
    TF_PLUGIN_CACHE_DIR: pluginCache,
    TF_IN_AUTOMATION: 'true',
  }
  delete env.TF_WORKSPACE

  if (!env.TERRAFORM_ACTIONS_GITHUB_TOKEN && env.GITHUB_TOKEN) {
    env.TERRAFORM_ACTIONS_GITHUB_TOKEN = env.GITHUB_TOKEN
  }

  writeCredentials({
    cloudTokens: process.env.TERRAFORM_CLOUD_TOKENS,
    httpCredentials: process.env.TERRAFORM_HTTP_CREDENTIALS,
    sshKey: process.env.TERRAFORM_SSH_KEY,
  })

  const openTofu = openTofuRequested()
  const module = loadModule(inputs.path, openTofu)
  const terraform = await getTerraformVersions()
  const tofu = openTofu ? await getOpenTofuVersions(process.env.GITHUB_TOKEN) : undefined

  const resolution = resolveVersion(
    { modulePath: inputs.path, workspaceRoot: inputs.workspaceRoot, openTofu },
    { module, versions: candidateVersions(terraform, tofu), env: process.env }
  )

  if (!resolution) {
    throw new Error('No release matched the version constraints in effect')
  }

  core.info(
    `Using ${resolution.version.product} ${resolution.version} because ${resolution.reason}`
  )
  const binary = await acquire(resolution.version)

  const backendType = getBackendType(module)
  if (backendType) core.info(`Detected ${backendType} backend`)

  await runPreRunCommands(process.env.TERRAFORM_PRE_RUN)

  return { binary, env, dataDir, tempDir, backendType, module }
}

/** Writes a file into the workspace and returns its workspace-relative path. */
function writeArtifact(inputs: Inputs, name: string, contents: string): string {
  const dir = join(inputs.workspaceRoot, ARTIFACT_DIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), contents)
  return join(ARTIFACT_DIR, name)
}

/** Copies a file into the workspace and returns its workspace-relative path. */
function copyArtifact(inputs: Inputs, source: string, name: string): string {
  const dir = join(inputs.workspaceRoot, ARTIFACT_DIR)
  mkdirSync(dir, { recursive: true })
  copyFileSync(source, join(dir, name))
  return join(ARTIFACT_DIR, name)
}

interface PlanResult {
  /** Compacted plan text. */
  text: string
  /** Saved plan file, when the backend can produce one. */
  planOut?: string
  exitCode: number
  stderr: string
  runId?: string
}

/**
 * Runs the plan without taking a state lock.
 *
 * Nothing is written, so a lock would block a real apply for no benefit. The
 * remote backend cannot save a plan file; when that is the reason for a failure,
 * the plan is retried without one.
 */
async function generatePlan(
  prepared: Prepared,
  inputs: Inputs,
  args: { parallelism: string[]; args: string[] }
): Promise<PlanResult> {
  const planOut = join(prepared.tempDir, 'plan.out')

  let result = await runPlan({
    binary: prepared.binary,
    modulePath: inputs.path,
    planOut,
    parallelism: args.parallelism,
    args: args.args,
    lock: false,
    env: prepared.env,
  })

  let savedPlan: string | undefined = planOut

  if (result.exitCode === PLAN_ERROR && cannotSavePlan(result.stderr)) {
    core.info('This backend cannot save a plan; planning again without one.')
    savedPlan = undefined
    result = await runPlan({
      binary: prepared.binary,
      modulePath: inputs.path,
      parallelism: args.parallelism,
      args: args.args,
      lock: false,
      env: prepared.env,
    })
  }

  const runId = isRemoteExecution(prepared.backendType)
    ? getRemoteRunId(result.output, result.stderr)
    : undefined

  return {
    text: compactPlan(result.output),
    planOut: savedPlan,
    exitCode: result.exitCode,
    stderr: result.stderr,
    runId,
  }
}

/**
 * Publishes the plan as workspace artifacts.
 *
 * The JSON plan comes from `show -json` locally, or from the Terraform Cloud API
 * when the plan ran remotely and there is no local file to render.
 */
async function publishArtifacts(
  prepared: Prepared,
  inputs: Inputs,
  plan: PlanResult
): Promise<void> {
  core.setOutput('text_plan_path', writeArtifact(inputs, 'plan.txt', plan.text))

  if (plan.planOut) {
    // The binary plan is what terraform-apply can be given directly.
    core.setOutput('plan_path', copyArtifact(inputs, plan.planOut, 'plan.tfplan'))

    const shown = await runTool(prepared.binary, ['show', '-json', plan.planOut], {
      cwd: inputs.path,
      env: prepared.env,
      silent: true,
    })

    if (shown.exitCode === 0) {
      core.setOutput('json_plan_path', writeArtifact(inputs, 'plan.json', shown.stdout))
    } else {
      core.debug(`Could not render the plan as json: ${shown.stderr}`)
    }
    return
  }

  if (!plan.runId) return

  // Ran remotely, so the JSON plan has to be fetched from the API.
  const backendConfig = completeBackendConfig({
    module: prepared.module,
    backendConfig: inputs.backendConfig,
    backendConfigFile: inputs.backendConfigFile,
    workspaceRoot: inputs.workspaceRoot,
  })

  const fetched = await fetchCloudJsonPlan({
    runId: plan.runId,
    hostname: backendConfig.hostname,
    token: backendConfig.token,
  })

  if ('plan' in fetched) {
    core.setOutput('json_plan_path', writeArtifact(inputs, 'plan.json', fetched.plan))
  } else {
    core.debug(`Could not fetch the JSON plan from Terraform Cloud: ${fetched.reason}`)
  }
}

/** Publishes the operation counts, which only apply when there are changes. */
function publishCounts(planText: string): void {
  const counts = planCounts(planText)
  core.setOutput('to_add', counts.add)
  core.setOutput('to_change', counts.change)
  core.setOutput('to_destroy', counts.destroy)
  core.setOutput('to_move', counts.move)
  core.setOutput('to_import', counts.import)
}

export async function run(): Promise<number> {
  await validateSubscription()

  let inputs: Inputs
  try {
    inputs = loadInputs()
  } catch (error) {
    if (error instanceof InputError) {
      core.error(error.message)
      return 1
    }
    throw error
  }

  let prepared: Prepared | undefined

  try {
    prepared = await prepare(inputs)

    writeAutoTfVars(
      { variables: inputs.variables, varFile: inputs.varFile },
      inputs.path,
      inputs.workspaceRoot
    )

    const initResult = await initBackendWorkspace({
      binary: prepared.binary,
      modulePath: inputs.path,
      workspace: inputs.workspace,
      backendConfigArgs: backendConfigArgs(
        { backendConfig: inputs.backendConfig, backendConfigFile: inputs.backendConfigFile },
        { modulePath: inputs.path, workspaceRoot: inputs.workspaceRoot }
      ),
      dataDir: prepared.dataDir,
      env: prepared.env,
      backendType: prepared.backendType,
    })

    if (initResult.tfWorkspace) prepared.env.TF_WORKSPACE = initResult.tfWorkspace

    const args = planArgs({
      parallelism: inputs.parallelism,
      target: inputs.target,
      replace: inputs.replace,
      destroy: inputs.destroy,
      refresh: inputs.refresh,
    })

    const plan = await generatePlan(prepared, inputs, args)
    if (plan.runId) core.setOutput('run_id', plan.runId)

    const eventName = process.env.GITHUB_EVENT_NAME ?? ''
    const token = process.env.TERRAFORM_ACTIONS_GITHUB_TOKEN || process.env.GITHUB_TOKEN
    const wantsComment = commentRequested(inputs.addGithubComment)

    // A comment was asked for but there is no token to post it with. That is a
    // configuration mistake, so it fails rather than being ignored.
    if (wantsComment && canComment(eventName) && !token) {
      core.error(
        'GITHUB_TOKEN environment variable must be set to add GitHub PR comments. ' +
          "Either set it, or disable commenting by setting the add_github_comment input to 'false'"
      )
      return 1
    }

    let context: CommentContext | undefined
    if (wantsComment && canComment(eventName) && token) {
      try {
        context = await prepareComment({
          inputs,
          module: prepared.module,
          backendType: prepared.backendType,
          dataDir: prepared.dataDir,
          token,
          event: {
            eventName,
            eventPath: process.env.GITHUB_EVENT_PATH,
            repository: process.env.GITHUB_REPOSITORY,
            sha: process.env.GITHUB_SHA,
            ref: process.env.GITHUB_REF,
            refType: process.env.GITHUB_REF_TYPE,
            apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
          },
        })
      } catch (error) {
        reportCommentFailure(error)
      }
    } else if (wantsComment && !canComment(eventName)) {
      core.info(`Not commenting: the ${eventName} event does not relate to a pull request.`)
    }

    const url = runUrl()
    const link = url ? `[this run](${url})` : 'this run'

    if (plan.exitCode === PLAN_ERROR) {
      if (context) {
        try {
          // The error is the plan as far as the comment is concerned: a reviewer
          // needs to see why it failed, not an empty comment.
          await postComment({
            context,
            mode: inputs.addGithubComment as 'true' | 'changes-only' | 'always-new',
            planText: plan.stderr.trim() || 'Error running Terraform',
            changes: false,
            status: `:x: Failed to generate plan in ${link}`,
            planJobRef: jobRef(),
          })
        } catch (error) {
          reportCommentFailure(error)
        }
      }

      const lockInfo = getLockInfo(plan.stderr)
      if (lockInfo) {
        const encoded = JSON.stringify(lockInfo)
        core.setOutput('lock_info', encoded)
        core.setOutput('lock-info', encoded)
        core.setOutput('failure_reason', 'state-locked')
        core.setOutput('failure-reason', 'state-locked')
      }

      core.error('Error running Terraform plan')
      return 1
    }

    const changes = plan.exitCode === PLAN_CHANGES
    core.setOutput('changes', String(changes))

    if (context) {
      try {
        await postComment({
          context,
          mode: inputs.addGithubComment as 'true' | 'changes-only' | 'always-new',
          planText: plan.text,
          changes,
          planOut: plan.planOut,
          status: `:memo: Plan generated in ${link}`,
          planJobRef: jobRef(),
        })
      } catch (error) {
        reportCommentFailure(error)
      }
    }

    await publishArtifacts(prepared, inputs, plan)

    // Counts are only meaningful when something is changing.
    if (changes) publishCounts(plan.text)

    core.info(changes ? 'Changes to apply' : 'No changes to apply')
    return 0
  } catch (error) {
    core.error(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    if (prepared) deleteAutoTfVars(inputs.path)
  }
}

/**
 * Only self-start when invoked directly, so the module can still be imported by
 * a test. `import.meta.url` is the ESM equivalent of the `require.main` check.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  run()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      core.setFailed(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
