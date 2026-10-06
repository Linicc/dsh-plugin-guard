/**
 * plugin-guard — DSH 插件装载的身份守卫
 *
 * 背景（真实事故）：
 *   插件包清单插件 @deepseek-ai/dsh-plugin-package-inventory-deepseek 会为 Loader 树里
 *   每个活跃行解析「包身份」。当某行的 name 是**路径**（不是裸包名）时，它会从模块目录
 *   向上找最近的 package.json，并要求该 manifest 的 name 与 version **同时非空**；
 *   否则直接 throw。这个异常被 dsh-llm-deepseek 的 prepareRequestExtensions() 包成
 *   REQUEST_EXTENSION —— 于是**每一轮 DeepSeek 请求都失败**，UI 只显示
 *   「本轮运行失败 DeepSeek request extension preparation failed」，看不出真正原因。
 *
 *   触发条件极低：只要插件的 patch 行指向一个没有 package.json 的散装目录，
 *   而上溯终点（如 profiles/<name>/package.json）恰好只有 name 没有 version，就会命中。
 *
 * 本插件做三件事：
 *   ① 启动自愈  —— apply() 在**任何模型请求之前**执行；扫描所有 profile 的 patch 层，
 *                  发现不合规的行就地补一个最小 package.json，把炸弹在引爆前拆掉。
 *   ② 写入即检  —— 监视对 profile patch 文件的 write/edit，落盘后立刻审计并自愈，
 *                  把诊断附回工具结果。这样错误在「犯错那一刻」就被报告，而不是等到下次请求。
 *   ③ 三个工具  —— dsh_guard_audit / dsh_guard_repair / dsh_guard_verify，
 *                  把判定逻辑显式暴露出来，可审计、可复验、可安装前预检。
 *
 * 判定逻辑严格复刻上游，避免「守卫说没问题、上游却抛错」。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, basename, resolve, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'plugin-guard'
export const inject = ['tools']

export interface Config {
  /** 启动时自动补齐缺失的 package.json（写文件）。关掉则只报告。 */
  autoRepair: boolean
  /** profile 根目录；默认取 $DSH_HOME/profiles */
  profileRoot?: string
  /** 在控制台打印审计细节 */
  verbose: boolean
}

export const Config: Schema = Schema.object({
  autoRepair: Schema.boolean().default(true),
  profileRoot: Schema.string(),
  verbose: Schema.boolean().default(false),
})

// ---------------------------------------------------------------- 上游判定逻辑复刻

/** 复刻 barePackageName()：绝对路径 / 含 ':' / 以 '.' 开头 → 不是裸包名，按路径处理 */
function isPathLike(name: string): boolean {
  if (!name) return true
  if (isAbsolute(name)) return true
  if (/^[A-Za-z]:/.test(name)) return true          // Windows 盘符
  if (name.startsWith('.')) return true
  if (name.includes(':')) return true               // 协议或盘符
  return false
}

/** 复刻 nearestManifest()：自目录向上找最近的 package.json */
function nearestManifest(startDir: string): string | undefined {
  let d = resolve(startDir)
  for (let i = 0; i < 40; i++) {
    const p = join(d, 'package.json')
    if (existsSync(p) && statSync(p).isFile()) return p
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
  return undefined
}

/** 复刻 identityFromManifest(path, allowAnonymous=false)：name 与 version 必须同时非空 */
function identityFromManifest(manifest: string): { identity?: { name: string; version: string }; error?: string } {
  let j: Record<string, unknown>
  try {
    j = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch (e) {
    return { error: `manifest 无法解析：${(e as Error).message}` }
  }
  const nm = typeof j.name === 'string' ? j.name.trim() : ''
  const ver = typeof j.version === 'string' ? j.version.trim() : ''
  if (!nm) return { error: `manifest 缺 name（${manifest}）` }
  if (!ver) return { error: `manifest 缺 version（name=${nm}，${manifest}）` }
  return { identity: { name: nm, version: ver } }
}

// ---------------------------------------------------------------- patch 文件解析

interface Row { id: string; name: string; file: string; line: number }

/** 从 cordis patch 文件里抽出带 name 的插入行。容错解析，不引入 YAML 依赖。 */
function parseRows(file: string): Row[] {
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  const rows: Row[] = []
  let cur: Row | undefined
  text.split(/\r?\n/).forEach((ln, i) => {
    const mId = ln.match(/^\s*-\s*id:\s*(.+?)\s*$/)
    if (mId) {
      cur = { id: unquote(mId[1]), name: '', file, line: i + 1 }
      rows.push(cur)
      return
    }
    const mNm = ln.match(/^\s*-\s*name:\s*(.+?)\s*$/)      // 也允许 name 在前
    if (mNm) {
      cur = { id: '', name: unquote(mNm[1]), file, line: i + 1 }
      rows.push(cur)
      return
    }
    const mN = ln.match(/^\s*name:\s*(.+?)\s*$/)
    if (mN && cur && !cur.name) cur.name = unquote(mN[1])
    const mI = ln.match(/^\s*id:\s*(.+?)\s*$/)
    if (mI && cur && !cur.id) cur.id = unquote(mI[1])
  })
  return rows.filter((r) => r.name && r.id)
}

function unquote(s: string): string {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1)
    // YAML 双引号支持 \uXXXX 转义
    if (t.startsWith('"')) {
      try { return JSON.parse(t) as string } catch { /* 保底 */ }
    }
    return inner
  }
  return t
}

