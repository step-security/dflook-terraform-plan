import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { InputError, loadInputs } from '../src/inputs.js'

let workspace: string

const INPUTS = [
  'PATH',
  'WORKSPACE',
  'LABEL',
  'VARIABLES',
  'VAR_FILE',
  'BACKEND_CONFIG',
  'BACKEND_CONFIG_FILE',
  'REPLACE',
  'TARGET',
  'EXCLUDE',
  'DESTROY',
  'REFRESH',
  'ADD_GITHUB_COMMENT',
  'PARALLELISM',
].map((name) => `INPUT_${name}`)

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'plan-ws-'))
  process.env.GITHUB_WORKSPACE = workspace
  for (const name of INPUTS) delete process.env[name]
})

afterEach(() => {
  delete process.env.GITHUB_WORKSPACE
  for (const name of INPUTS) delete process.env[name]
})

describe('defaults', () => {
  it('matches the documented defaults', () => {
    const inputs = loadInputs()

    expect(inputs.path).toBe(workspace)
    expect(inputs.workspace).toBe('default')
    expect(inputs.destroy).toBe(false)
    expect(inputs.refresh).toBe(true)
    expect(inputs.addGithubComment).toBe('true')
    expect(inputs.parallelism).toBe('0')
    expect(inputs.label).toBeUndefined()
  })
})

/**
 * Three of the four settings ask for a comment. An unrecognised value is
 * treated as `false` rather than failing the plan, since a commenting preference
 * should not stop a plan running.
 */
describe('reading add_github_comment', () => {
  it.each([
    ['true', 'true'],
    ['changes-only', 'changes-only'],
    ['always-new', 'always-new'],
    ['false', 'false'],
  ])('reads %s', (value, expected) => {
    process.env.INPUT_ADD_GITHUB_COMMENT = value
    expect(loadInputs().addGithubComment).toBe(expected)
  })

  it.each(['TRUE', 'yes', '1', 'maybe', 'changes_only'])('treats %s as false', (value) => {
    process.env.INPUT_ADD_GITHUB_COMMENT = value
    expect(loadInputs().addGithubComment).toBe('false')
  })

  it('defaults to true when unset', () => {
    expect(loadInputs().addGithubComment).toBe('true')
  })

  it('defaults to true when blank', () => {
    process.env.INPUT_ADD_GITHUB_COMMENT = '   '
    expect(loadInputs().addGithubComment).toBe('true')
  })
})

describe('reading destroy and refresh', () => {
  it('turns destroy on only for true', () => {
    process.env.INPUT_DESTROY = 'true'
    expect(loadInputs().destroy).toBe(true)

    process.env.INPUT_DESTROY = 'True'
    expect(loadInputs().destroy).toBe(false)
  })

  /** refresh defaults on, so only an explicit false turns it off. */
  it('turns refresh off only for an explicit false', () => {
    process.env.INPUT_REFRESH = 'false'
    expect(loadInputs().refresh).toBe(false)

    delete process.env.INPUT_REFRESH
    expect(loadInputs().refresh).toBe(true)
  })
})

describe('confining path to the workspace', () => {
  it('resolves a subdirectory', () => {
    mkdirSync(join(workspace, 'infra'))
    process.env.INPUT_PATH = 'infra'
    expect(loadInputs().path).toBe(join(workspace, 'infra'))
  })

  it.each([
    ['a parent traversal', '../elsewhere'],
    ['a nested traversal', 'infra/../../elsewhere'],
    ['an absolute path', '/etc'],
  ])('rejects %s', (_label, value) => {
    process.env.INPUT_PATH = value
    expect(() => loadInputs()).toThrow(InputError)
  })

  it('rejects a path that does not exist', () => {
    process.env.INPUT_PATH = 'absent'
    expect(() => loadInputs()).toThrow(/Path does not exist: "absent"/)
  })

  it('rejects a file', () => {
    writeFileSync(join(workspace, 'main.tf'), '')
    process.env.INPUT_PATH = 'main.tf'
    expect(() => loadInputs()).toThrow(/is not a directory/)
  })
})

describe('target and exclude', () => {
  it('refuses both at once', () => {
    process.env.INPUT_TARGET = 'a.b'
    process.env.INPUT_EXCLUDE = 'c.d'
    expect(() => loadInputs()).toThrow(/cannot be used together/)
  })

  it('accepts target alone', () => {
    process.env.INPUT_TARGET = 'a.b'
    expect(loadInputs().target).toBe('a.b')
  })
})

describe('block inputs', () => {
  it('keeps newlines in variables', () => {
    process.env.INPUT_VARIABLES = 'a = 1\nb = 2\n'
    expect(loadInputs().variables).toBe('a = 1\nb = 2\n')
  })

  it('treats a blank label as absent', () => {
    process.env.INPUT_LABEL = '   '
    expect(loadInputs().label).toBeUndefined()
  })

  it.each([
    ['variables', 'INPUT_VARIABLES', 'variables'],
    ['var_file', 'INPUT_VAR_FILE', 'varFile'],
    ['replace', 'INPUT_REPLACE', 'replace'],
  ])('treats a blank %s as absent', (_label, variable, field) => {
    process.env[variable] = '  \n  '
    expect(loadInputs()[field as 'variables']).toBeUndefined()
  })
})