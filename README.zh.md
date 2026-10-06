# dsh-plugin-guard

**DeepSeek Harness 的插件装载身份守卫。** 阻止「不合规的插件挂载行」把**每一轮** DeepSeek 请求
打成 `REQUEST_EXTENSION`。

[English README](README.md)

---

## 它防的是什么

`@deepseek-ai/dsh-plugin-package-inventory-deepseek` 在请求期给每个活跃的 Loader 行解析「包身份」。
当某行的 `name` 是**路径**时，它自模块目录向上找最近的 `package.json`，要求 `name` 与 `version`
**同时非空**，否则 `throw`：

```js
function identityFromManifest(path, allowAnonymous) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (allowAnonymous && manifest.name === void 0) return void 0;   // ← 只容忍缺 name
  if (typeof manifest.name !== "string" || manifest.name.length === 0
   || typeof manifest.version !== "string" || manifest.version.length === 0)
    throw new Error(`... ${path} must declare non-empty name and version`);
  return { name: manifest.name, version: manifest.version };
}
```

`dsh-llm-deepseek` 再把它包一层：

```js
catch (error) {
  throw new LlmError("DeepSeek request extension preparation failed", "REQUEST_EXTENSION", { cause: error });
}
```

**结果**：官方 DeepSeek 请求**每一轮全部失败**，而 UI 只显示被覆盖过的笼统文案，
看起来像模型或账号的问题。

### 为什么很容易踩中

被命中的 manifest 通常就是 **DSH 自己生成的 profile manifest**——它有 `name`，没有 `version`：

```jsonc
// $DSH_HOME/profiles/<name>/package.json   ← DSH 生成
{ "name": "dsh-profile-desktop" }
```

于是**任何**自身目录没有 `package.json` 的本地插件都会触发：

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- insert:
    - id: myplugin
      name: "C:/Users/<user>/.dsh/profiles/<profile>/plugins/myplugin/index.ts"
```

`nearestManifest()` 从 `plugins/myplugin/` → `plugins/` → `profiles/<profile>/` 一路向上，
正好落在那个没有 `version` 的 manifest 上。

### 它与调用方的契约自相矛盾

调用方本来就允许解析失败：

```js
const identity = resolver.resolve(activeEntry);
if (identity === void 0) continue;        // 契约：undefined = 跳过该条目
```

`resolve()` 的返回类型也写着 `... | undefined`。在这里 `throw` 属于**错误分级失当**：
尽力而为的诊断性元数据，不该持有请求级否决权。

---

## 三道防线

以 DSH 组合包形式发布（`dsh.bundle.patch`），可直接安装而非手动复制。

写法上**逐字复刻**上游判定规则，保证守卫永远不会与上游不一致。

| # | 机制 | 时机 | 效果 |
|---|---|---|---|
| ① | **启动自愈** | `apply()`，早于任何模型请求 | 扫描所有 profile 的 patch 层，给不合规的插件目录补最小合规 `package.json` |
| ② | **写入即检** | profile 下任何 `.yml/.yaml` 落盘后 | 立刻复检并自愈，把结果附回工具返回值 |
| ③ | **三个工具** | 随时 | `dsh_guard_audit` / `dsh_guard_repair` / `dsh_guard_verify` |

启动自愈属于**整个 profile**：加载一次，该 profile 下所有会话都受保护。实测耗时 **~1 ms**。

---

## 安装

本仓库是一个 **DSH 组合包（bundle）**：npm 包在 `package.json` 里声明 `dsh.bundle.patch`，
profile 把它列进 `dsh.profile.bundles` 后，插件行会被自动插入。

### 作为组合包安装（推荐）

```sh
# 从本地克隆
dsh plugin --profile <profile> add /path/to/dsh-plugin-guard

# 或直接从 git 安装
dsh plugin --profile <profile> add github:Linicc/dsh-plugin-guard
```

`dsh plugin` 会在 profile 目录内转发给 pnpm，然后因为该包声明了 `dsh.bundle`，
把它追加进 `dsh.profile.bundles`。真正插入插件行的是包内的 `cordis.patch.yml`：

```yaml
- insert:
    - id: plugin-guard
      name: dsh-plugin-guard
