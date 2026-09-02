import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadModule } from '@core'
import { canComment, commentRequested, describe as describeConfig } from '../src/comment.js'
import type { Inputs } from '../src/inputs.js'

function moduleWith(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'plan-module-'))
  writeFileSync(join(dir, 'main.tf'), source)
  return { module: loadModule(dir), dir }
}

function inputs(overrides: Partial<Inputs> = {}): Inputs {
  return {
    path: '/ws/infra',
    workspace: 'default',
    destroy: false,
    refresh: true,
    addGithubComment: 'true',
    parallelism: '0',
    workspaceRoot: '/ws',
    ...overrides,
  }
}

/**
 * A plan is posted for review before merging. A push has nothing to review, so
 * upstream does not comment there — note this differs from the apply action,
 * which does accept push, because it is looking for a comment rather than
 * writing one.
 */
describe('which events can be commented on', () => {
  it.each([
    'pull_request',
    'issue_comment',
    'pull_request_review_comment',
    'pull_request_target',
    'pull_request_review',
    'repository_dispatch',
  ])('accepts %s', (eventName) => {
    expect(canComment(eventName)).toBe(true)
  })

  it.each(['push', 'schedule', 'workflow_dispatch', 'release'])('rejects %s', (eventName) => {
    expect(canComment(eventName)).toBe(false)
  })
})

describe('which settings ask for a comment', () => {
  it.each(['true', 'changes-only', 'always-new'])('%s does', (mode) => {
    expect(commentRequested(mode)).toBe(true)
  })

  it.each(['false', '', undefined])('%s does not', (mode) => {
    expect(commentRequested(mode)).toBe(false)
  })
})

describe('describing the configuration', () => {
  const { module } = moduleWith('resource "null_resource" "a" {}\n')

  it('names the module directory', () => {
    expect(describeConfig(inputs(), module)).toContain('infra')
  })

  it('prefers the label when one is given', () => {
    const described = describeConfig(inputs({ label: 'production' }), module)
    expect(described).toContain('production')
    expect(described).not.toContain('infra')
  })

  it('names a non-default workspace', () => {
    expect(describeConfig(inputs({ workspace: 'staging' }), module)).toContain('staging')
  })

  it('does not mention the default workspace', () => {
    expect(describeConfig(inputs(), module)).not.toContain('workspace')
  })

  it('describes the workspace root as .', () => {
    expect(describeConfig(inputs({ path: '/ws', workspaceRoot: '/ws' }), module)).toContain('__.__')
  })
})

/**
 * A reviewer needs to know a sensitive variable was supplied without seeing its
 * value. The names are not secret; omitting them entirely would hide that the
 * variable was set at all.
 */
describe('naming supplied sensitive variables', () => {
  const { module } = moduleWith(`
variable "password" {
  type      = string
  sensitive = true
}
variable "region" {
  type = string
}
`)

  it('names a sensitive variable that was supplied', () => {
    const described = describeConfig(inputs({ variables: 'password = "hunter2"' }), module)
    expect(described).toContain('password')
  })

  it('never includes the value', () => {
    const described = describeConfig(inputs({ variables: 'password = "hunter2"' }), module)
    expect(described).not.toContain('hunter2')
  })

  it('does not name a sensitive variable that was not supplied', () => {
    expect(describeConfig(inputs({ variables: 'region = "eu-west-1"' }), module)).not.toContain(
      'password'
    )
  })

  it('does not name a variable that is not sensitive', () => {
    const described = describeConfig(inputs({ variables: 'region = "eu-west-1"' }), module)
    expect(described).not.toContain('region')
  })

  it('says nothing when no variables were supplied', () => {
    expect(describeConfig(inputs(), module)).not.toContain('sensitive')
  })

  /** Assignment has to be matched, not a mention inside another value. */
  it('does not match a name appearing inside another value', () => {
    const described = describeConfig(inputs({ variables: 'region = "password-region"' }), module)
    expect(described).not.toContain('sensitive variables')
  })
})