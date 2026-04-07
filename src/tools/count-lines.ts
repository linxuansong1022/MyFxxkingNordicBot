import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

// 这个工具的输入参数：只要一个 path
type Input = {
  path: string
}

export const countLinesTool: ToolDefinition<Input> = {
  name: 'count_lines',
  description:
    'Count the number of lines in a UTF-8 text file relative to the workspace root. Prefer this over read_file when you only need a line count — it does not load file content into context.',

  // 给 LLM 看的参数表（JSON Schema，跨网络的"合同"）
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },

  // 给本地代码看的运行时校验（zod，本地的"安检门"）
  schema: z.object({
    path: z.string(),
  }),

  async run(input, context) {
    // 1. 把相对路径解析成绝对路径，并检查权限
    const target = await resolveToolPath(context, input.path, 'read')

    // 2. 读文件内容（UTF-8 文本）
    const content = await readFile(target, 'utf8')

    // 3. 数行数
    //    边界情况：
    //    - 空文件 → 0 行
    //    - 文件以 \n 结尾 → split 会多出一个空字符串，要 -1
    //    - 文件不以 \n 结尾 → split 出来的段数就是行数
    const lineCount =
      content.length === 0
        ? 0
        : content.endsWith('\n')
          ? content.split('\n').length - 1
          : content.split('\n').length

    // 4. 返回自包含的结果（FILE + LINES，让 LLM 不用回头查 input）
    return {
      ok: true,
      output: `FILE: ${input.path}\nLINES: ${lineCount}`,
    }
  },
}