```

注意这里按**包名**引用，不是路径——这正是让 Node 能定位到已安装代码的原因。
它也意味着这一行走的是「裸包名」解析分支，**不依赖最近 manifest 上溯**，天然规避了本插件要防的那个坑。

### 作为本地模块挂载（不打包）

如果不想装包，克隆到任意位置，用绝对路径挂载：

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- insert:
    - id: plugin-guard
      name: "<绝对路径>/dsh-plugin-guard/src/index.ts"
```

> ⚠️ 插件目录**必须**自带合规的 `package.json`。挂载一个没有 manifest 的目录，
> 正是本插件要防的那个条件——见[它防的是什么](#它防的是什么)。
> 本仓库已经带了，但如果你把源码复制到别处，记得把 manifest 一起复制。

### 配置

```yaml
- id: plugin-guard
  name: dsh-plugin-guard
  config:
    autoRepair: true       # 启动时自动补 manifest（默认 true）
    verbose: false         # 打印审计细节
    # profileRoot: "..."   # 默认 $DSH_HOME/profiles
```

### 仓库结构

```
dsh-plugin-guard/
├─ package.json        声明 dsh.bundle.patch；main → lib/index.js
├─ cordis.patch.yml    profile 列出本包时应用的配置层
├─ lib/index.js        编译产物（已提交，使用者无需构建）
├─ src/index.ts        源码
├─ scripts/build.mjs   用 Node 内置类型剥离从 src 重建 lib
├─ README.md / README.zh.md
└─ LICENSE
```

改完源码后重建：

```sh
npm run build      # node scripts/build.mjs —— 无需任何依赖
```

## 三个工具

| 工具 | 用途 |
|---|---|
| `dsh_guard_audit` | 审计所有 profile 的装载行，列出会抛错的行（含 profile / 行 id / 模块目录 / 具体问题） |
| `dsh_guard_repair` | 为不合规目录补 `package.json`；幂等，**永不覆盖**；支持 `dryRun` |
| `dsh_guard_verify` | **安装前预检**：给定插件入口，判断它能否通过官方身份解析 |

---

## 实现要点与安全边界

判定规则逐条对照上游（`isPathLike` / `nearestManifest` / `identityFromManifest`），
且刻意**比上游更保守**：上游只看活跃行，本插件看所有行——代价是偶尔报出「今天没启用、
一启用就会炸」的行，这是期望行为。

**安全边界**：

- 只在该插件**自己的目录里完全没有** `package.json` 时才写；从不修改别的包的 manifest。
- 若问题 manifest 属于上层（如 profile 根），标记 `repairable: false` 交人工处理——
  守卫**不会**去改你的 profile manifest。
- 所有写入与审计都包在 `try/catch` 里：**守卫绝不能自己成为它要防的那个故障**。
- 每次写入都会在控制台打印，不做静默操作。

---

## 已知局限

- **上游缺陷仍在**：本插件是用户侧预防，不修
  `@deepseek-ai/dsh-plugin-package-inventory-deepseek` 里的 `identityFromManifest()`。
  同一条失败路径的**其他**触发方式（例如残留软链，见上游 discussion #5439）仍会打死请求。
  已上报：[discussion #4950](https://github.com/deepseek-ai/deepseek-harness/discussions/4950)。
- **YAML 解析是容错子集**：只抽取 `- id:` / `name:` 对；锚点、合并键等特殊写法可能看不到。
  守卫选择「失败即放行」（什么都不报），而不是让启动失败。
- **JSON 解析失败的 manifest** 只报告、不修复。
- **没有文件监听**：只有 host 启动与工具写入会触发审计；用外部编辑器改的 patch 会在下次启动时生效。

---

## 验证

```
沙箱构造：
  profiles/desktop/package.json  → { "name": "dsh-profile-desktop" }   ← 有 name 无 version
  cordis.patch.yml               → insert 行指向没有 package.json 的目录
  plugins/myplugin/index.ts      → 只有入口文件

autoRepair: false
  dsh_guard_audit  → ok=false, 问题=1            ✅ 能检测
  dsh_guard_verify → ok=false + 修复建议          ✅ 能预检
  dsh_guard_repair → 创建 package.json           ✅ 能修复
  再次 audit       → ok=true,  问题=0            ✅ 能复验

autoRepair: true（默认）
  apply() 约 1 ms 内补齐 manifest                ✅ 引爆前拆弹

真实 profile
  audit → profile 2 个 · 装载行 8 行 · 问题 0
```

---

## 许可

MIT，见 [LICENSE](LICENSE)。