// ---------------------------------------------------------------- 审计

interface Finding {
  profile: string
  file: string
  id: string
  modulePath: string
  moduleDir: string
  manifest?: string
  identity?: string
  problem: string
  repairable: boolean
}

function profileRootOf(config: Config): string {
  if (config.profileRoot) return config.profileRoot
  return join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'profiles')
}

function audit(root: string): { scanned: number; rows: number; findings: Finding[]; ok: string[] } {
  const findings: Finding[] = []
  const ok: string[] = []
  let scanned = 0
  let rowCount = 0
  if (!existsSync(root)) return { scanned, rows: rowCount, findings, ok }

  for (const prof of readdirSync(root)) {
    const pdir = join(root, prof)
    if (prof === 'node_modules') continue
    try { if (!statSync(pdir).isDirectory()) continue } catch { continue }
    scanned++
    const patches = readdirSync(pdir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    for (const pf of patches) {
      const file = join(pdir, pf)
      for (const r of parseRows(file)) {
        rowCount++
        if (!isPathLike(r.name)) { ok.push(`${prof}/${r.id}（裸包名）`); continue }
        const target = isAbsolute(r.name) ? r.name : resolve(pdir, r.name)
        let moduleDir: string
        try { moduleDir = statSync(target).isDirectory() ? target : dirname(target) }
        catch { moduleDir = dirname(target) }
        const manifest = nearestManifest(moduleDir)
        if (!manifest) {
          findings.push({
            profile: prof, file, id: r.id, modulePath: target, moduleDir,
            problem: '自模块目录向上找不到任何 package.json', repairable: true,
          })
          continue
        }
        const { identity, error } = identityFromManifest(manifest)
        if (error) {
          // 只有「最近 manifest 就在插件自己的目录里」才适合补写；
          // 若上溯到了别人的 manifest，应当在该插件目录新建一个，而不是改别人的文件。
          const own = join(moduleDir, 'package.json')
          findings.push({
            profile: prof, file, id: r.id, modulePath: target, moduleDir,
            manifest, problem: error, repairable: !existsSync(own),
          })
          continue
        }
        ok.push(`${prof}/${r.id} → ${identity!.name}@${identity!.version}`)
      }
    }
  }
  return { scanned, rows: rowCount, findings, ok }
}

/** 在模块目录补一个最小合规 manifest（永不覆盖已有文件） */
function repair(f: Finding): string | undefined {
  const own = join(f.moduleDir, 'package.json')
  if (existsSync(own)) return undefined
  const raw = basename(f.moduleDir).replace(/[^A-Za-z0-9._-]/g, '-').toLowerCase()
  const pkgName = raw ? `dsh-local-${raw}` : 'dsh-local-plugin'
  try {
    mkdirSync(f.moduleDir, { recursive: true })
    writeFileSync(own, JSON.stringify({
      name: pkgName,
      version: '0.0.0',
      private: true,
      description: '由 dsh-plugin-guard 自动补齐：Loader 要求被挂载的插件目录自带合规 manifest',
    }, null, 2) + '\n', 'utf8')
    return own
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- 插件主体

export function apply(ctx: Context, config: Config = { autoRepair: true, verbose: false }) {
  const root = profileRootOf(config)
  const log = (m: string) => { if (config.verbose) console.log(`[plugin-guard] ${m}`) }

  // ---------- ① 启动自愈：必须早于任何模型请求 ----------
  let startup: { scanned: number; rows: number; findings: Finding[]; fixed: string[] } =
    { scanned: 0, rows: 0, findings: [], fixed: [] }
  try {
    const a = audit(root)
    const fixed: string[] = []
    if (config.autoRepair) {
      for (const f of a.findings) {
        if (!f.repairable) continue
        const p = repair(f)
        if (p) fixed.push(p)
      }
    }
    startup = { scanned: a.scanned, rows: a.rows, findings: a.findings, fixed }
    if (a.findings.length) {
      console.log(`[plugin-guard] ⚠ 发现 ${a.findings.length} 个会导致 REQUEST_EXTENSION 的装载行`)
      for (const f of a.findings) console.log(`[plugin-guard]    ${f.profile}/${f.id}: ${f.problem}`)
      for (const p of fixed) console.log(`[plugin-guard] ✅ 已补 ${p}`)
    } else {
      log(`profile 装载行全部合规（${a.scanned} 个 profile，${a.rows} 行）`)
    }
  } catch (e) {
    console.log(`[plugin-guard] 启动自愈异常（已忽略，不影响启动）：${(e as Error).message}`)
  }

  // ---------- ③ 工具：审计 ----------
  ctx.tools.register(defineTool({
    name: 'dsh_guard_audit',
    description:
      '审计 DSH 所有 profile 的插件装载行，复刻官方「包身份解析」逻辑，找出会导致 REQUEST_EXTENSION ' +
      '（整轮 DeepSeek 请求失败）的行。任何新增/修改插件之后都应跑一次。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          root: { type: 'string' },
          profiles: { type: 'integer' },
          rows: { type: 'integer' },
          healthy: { type: 'array', items: { type: 'string' } },
          problems: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                profile: { type: 'string' }, id: { type: 'string' },
                moduleDir: { type: 'string' }, manifest: { type: 'string' },
                problem: { type: 'string' }, repairable: { type: 'boolean' },
              },
            },
          },
          ok: { type: 'boolean' },
        },
      },
      render: (_a, v) => [{
        type: 'text' as const,
        text: v.ok
          ? `✅ plugin-guard 审计通过\n  profile ${v.profiles} 个 · 装载行 ${v.rows} 行 · 全部身份可解析\n` +
            v.healthy.map((h) => '    · ' + h).join('\n')
          : `❌ plugin-guard 发现 ${v.problems.length} 个会导致 REQUEST_EXTENSION 的装载行：\n` +
            v.problems.map((p) => `    · [${p.profile}] ${p.id}\n        模块目录: ${p.moduleDir}\n        问题: ${p.problem}`).join('\n') +
            `\n\n立即用 dsh_guard_repair 修复，否则下一轮 DeepSeek 请求会整轮失败。`,
      }],
    },
    async execute() {
      const a = audit(root)
      return {
        root,
        profiles: a.scanned,
        rows: a.rows,
        healthy: a.ok,
        problems: a.findings.map((f) => ({
          profile: f.profile, id: f.id, moduleDir: f.moduleDir,
          manifest: f.manifest ?? '', problem: f.problem, repairable: f.repairable,
        })),
        ok: a.findings.length === 0,
      }
    },
  }))

  // ---------- ③ 工具：修复 ----------
  ctx.tools.register(defineTool({
    name: 'dsh_guard_repair',
    description:
      '为不合规的插件目录补一个最小 package.json（name + version），消除 REQUEST_EXTENSION 隐患。' +
      '幂等、永不覆盖已有文件。补完后用 dsh_guard_audit 复验。',
    parameters: {
      dryRun: { type: 'boolean', description: '只报告将写入哪些文件，不实际写（默认 false）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          created: { type: 'array', items: { type: 'string' } },
          skipped: { type: 'array', items: { type: 'string' } },
          remaining: { type: 'integer' },
          dryRun: { type: 'boolean' },
        },
      },
      render: (_a, v) => [{
        type: 'text' as const,
        text: [
          v.dryRun ? '（dry-run，未写入任何文件）' : '',
          v.created.length ? `✅ 已补 ${v.created.length} 个 package.json：\n` + v.created.map((p) => '    ' + p).join('\n') : '没有需要补的目录',
          v.skipped.length ? `⚠ 跳过 ${v.skipped.length} 个（需人工处理）：\n` + v.skipped.map((p) => '    ' + p).join('\n') : '',
          `修复后仍未通过的行：${v.remaining}`,
        ].filter(Boolean).join('\n'),
      }],
    },
    async execute(args) {
      const a = audit(root)
      const created: string[] = []
      const skipped: string[] = []
      for (const f of a.findings) {
        if (!f.repairable) { skipped.push(`${f.profile}/${f.id} — ${f.problem}`); continue }
        if (args.dryRun) { created.push(join(f.moduleDir, 'package.json') + '（将创建）'); continue }
        const p = repair(f)
        if (p) created.push(p)
        else skipped.push(`${f.profile}/${f.id} — 写入失败`)
      }
      const after = args.dryRun ? a.findings.length : audit(root).findings.length
      return { created, skipped, remaining: after, dryRun: Boolean(args.dryRun) }
    },
  }))

  // ---------- ③ 工具：安装前预检 ----------
  ctx.tools.register(defineTool({
    name: 'dsh_guard_verify',
    description:
      '安装一个本地插件**之前**的预检：给定 .ts/.js 文件或目录，判断它作为 patch insert 行时能否通过官方包身份解析。' +
      '避免装完之后整轮 DeepSeek 请求被 REQUEST_EXTENSION 打死。',
    parameters: {
      path: { type: 'string', required: true, description: '插件入口文件或目录的路径' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          moduleDir: { type: 'string' }, manifest: { type: 'string' },
          identity: { type: 'string' }, ok: { type: 'boolean' },
          advice: { type: 'string' },
        },
      },
      render: (_a, v) => [{
        type: 'text' as const,
        text: v.ok
          ? `✅ 可以安全安装\n  模块目录: ${v.moduleDir}\n  解析到  : ${v.identity}`
          : `❌ 不能直接安装，会触发 REQUEST_EXTENSION\n  模块目录: ${v.moduleDir}\n  问题    : ${v.advice}`,
      }],
    },
    async execute(args) {
      const target = resolve(args.path)
      let moduleDir: string
      try { moduleDir = statSync(target).isDirectory() ? target : dirname(target) }
      catch { throw new Error(`路径不存在：${target}`) }
      const manifest = nearestManifest(moduleDir)
      if (!manifest) {
        return { moduleDir, manifest: '', identity: '', ok: false,
          advice: '自模块目录向上找不到任何 package.json。请在该插件目录放一个含 name 与 version 的 package.json。' }
      }
      const { identity, error } = identityFromManifest(manifest)
      if (error) {
        return { moduleDir, manifest, identity: '', ok: false,
          advice: `${error}。请在 ${moduleDir} 放一个含 name 与 version 的 package.json（不要让解析上溯到 profile 根 manifest）。` }
      }
      return { moduleDir, manifest, identity: `${identity!.name}@${identity!.version}`, ok: true, advice: '' }
    },
  }))

  // ---------- ② 写入即检：改 profile patch 后立刻自愈 ----------
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      const nm = exec.name
      if (nm !== 'write' && nm !== 'edit') return decision
      const target = (exec.arguments as { file_path?: string } | undefined)?.file_path
      if (!target) return decision
      const lower = target.toLowerCase()
      if (!(lower.endsWith('.yml') || lower.endsWith('.yaml'))) return decision
      // 只关心 profile 的 patch 层
      const rel = relative(root, resolve(target))
      if (rel.startsWith('..')) return decision

      const a = audit(root)
      const fixed: string[] = []
      if (a.findings.length) {
        for (const f of a.findings) {
          if (!f.repairable) continue
          const p = repair(f)
          if (p) fixed.push(p)
        }
      }
      const remaining = a.findings.length - fixed.length
      const note = a.findings.length === 0
        ? `\n\n[plugin-guard] ✅ ${basename(target)} 写入后的装载行审计通过（${a.rows} 行身份均可解析）。`
        : fixed.length
          ? `\n\n[plugin-guard] 🔧 ${basename(target)} 引入了 ${a.findings.length} 个会导致 REQUEST_EXTENSION 的装载行，` +
            `已自动补齐 ${fixed.length} 个 package.json 拆掉隐患：\n` +
            fixed.map((p) => '  · ' + p).join('\n') +
            (remaining ? `\n  仍有 ${remaining} 行需人工处理——用 dsh_guard_audit 查看。` : '')
          : `\n\n[plugin-guard] ⚠ ${basename(target)} 引入了 ${a.findings.length} 个会导致 REQUEST_EXTENSION 的装载行，` +
            `且无法自动修复（需人工处理）。下一轮 DeepSeek 请求会整轮失败，请先运行 dsh_guard_audit。`

      if (decision.kind === 'accept' && Array.isArray(decision.content)) {
        return { kind: 'accept' as const, content: [...decision.content, { type: 'text' as const, text: note }] }
      }
    } catch { /* 守卫绝不能因为自身异常影响工具结果 */ }
    return decision
  })

  log(`已就绪：profileRoot=${root} autoRepair=${config.autoRepair}`)
}
