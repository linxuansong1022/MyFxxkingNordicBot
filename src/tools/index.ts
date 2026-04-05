import type { RuntimeConfig } from '../config.js'
import { createMcpBackedTools } from '../mcp.js'
import { discoverSkills } from '../skills.js'
import { ToolRegistry } from '../tool.js'
import { askUserTool } from './ask-user.js'
import { editFileTool } from './edit-file.js'
import { grepFilesTool } from './grep-files.js'
import { listFilesTool } from './list-files.js'
import { createLoadSkillTool } from './load-skill.js'
import { modifyFileTool } from './modify-file.js'
import { patchFileTool } from './patch-file.js'
import { readFileTool } from './read-file.js'
import { runCommandTool } from './run-command.js'
import { webFetchTool } from './web-fetch.js'
import { webSearchTool } from './web-search.js'
import { writeFileTool } from './write-file.js'

export async function createDefaultToolRegistry(args: {
  cwd: string
  runtime: RuntimeConfig | null
}): Promise<ToolRegistry> {
  const [skills, mcp] = await Promise.all([
    discoverSkills(args.cwd),
    createMcpBackedTools({
      cwd: args.cwd,
      mcpServers: args.runtime?.mcpServers ?? {},
    }),
  ])

  return new ToolRegistry([
    askUserTool,
    listFilesTool,
    grepFilesTool,
    readFileTool,
    writeFileTool,
    modifyFileTool,
    editFileTool,
    patchFileTool,
    runCommandTool,
    createLoadSkillTool(args.cwd),
    webFetchTool,
    webSearchTool,
    ...mcp.tools,
  ], {
    skills,
    mcpServers: mcp.servers,
  }, mcp.dispose)
}
