// permissions.ts
// 职责：工具执行前的"门卫"——AI 每次要读文件、写文件、执行命令，都必须先过这道门
//
// 三种检查入口：
//   ensurePathAccess()  ← AI 要访问 cwd 以外的路径
//   ensureCommand()     ← AI 要执行危险命令（git reset、npm publish 等）
//   ensureEdit()        ← AI 要写入/修改文件
//
// 每种检查的逻辑都一样，分 3 步：
//   1. 查缓存 → 之前说过"永远允许/拒绝"的？直接放行或拒绝
//   2. 没缓存 → 弹出提示框问用户
//   3. 记住用户的回答 → 根据粒度存到不同地方（turn / session / 文件）

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MINI_CODE_DIR } from './config.js'
import { isEnoentError } from './utils/errors.js'

// 用户回答权限询问时的 7 种决策
// 粒度从"只这一次"到"永久"，让用户精确控制授权范围
export type PermissionDecision =
  | 'allow_once'          // 只允许这一次（存 session 内存）
  | 'allow_always'        // 永久允许（写入 permissions.json 文件）
  | 'allow_turn'          // 本轮对话内允许这个文件（存 turn 内存）
  | 'allow_all_turn'      // 本轮对话内允许所有编辑（存 turn 内存）
  | 'deny_once'           // 只拒绝这一次（存 session 内存）
  | 'deny_always'         // 永久拒绝（写入 permissions.json 文件）
  | 'deny_with_feedback'  // 拒绝，并把原因反馈给 AI（AI 会调整方案重试）

export type PermissionChoice = {
  key: string               // 用户按哪个键选择
  label: string             // 选项描述文字
  decision: PermissionDecision
}

export type PermissionPromptResult = {
  decision: PermissionDecision
  feedback?: string         // deny_with_feedback 时用户填写的具体原因
}

type EnsureCommandOptions = {
  forcePromptReason?: string  // 强制弹出审批框的理由（即使不是危险命令）
}

// 权限询问弹框的完整内容
// 由 PermissionManager 构造，传给 TUI 渲染出审批框
export type PermissionRequest = {
  kind: 'path' | 'command' | 'edit'  // 三种权限类型
  summary: string                     // 一句话说明（显示在弹框标题）
  details: string[]                   // 详细信息列表（路径、命令等）
  scope: string                       // 这次授权覆盖的范围（路径/命令签名）
  choices: PermissionChoice[]         // 用户可以选择的选项列表
}

// 权限审批处理函数的类型
// 实现由 TUI 层提供（tty-app.ts），显示弹框并等待用户按键
export type PermissionPromptHandler = (
  request: PermissionRequest,
) => Promise<PermissionPromptResult>

// 持久化到 permissions.json 的数据结构
// 只存"永久"级别的决策，session/turn 级别只存在内存里
type PermissionStore = {
  allowedDirectoryPrefixes?: string[]
  deniedDirectoryPrefixes?: string[]
  allowedCommandPatterns?: string[]
  deniedCommandPatterns?: string[]
  allowedEditPatterns?: string[]
  deniedEditPatterns?: string[]
}

type PathIntent = 'read' | 'write' | 'list' | 'search' | 'command_cwd'

const PERMISSIONS_PATH = path.join(MINI_CODE_DIR, 'permissions.json')

// 把路径转成绝对路径，确保比较时不受相对路径影响
function normalizePath(targetPath: string): string {
  return path.resolve(targetPath)
}

// 判断 target 是否在 root 目录下（包括 root 本身）
// 用于"cwd 以内的路径自动放行"的判断
function isWithinDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

// 判断 targetPath 是否在任意一个预授权目录下
function matchesDirectoryPrefix(
  targetPath: string,
  directories: Iterable<string>,
): boolean {
  for (const directory of directories) {
    if (isWithinDirectory(directory, targetPath)) {
      return true
    }
  }

  return false
}

function formatCommandSignature(command: string, args: string[]): string {
  return [command, ...args].join(' ').trim()
}

