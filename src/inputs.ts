import { existsSync, statSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'

export class InputError extends Error {}

/** How `add_github_comment` was set. Anything else is treated as `false`. */
export type CommentMode = 'true' | 'changes-only' | 'always-new' | 'false'

export interface Inputs {
  /** Root module to plan. */
  path: string
  /** Workspace to plan in. */
  workspace: string
  /** Distinguishes several runs against the same configuration. */
  label?: string
  variables?: string
  varFile?: string
  backendConfig?: string
  backendConfigFile?: string
  replace?: string
  target?: string
  destroy: boolean
  refresh: boolean
  /** Whether and how to comment on the pull request. */
  addGithubComment: CommentMode
  parallelism: string
  workspaceRoot: string
}

function read(name: string, fallback = ''): string {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim()
}

/** Reads an input, keeping internal formatting but treating blank as absent. */
function readBlock(name: string): string | undefined {
  const value = process.env[`INPUT_${name.toUpperCase()}`]
  if (value === undefined || !value.trim()) return undefined
  return value
}

/**
 * Reads a boolean input.
 *
 * Only the exact string `true` enables one, matching how upstream compares
 * these, so a typo fails towards the safer behaviour.
 */
function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[`INPUT_${name.toUpperCase()}`]
  if (value === undefined || value.trim() === '') return fallback
  return value.trim() === 'true'
}

/**
 * Reads `add_github_comment`.
 *
 * Three settings ask for a comment and one does not. An unrecognised value is
 * treated as `false` rather than rejected, because failing a plan over a
 * commenting preference would be worse than not commenting.
 */
function readCommentMode(): CommentMode {
  const value = read('add_github_comment', 'true') || 'true'
  if (value === 'true' || value === 'changes-only' || value === 'always-new') return value
  return 'false'
}

export function loadInputs(): Inputs {
  const workspaceRoot = resolve(process.env.GITHUB_WORKSPACE || process.cwd())

  const requested = read('path', '.') || '.'
  const path = resolve(workspaceRoot, requested)

  // The path comes from workflow input and has no business pointing outside the
  // checkout, so confine it rather than trusting the caller.
  const offset = relative(workspaceRoot, path)
  if (offset.startsWith('..') || isAbsolute(offset)) {
    throw new InputError(
      `path must stay inside the workspace, but '${requested}' resolves outside it`
    )
  }

  if (!existsSync(path)) {
    throw new InputError(`Path does not exist: "${requested}"`)
  }
  if (!statSync(path).isDirectory()) {
    throw new InputError(`path '${requested}' is not a directory`)
  }

  const target = readBlock('target')
  const exclude = readBlock('exclude')
  if (target?.trim() && exclude?.trim()) {
    throw new InputError('target and exclude cannot be used together')
  }

  return {
    path,
    workspace: read('workspace', 'default') || 'default',
    label: read('label') || undefined,
    variables: readBlock('variables'),
    varFile: readBlock('var_file'),
    backendConfig: readBlock('backend_config'),
    backendConfigFile: readBlock('backend_config_file'),
    replace: readBlock('replace'),
    target,
    destroy: readBoolean('destroy', false),
    refresh: readBoolean('refresh', true),
    addGithubComment: readCommentMode(),
    parallelism: read('parallelism', '0') || '0',
    workspaceRoot,
  }
}