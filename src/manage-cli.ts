import process from 'node:process'
import {
  type McpConfigScope,
  type McpServerConfig,
  getMcpConfigPath,
  loadScopedMcpServers,
  saveScopedMcpServers,
} from './config.js'
import { discoverSkills, installSkill, removeManagedSkill } from './skills.js'

function printUsage(): void {
  console.log(`minicode management commands

minicode mcp list [--project]
minicode mcp add <name> [--project] [--protocol <auto|content-length|newline-json>] [--env KEY=VALUE ...] -- <command> [args...]
minicode mcp remove <name> [--project]

minicode skills list
minicode skills add <path-to-skill-or-dir> [--name <name>] [--project]
minicode skills remove <name> [--project]`)
}

function parseScope(args: string[]): {
  scope: McpConfigScope
  rest: string[]
} {
  const rest = [...args]
  const projectIndex = rest.indexOf('--project')
  if (projectIndex !== -1) {
    rest.splice(projectIndex, 1)
    return { scope: 'project', rest }
  }
  return { scope: 'user', rest }
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value) {
    throw new Error(`Missing value for ${name}`)
  }
  args.splice(index, 2)
  return value
}

function takeRepeatOption(args: string[], name: string): string[] {
  const values: string[] = []
  while (true) {
    const index = args.indexOf(name)
    if (index === -1) break
    const value = args[index + 1]
    if (!value) {
      throw new Error(`Missing value for ${name}`)
    }
    values.push(value)
    args.splice(index, 2)
  }
  return values
}

function parseEnvPairs(values: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of values) {
    const separator = entry.indexOf('=')
    if (separator === -1) {
      throw new Error(`Invalid --env value: ${entry}`)
    }
    const key = entry.slice(0, separator).trim()
    const value = entry.slice(separator + 1)
    if (!key) {
      throw new Error(`Invalid --env value: ${entry}`)
    }
    env[key] = value
  }
  return env
}

async function handleMcpCommand(cwd: string, args: string[]): Promise<boolean> {
  const [subcommand, ...restArgs] = args
  if (!subcommand) {
    printUsage()
    return true
  }

  const { scope, rest } = parseScope(restArgs)

  if (subcommand === 'list') {
    const servers = await loadScopedMcpServers(scope, cwd)
    if (Object.keys(servers).length === 0) {
      console.log(`No MCP servers configured in ${getMcpConfigPath(scope, cwd)}.`)
      return true
    }

    for (const [name, server] of Object.entries(servers)) {
      const argsSummary = server.args?.join(' ') ?? ''
      const protocol = server.protocol ? ` protocol=${server.protocol}` : ''
      console.log(`${name}: ${server.command} ${argsSummary}${protocol}`.trim())
    }
    return true
  }

  if (subcommand === 'add') {
    const separatorIndex = rest.indexOf('--')
    if (separatorIndex === -1) {
      throw new Error('Use `--` before the MCP command. Example: minicode mcp add MiniMax -- uvx minimax-coding-plan-mcp -y')
    }

    const head = rest.slice(0, separatorIndex)
    const commandParts = rest.slice(separatorIndex + 1)
    const name = head.shift()
    if (!name) {
      throw new Error('Missing MCP server name.')
    }
    if (commandParts.length === 0) {
      throw new Error('Missing MCP command after `--`.')
    }

    const protocol = takeOption(head, '--protocol') as McpServerConfig['protocol']
    const env = parseEnvPairs(takeRepeatOption(head, '--env'))
    if (head.length > 0) {
      throw new Error(`Unknown arguments: ${head.join(' ')}`)
    }

    const [command, ...commandArgs] = commandParts
    const existing = await loadScopedMcpServers(scope, cwd)
    existing[name] = {
      command,
      args: commandArgs,
      env: Object.keys(env).length > 0 ? env : undefined,
      protocol,
    }
    await saveScopedMcpServers(scope, existing, cwd)
    console.log(`Added MCP server ${name} to ${getMcpConfigPath(scope, cwd)}`)
    return true
  }

  if (subcommand === 'remove') {
    const name = rest[0]
    if (!name) {
      throw new Error('Missing MCP server name.')
    }
    const existing = await loadScopedMcpServers(scope, cwd)
    if (!(name in existing)) {
      console.log(`MCP server ${name} not found in ${getMcpConfigPath(scope, cwd)}`)
      return true
    }
    delete existing[name]
    await saveScopedMcpServers(scope, existing, cwd)
    console.log(`Removed MCP server ${name} from ${getMcpConfigPath(scope, cwd)}`)
    return true
  }

  printUsage()
  return true
}

async function handleSkillsCommand(cwd: string, args: string[]): Promise<boolean> {
  const [subcommand, ...restArgs] = args
  if (!subcommand) {
    printUsage()
    return true
  }

  const { scope, rest } = parseScope(restArgs)

  if (subcommand === 'list') {
    const skills = await discoverSkills(cwd)
    if (skills.length === 0) {
      console.log('No skills discovered.')
      return true
    }
    for (const skill of skills) {
      console.log(`${skill.name}: ${skill.description} (${skill.path})`)
    }
    return true
  }

  if (subcommand === 'add') {
    const sourcePath = rest[0]
    if (!sourcePath) {
      throw new Error('Missing skill source path.')
    }
    const name = takeOption(rest, '--name')
    const result = await installSkill({
      cwd,
      sourcePath,
      name,
      scope,
    })
    console.log(`Installed skill ${result.name} at ${result.targetPath}`)
    return true
  }

  if (subcommand === 'remove') {
    const name = rest[0]
    if (!name) {
      throw new Error('Missing skill name.')
    }
    const result = await removeManagedSkill({
      cwd,
      name,
      scope,
    })
    if (!result.removed) {
      console.log(`Skill ${name} not found at ${result.targetPath}`)
      return true
    }
    console.log(`Removed skill ${name} from ${result.targetPath}`)
    return true
  }

  printUsage()
  return true
}

export async function maybeHandleManagementCommand(
  cwd: string,
  argv: string[],
): Promise<boolean> {
  const [category, ...rest] = argv
  if (!category) {
    return false
  }

  if (category === 'mcp') {
    return handleMcpCommand(cwd, rest)
  }

  if (category === 'skills') {
    return handleSkillsCommand(cwd, rest)
  }

  if (category === 'help' || category === '--help' || category === '-h') {
    printUsage()
    return true
  }

  return false
}