// === 危险命令黑名单 ===
// 硬编码哪些命令需要强制审批，返回危险原因字符串，安全命令返回 null
//
// 危险标准：
//   - 会丢失本地数据（git reset --hard / git clean）
//   - 会影响远端/外部系统（git push --force / npm publish）
//   - 可执行任意代码（node / python3 / bash 等）
//
// 普通命令（ls / cat / grep 等）不在这里，直接放行
function classifyDangerousCommand(command: string, args: string[]): string | null {
  const normalizedArgs = args.map(arg => arg.trim()).filter(Boolean)
  const signature = formatCommandSignature(command, normalizedArgs)

  if (command === 'git') {
    if (normalizedArgs.includes('reset') && normalizedArgs.includes('--hard')) {
      return `git reset --hard can discard local changes (${signature})`
    }

    if (normalizedArgs.includes('clean')) {
      return `git clean can delete untracked files (${signature})`
    }

    if (
      normalizedArgs.includes('checkout') &&
      normalizedArgs.includes('--')
    ) {
      return `git checkout -- can overwrite working tree files (${signature})`
    }

    if (
      normalizedArgs.includes('restore') &&
      normalizedArgs.some(arg => arg.startsWith('--source'))
    ) {
      return `git restore --source can overwrite local files (${signature})`
    }

    if (
      normalizedArgs.includes('push') &&
      normalizedArgs.some(arg => arg === '--force' || arg === '-f')
    ) {
      return `git push --force rewrites remote history (${signature})`
    }
  }

  if (command === 'npm' && normalizedArgs.includes('publish')) {
    return `npm publish affects a registry outside this machine (${signature})`
  }

  if (
    command === 'node' ||
    command === 'python3' ||
    command === 'bun' ||
    command === 'bash' ||
    command === 'sh'
  ) {
    return `${command} can execute arbitrary local code (${signature})`
  }

  return null
}

