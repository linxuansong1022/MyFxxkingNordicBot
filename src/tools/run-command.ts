import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

const execFileAsync = promisify(execFile)

const ALLOWLIST = new Set([
  'pwd',
  'ls',
  'find',
  'rg',
  'cat',
  'echo',
  'env',
  'grep',
  'git',
  'npm',
  'node',
  'python3',
  'pytest',
  'bash',
  'sh',
  'bun',
  'sed',
  'head',
  'tail',
  'wc',
])

type Input = {
  command: string
  args?: string[]
  cwd?: string
}

function looksLikeShellSnippet(command: string, args?: string[]): boolean {
  if ((args?.length ?? 0) > 0) {
    return false
  }

  return /[|&;<>()$`]/.test(command)
}

export const runCommandTool: ToolDefinition<Input> = {
  name: 'run_command',
  description:
    'Run a common development command from an allowlist. For shell pipelines or variable expansion, pass the full snippet in command and mini-code will run it via bash -lc.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      args: {
        type: 'array',
        items: { type: 'string' },
      },
      cwd: { type: 'string' },
    },
    required: ['command'],
  },
  schema: z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
  }),
  async run(input, context) {
    const effectiveCwd = input.cwd
      ? await resolveToolPath(context, input.cwd, 'list')
      : context.cwd

    const useShell = looksLikeShellSnippet(input.command, input.args)

    if (!useShell && !ALLOWLIST.has(input.command)) {
      return {
        ok: false,
        output: `Command not allowed: ${input.command}`,
      }
    }

    const command = useShell ? 'bash' : input.command
    const args = useShell ? ['-lc', input.command] : (input.args ?? [])

    await context.permissions?.ensureCommand(command, args, effectiveCwd)

    const result = await execFileAsync(command, args, {
      cwd: effectiveCwd,
      maxBuffer: 1024 * 1024,
      env: process.env,
    })

    return {
      ok: true,
      output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
    }
  },
}