// 读取持久化的权限文件，文件不存在时返回空对象
async function readPermissionStore(): Promise<PermissionStore> {
  try {
    const content = await readFile(PERMISSIONS_PATH, 'utf8')
    return JSON.parse(content) as PermissionStore
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

async function writePermissionStore(store: PermissionStore): Promise<void> {
  await mkdir(MINI_CODE_DIR, { recursive: true })
  await writeFile(PERMISSIONS_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

// === PermissionManager：权限系统的核心类 ===
//
// 维护三层记忆：
//   turn    最短 ← 一轮对话（用户按回车到 AI 回复完毕）结束就清空
//   session 中等 ← 程序运行期间有效，关掉就消失（普通 JS 变量）
//   always  永久 ← 写进 permissions.json，重启也还在
//
// 每类操作（path / command / edit）都有独立的 allow/deny 两组存储
export class PermissionManager {
  // === 永久级别（从文件加载，用户选 allow_always/deny_always 时写回文件）===
  private readonly allowedDirectoryPrefixes = new Set<string>()
  private readonly deniedDirectoryPrefixes = new Set<string>()
  private readonly allowedCommandPatterns = new Set<string>()
  private readonly deniedCommandPatterns = new Set<string>()
  private readonly allowedEditPatterns = new Set<string>()
  private readonly deniedEditPatterns = new Set<string>()

  // === session 级别（程序运行期间有效，关掉消失）===
  private readonly sessionAllowedPaths = new Set<string>()
  private readonly sessionDeniedPaths = new Set<string>()
  private readonly sessionAllowedCommands = new Set<string>()
  private readonly sessionDeniedCommands = new Set<string>()
  private readonly sessionAllowedEdits = new Set<string>()
  private readonly sessionDeniedEdits = new Set<string>()

  // === turn 级别（一轮对话内有效，beginTurn/endTurn 时清空）===
  private readonly turnAllowedEdits = new Set<string>()
  private turnAllowAllEdits = false

  // 用于等待从文件加载权限完成
  private ready: Promise<void>

  constructor(
    private readonly workspaceRoot: string,
    private readonly prompt?: PermissionPromptHandler,  // TUI 提供的弹框函数，非 TTY 模式下为空
  ) {
    this.ready = this.initialize()
  }

  // 启动时从 permissions.json 加载永久权限记录
  private async initialize(): Promise<void> {
    const store = await readPermissionStore()

    for (const directory of store.allowedDirectoryPrefixes ?? []) {
      this.allowedDirectoryPrefixes.add(normalizePath(directory))
    }

    for (const directory of store.deniedDirectoryPrefixes ?? []) {
      this.deniedDirectoryPrefixes.add(normalizePath(directory))
    }

    for (const pattern of store.allowedCommandPatterns ?? []) {
      this.allowedCommandPatterns.add(pattern)
    }

    for (const pattern of store.deniedCommandPatterns ?? []) {
      this.deniedCommandPatterns.add(pattern)
    }

    for (const pattern of store.allowedEditPatterns ?? []) {
      this.allowedEditPatterns.add(normalizePath(pattern))
    }

    for (const pattern of store.deniedEditPatterns ?? []) {
      this.deniedEditPatterns.add(normalizePath(pattern))
    }
  }

  async whenReady(): Promise<void> {
    await this.ready
  }

  // 每轮对话开始时调用，清空 turn 级别的授权
  beginTurn(): void {
    this.turnAllowedEdits.clear()
    this.turnAllowAllEdits = false
  }

  // 每轮对话结束时调用，同样清空 turn 级别（和 beginTurn 对称）
  endTurn(): void {
    this.turnAllowedEdits.clear()
    this.turnAllowAllEdits = false
  }

  // 生成权限状态摘要，注入进 system prompt 让 AI 知道当前的访问边界
  getSummary(): string[] {
    const summary = [`cwd: ${this.workspaceRoot}`]

    if (this.allowedDirectoryPrefixes.size > 0) {
      summary.push(
        `extra allowed dirs: ${[...this.allowedDirectoryPrefixes].slice(0, 4).join(', ')}`,
      )
    } else {
      summary.push('extra allowed dirs: none')
    }

    if (this.allowedCommandPatterns.size > 0) {
      summary.push(
        `dangerous allowlist: ${[...this.allowedCommandPatterns].slice(0, 4).join(', ')}`,
      )
    } else {
      summary.push('dangerous allowlist: none')
    }

    if (this.allowedEditPatterns.size > 0) {
      summary.push(
        `trusted edit targets: ${[...this.allowedEditPatterns].slice(0, 2).join(', ')}`,
      )
    }

    return summary
  }

  // 把当前永久权限集合写回 permissions.json
  private async persist(): Promise<void> {
    await writePermissionStore({
      allowedDirectoryPrefixes: [...this.allowedDirectoryPrefixes],
      deniedDirectoryPrefixes: [...this.deniedDirectoryPrefixes],
      allowedCommandPatterns: [...this.allowedCommandPatterns],
      deniedCommandPatterns: [...this.deniedCommandPatterns],
      allowedEditPatterns: [...this.allowedEditPatterns],
      deniedEditPatterns: [...this.deniedEditPatterns],
    })
  }

  // === 路径访问检查 ===
  // cwd 以内的路径直接放行；cwd 以外的路径需要审批
  // 检查顺序：永久拒绝 → session 拒绝 → 永久允许 → session 允许 → 弹框问用户
  async ensurePathAccess(targetPath: string, intent: PathIntent): Promise<void> {
    await this.ready

    const normalizedTarget = normalizePath(targetPath)

    // cwd 以内：直接放行，不需要任何审批
    if (isWithinDirectory(this.workspaceRoot, normalizedTarget)) {
      return
    }

    // 检查拒绝记录
    if (
      this.sessionDeniedPaths.has(normalizedTarget) ||
      matchesDirectoryPrefix(normalizedTarget, this.deniedDirectoryPrefixes)
    ) {
      throw new Error(`Access denied for path outside cwd: ${normalizedTarget}`)
    }

    // 检查允许记录
    if (
      this.sessionAllowedPaths.has(normalizedTarget) ||
      matchesDirectoryPrefix(normalizedTarget, this.allowedDirectoryPrefixes)
    ) {
      return
    }

    // 没有缓存记录，需要弹框问用户
    // 非 TTY 模式（管道/脚本）下没有 prompt，直接拒绝
    if (!this.prompt) {
      throw new Error(
        `Path ${normalizedTarget} is outside cwd ${this.workspaceRoot}. Start minicode in TTY mode to approve it.`,
      )
    }

    const scopeDirectory =
      intent === 'list' || intent === 'command_cwd'
        ? normalizedTarget
        : path.dirname(normalizedTarget)

    const promptResult = await this.prompt({
      kind: 'path',
      summary: `mini-code wants ${intent.replace('_', ' ')} access outside the current cwd`,
      details: [
        `cwd: ${this.workspaceRoot}`,
        `target: ${normalizedTarget}`,
        `scope directory: ${scopeDirectory}`,
      ],
      scope: scopeDirectory,
      choices: [
        { key: 'y', label: 'allow once', decision: 'allow_once' },
        { key: 'a', label: 'allow this directory', decision: 'allow_always' },
        { key: 'n', label: 'deny once', decision: 'deny_once' },
        { key: 'd', label: 'deny this directory', decision: 'deny_always' },
      ],
    })

    // 根据用户决策存到对应层级
    if (promptResult.decision === 'allow_once') {
      this.sessionAllowedPaths.add(normalizedTarget)
      return
    }

    if (promptResult.decision === 'allow_always') {
      this.allowedDirectoryPrefixes.add(scopeDirectory)
      await this.persist()   // 写入文件，下次重启也记得
      return
    }

    if (promptResult.decision === 'deny_always') {
      this.deniedDirectoryPrefixes.add(scopeDirectory)
      await this.persist()
    } else {
      this.sessionDeniedPaths.add(normalizedTarget)
    }

    throw new Error(`Access denied for path outside cwd: ${normalizedTarget}`)
  }

  // === 命令执行检查 ===
  // 普通命令直接放行；危险命令（或强制审批的命令）需要弹框
  async ensureCommand(
    command: string,
    args: string[],
    commandCwd: string,
    options?: EnsureCommandOptions,
  ): Promise<void> {
    await this.ready

    // 先检查命令执行目录的路径权限
    await this.ensurePathAccess(commandCwd, 'command_cwd')

    // 判断是否危险命令（黑名单匹配）
    const dangerousReason = classifyDangerousCommand(command, args)
    const reason = options?.forcePromptReason?.trim() || dangerousReason
    if (!reason) {
      return  // 不危险，直接放行
    }

    const signature = formatCommandSignature(command, args)

    // 检查拒绝记录
    if (
      this.sessionDeniedCommands.has(signature) ||
      this.deniedCommandPatterns.has(signature)
    ) {
      throw new Error(`Command denied: ${signature}`)
    }

    // 检查允许记录
    if (
      this.sessionAllowedCommands.has(signature) ||
      this.allowedCommandPatterns.has(signature)
    ) {
      return
    }

    if (!this.prompt) {
      throw new Error(
        `Command requires approval: ${signature}. Start minicode in TTY mode to approve it.`,
      )
    }

    const promptResult = await this.prompt({
      kind: 'command',
      summary: options?.forcePromptReason
        ? 'mini-code wants approval for this command'
        : 'mini-code wants to run a dangerous command',
      details: [
        `cwd: ${commandCwd}`,
        `command: ${signature}`,
        `reason: ${reason}`,
      ],
      scope: signature,
      choices: [
        { key: 'y', label: 'allow once', decision: 'allow_once' },
        { key: 'a', label: 'always allow this command', decision: 'allow_always' },
        { key: 'n', label: 'deny once', decision: 'deny_once' },
        { key: 'd', label: 'always deny this command', decision: 'deny_always' },
      ],
    })

    if (promptResult.decision === 'allow_once') {
      this.sessionAllowedCommands.add(signature)
      return
    }

    if (promptResult.decision === 'allow_always') {
      this.allowedCommandPatterns.add(signature)
      await this.persist()
      return
    }

    if (promptResult.decision === 'deny_always') {
      this.deniedCommandPatterns.add(signature)
      await this.persist()
    } else {
      this.sessionDeniedCommands.add(signature)
    }

    throw new Error(`Command denied: ${signature}`)
  }

  // === 文件编辑检查 ===
  // 每次 AI 要写文件都会调这里，用户可以看 diff 再决定是否允许
  // 比路径检查多了 turn 级别的粒度（allow_turn / allow_all_turn）
  async ensureEdit(targetPath: string, diffPreview: string): Promise<void> {
    await this.ready

    const normalizedTarget = normalizePath(targetPath)

    // 检查拒绝记录
    if (
      this.sessionDeniedEdits.has(normalizedTarget) ||
      this.deniedEditPatterns.has(normalizedTarget)
    ) {
      throw new Error(`Edit denied: ${normalizedTarget}`)
    }

    // 检查允许记录（包括 turn 级别）
    if (
      this.sessionAllowedEdits.has(normalizedTarget) ||
      this.turnAllowedEdits.has(normalizedTarget) ||
      this.turnAllowAllEdits ||                          // 用户选了"本轮全部允许"
      this.allowedEditPatterns.has(normalizedTarget)
    ) {
      return
    }

    if (!this.prompt) {
      throw new Error(
        `Edit requires approval: ${normalizedTarget}. Start minicode in TTY mode to review it.`,
      )
    }

    // 弹框显示 diff，让用户决定
    const promptResult = await this.prompt({
      kind: 'edit',
      summary: 'mini-code wants to apply a file modification',
      details: [
        `target: ${normalizedTarget}`,
        '',
        diffPreview,   // ← 用户看到的是 git diff 格式的变更预览
      ],
      scope: normalizedTarget,
      choices: [
        { key: '1', label: 'apply once', decision: 'allow_once' },
        { key: '2', label: 'allow this file in this turn', decision: 'allow_turn' },
        { key: '3', label: 'allow all edits in this turn', decision: 'allow_all_turn' },
        { key: '4', label: 'always allow this file', decision: 'allow_always' },
        { key: '5', label: 'reject once', decision: 'deny_once' },
        // 最智能的选项：拒绝 + 告诉 AI 为什么，AI 会收到反馈并调整方案
        { key: '6', label: 'reject and send guidance to model', decision: 'deny_with_feedback' },
        { key: '7', label: 'always reject this file', decision: 'deny_always' },
      ],
    })

    if (promptResult.decision === 'allow_once') {
      this.sessionAllowedEdits.add(normalizedTarget)
      return
    }

    if (promptResult.decision === 'allow_turn') {
      this.turnAllowedEdits.add(normalizedTarget)
      return
    }

    if (promptResult.decision === 'allow_all_turn') {
      this.turnAllowAllEdits = true
      return
    }

    if (promptResult.decision === 'allow_always') {
      this.allowedEditPatterns.add(normalizedTarget)
      await this.persist()
      return
    }

    // deny_with_feedback：把用户的指导意见作为错误信息抛出
    // agent-loop 会把这个错误信息作为 tool_result 塞回 messages
    // AI 看到之后会根据反馈调整方案，而不是简单地"失败了"
    if (promptResult.decision === 'deny_with_feedback') {
      const guidance = promptResult.feedback?.trim()
      if (guidance) {
        throw new Error(
          `Edit denied: ${normalizedTarget}\nUser guidance: ${guidance}`,
        )
      }
      this.sessionDeniedEdits.add(normalizedTarget)
      throw new Error(`Edit denied: ${normalizedTarget}`)
    }

    if (promptResult.decision === 'deny_always') {
      this.deniedEditPatterns.add(normalizedTarget)
      await this.persist()
    } else {
      this.sessionDeniedEdits.add(normalizedTarget)
    }

    throw new Error(`Edit denied: ${normalizedTarget}`)
  }
}

export function getPermissionsPath(): string {
  return PERMISSIONS_PATH
}
