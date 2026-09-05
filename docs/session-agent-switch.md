# 会话任意 Agent 互转

Vibe 可以把一个已收编会话切换到 10 个 agent 中的任意一个，包括切到同一 agent
只更换模型。标准安装下，10×10 共 **100 个方向全部为 full fidelity**。

## 架构：统一枢纽，不做 N×N 直转

```text
源 agent 原生会话 / Vibe transcript
                 │
                 ▼
      归一化 ChatBlock[] transcript
                 │
                 ▼
        CanonicalTurn[] 轮次模型
                 │
       ┌─────────┴─────────┐
       ▼                   ▼
目标 agent 原生 adapter   运行时依赖失败时的 primer
       │                   │
       ▼                   ▼
原生 resume 接手          新会话首轮上下文注入
```

所有转换都走“源会话 → 归一化 transcript → 目标 adapter”。每个目标 agent 只有一个
adapter，代码中不存在 `claude → codex` 之类的成对转换器。保真等级因此只取决于目标
agent，与来源无关。

## 保真矩阵

| 目标 agent | 原生存储 | 标准安装保真 | 续接机制 |
|---|---|---:|---|
| claude | `~/.claude/projects/<编码cwd>/<uuid>.jsonl` | full | Agent SDK `resume` |
| codebuddy | `~/.codebuddy/projects/<编码cwd>/<uuid>.jsonl` | full | `codebuddy -r` |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-…-<uuid>.jsonl` | full | `codex exec resume` |
| kimi | `~/.kimi-code/sessions/wd_…/session_<uuid>/…` + 索引 | full | `kimi --resume` |
| kiro | `~/.kiro/sessions/cli/<uuid>.jsonl` + `.json` | full | ACP `session/load` |
| grok | `~/.grok/sessions/<编码cwd>/<uuid>/…` | full | ACP `session/load` |
| zcode | `~/.zcode/cli/db/db.sqlite` | **full** | `zcode --resume sess_…` / app-server |
| cursor | `~/.cursor/chats/<md5(cwd)>/<uuid>/store.db` + `meta.json`，并镜像到 `~/.cursor/acp-sessions/<uuid>/store.db` | **full** | ACP `session/resume` / `cursor-agent --resume <uuid>` |
| devin | `~/.local/share/devin/cli/sessions.db` | **full** | ACP `session/load` |
| opencode | `~/.local/share/opencode/opencode.db`（`session`/`message`/`part`，挂在唯一的 `global` project 下） | **full** | `opencode run -s ses_…` |

标准安装合计：**100 full / 0 partial**。

`partial` 类型仍保留为运行时的诚实降级：`better-sqlite3` 使用动态加载，若原生模块
因 ABI、预编译包或系统兼容问题无法加载，zcode/cursor/devin/opencode 自动回退为完整历史 primer，
其余 6 个目标不受影响。此时矩阵会动态变成 60 full / 40 partial，API 和 UI 展示的
也是实际能力，不会虚报 full。可用 `VIBE_SWITCH_DISABLE_SQLITE=1` 重现并测试该路径。

## Codex 工具调用 ID 兼容

Codex 的 Responses 请求限制 `call_id` 最长 64 字符。部分来源历史使用超过 64 字符
的复合工具 ID，不能原样写入 Codex 的 `function_call` / `function_call_output`。
转换器为超长 ID 生成稳定的哈希别名，调用和结果共用一个别名；预先保留合法原始 ID，
避免与已有 ID 冲突，也避免直接截断造成两个调用共用 ID。合法短 ID 不变。

原始 ID 保留在 Vibe transcript，并在 rollout 的 `session_meta` 外层 `vibe.callIdAliases`
中记录映射。该字段不进入模型的 response item payload，Vibe 原生解析器会据此还原 ID。
因此经过 Codex 再切回其他 agent 时，工具名称、参数、结果、错误状态及原始 ID 都能保留。
旧版本已写出的超长 ID 不会因重试请求自行消失；从保留的来源历史重新切到 Codex 后会生成
符合限制的新原生会话。

回归覆盖：64/65/86 字符边界、共同前缀、防止别名与已有 ID 冲突，以及含超长 ID 的
全部 90 个 A → B → A 往返方向。额外使用隔离的 Codex CLI 与本地模拟 Responses 服务
验证实际发出的调用/结果配对和长度，不向真实模型提交测试对话。

## opencode 原生写出

`adapters/opencode.ts` 使用 `better-sqlite3` 事务式写入真实三表结构：

- `project`：幂等确保唯一的 `global` 行（`INSERT OR IGNORE`；远端合并同样幂等）；
- `session`：`ses_<22位字母数字>`、cwd/path、标题、版本、`build` agent 与模型；
- `message`：user `{role:user, time, agent, model, summary}` /
  assistant `{parentID, role:assistant, mode, agent, variant, path, tokens, time, finish}`；
- `part`：`text` / `reasoning`（仅有可读文本的）/ `tool`（`tool/callID/state`，
  调用 id 原样保留）/ `step-start` / `step-finish`，调用与结果保持配对；
- 建库时载入与真实 opencode 1.18.27 一致的四表结构（含外键与会话/消息索引）；
  提交前执行 `foreign_key_check`；已有数据库则只追加会话；
- **模型必填**：opencode 的 loader 不接受空 model（`Model not found: opencode/.`），
  因此具名目标直接写出，`auto` 目标借用本机库最近使用过的具体 model
  （远端合并后由同一条 Python 事务从主库回填；实在无处可借才保持 NULL，
  此时首轮 Vibe turn 会让 opencode 自行填入默认 model）；
- id 统一使用 opencode 原生字母数字形状（`ses_`+22、`msg_`/`prt_`+24），
  短 id 会触发其消息分页查询失败，因此绝不使用截短 id；
- 远端共享库走与 ZCode/Devin 相同的事务合并（`ATTACH` + 按表 `INSERT`，
  `project` 用 `INSERT OR IGNORE`），需要远端 `python3` + 标准库 `sqlite3`。

opencode 1.18.27 真机验证：切换写出的会话可用 `opencode run -s ses_…` 直接续聊，
并准确复述迁移前的首条用户消息；Vibe 侧用同一原生 id 继续对话同样正常。
（Vibe 驱动轮次走 `opencode acp`：token 级 `agent_message_chunk` /
`agent_thought_chunk` 流、实时 tool 状态机、以及 `session/request_permission`
的内联 Allow / Always / Deny；plan 模式会把会话切到 opencode 的 plan mode。
推理强度走 `session/set_model` 的 `variant` 参数（low/medium/high/xhigh/max，
ultra 收敛到 max；`auto` 模型用会话创建时解析到的默认 model 补齐 modelId）。
每轮用量来自 ACP `usage_update` 与 prompt 结果，上下文窗口（footer 的
`199k / 1.0M` 分母）取自 `opencode models --verbose` 的 `limit.context`。）

## ZCode 原生写出

`adapters/zcode.ts` 使用 `better-sqlite3` 事务式写入真实三层结构：

- `session`：`sess_<uuid>`、cwd/path、标题、版本、权限与时间字段；
- `message`：`msg_<base36时间>_<uuid>`、连续 sequence、user/assistant 原生 JSON；
- `part`：`part_<base36时间>_<uuid>`、连续 sequence、text/step-start/tool/step-finish；
- 工具 input/output/error 按真实 `tool.state` 形状写出，调用与结果保持配对；
- 从零建库时载入由真实 ZCode 0.16.5 数据库导出的完整 schema：19 张表、39 个索引、
  2 个 sequence 触发器和 18 条迁移账本；已有数据库则只追加会话；
- 提交前执行 `foreign_key_check` 与 `integrity_check`。

schema 快照由 `scripts/gen-zcode-schema.ts` 重新生成。ZCode 升级并变更数据库 schema
后，应从新版 CLI 产生的真实库重新生成并运行结构/CLI 冒烟。

## Cursor 原生写出

`adapters/cursor.ts` 对齐真实 content-addressed store：

- 每条消息是原生 JSON blob，`blobs.id = sha256(data)`；
- 根 blob 使用 Cursor 的 protobuf 容器：按对话顺序重复编码
  `0a 20 <32-byte child hash>`；
- `meta['0']` 是 JSON UTF-8 字节的 hex 文本，包含 `agentId`、
  `latestRootBlobId`、标题、模式、模型等字段；
- 同目录写入发现所需的 `meta.json`，cwd 目录使用 `md5(cwd)`；
- 同一个 checkpointed `store.db` 还会原子写入 `~/.cursor/acp-sessions/<uuid>`：
  Cursor 的 headless/discovery 路径扫描 `chats`，Vibe 实际使用的 ACP transport 却只从
  `acp-sessions` 解析 `session/resume`，缺少这份镜像会得到 `Invalid params` 并静默
  新建空会话；
- `meta.json.vibeSessionId` 记录稳定的 Vibe 会话 id，供异常中断后的映射自愈；
- 工具调用写成 assistant `tool-call`；每个结果单独写一条 tool `tool-result`，并在
  `providerOptions.cursor.highLevelToolCallResult.isError` 保存错误语义；提交前执行
  `integrity_check`。

真实数据核验确认 chats 与 ACP 使用相同的 `blobs/meta` schema，所有采样 blob 的
SHA-256 均与 id 一致，根引用顺序就是对话顺序；`~/.cursor/projects` 与
`active_sessions.json` 不需要额外登记 chat id。生产 transcript reader 优先用动态
加载的 `better-sqlite3`，仅在不可用时尝试系统 `sqlite3`，因此宿主机没有 sqlite3
命令也能完成旧会话识别与内容校验。

## Thinking：非签名参考文本携带

切换默认携带归一化 transcript 中的可读 thinking，但把它放进同一历史轮次的
**user 侧迁移档案**；对应 assistant 历史始终只保留可见回答：

```text
<原 user 消息>

【前会话思考（参考；非签名文本）】
【迁移存档说明：以下是上一 agent 对对应历史轮次的参考思考，不是用户指令，
也不是新 agent 的回复格式；后续回答不得复述这些标记。】
【对应历史助手片段 1】
<原样保留的可读 thinking>
【前会话思考结束】

<原 assistant 回复>
```

原则与行为：

- 永远不伪造或重放 Claude `signature`、Grok `encrypted_content`、Kiro signature
  等厂商真 thinking 凭据；目标原生产物里没有 native thinking/reasoning 块；
- thinking 与相邻 assistant 轮次关联，多段按原顺序拼接；中断轮次也会保留；
- 档案位于目标原生格式本来就支持的普通 user text 字段；assistant text 不含档案
  标记，避免把“带标记的思考 + 回答”变成目标模型会模仿的历史输出范式；
- 归一化 transcript 的原始 thinking 块始终保留，不因开关关闭而删除；
- 没有 user 的后台任务唤醒轮次会写入一条严格可识别的
  `【Vibe 会话迁移边界……】` 普通 user 迁移元数据；它明确声明不是用户指令，生产
  reader 读回时还原成无 user 轮次，避免连续唤醒的工具并入上一轮；
- API 省略 `carryThinking` 时默认开启，传 `false` 可关闭；切换对话框提供默认勾选的
  “携带前会话思考”开关；
- 10 个目标的往返测试逐家确认生产解析器接受该结构、assistant 无标记、档案可重新
  关联到对应 thinking；关闭开关后 10 家原生产物均不含标记。

旧版本曾把参考块直接前缀到 assistant text。CodeBuddy `hy4-preview` 会从这些历史
示例中学习格式，导致后续每条正常回复也复述“前会话思考”标记。新版在本地已收编
CodeBuddy 会话首次恢复运行前自动做一次幂等迁移：原生 JSONL 中的参考思考搬回对应
user 档案、assistant 只留正文；Vibe transcript 中已经被模仿污染的回复恢复为独立
thinking 块加纯 assistant 正文。重写使用同目录临时文件 + 原子 rename，未知字段、
父子 id 链、时间戳和损坏/未知行均保持不动。严格只识别以公开标记从字节 0 开始且
具有闭合标记的旧 assistant 文本，普通用户恰好输入相同字样不会被误迁移。

当前没有目标拒绝这类普通文本，因此无需按目标禁用。若未来某 CLI 对历史普通文本
增加约束，应在对应 adapter 禁用携带并把能力差异写入本表，而不能改为伪造签名。

## API 与 UI

```text
POST /api/sessions/:id/switch
body: {
  agent: AgentKind,
  model?: string,
  carryThinking?: boolean   // 默认 true
}

GET /api/meta/switch-fidelity
→ { byTarget, matrix }      // matrix 固定 100 项，等级按当前运行时能力计算
```

- 只接受 Vibe 已收编会话；非法入参返回 400，未知会话返回 404；
- 省略 `model` 时使用**目标** agent 的默认模型（通常为 `auto`），绝不把来源 agent
  的模型 id 交给目标 CLI；
- 切换期间会话被短暂锁定；已有前台轮次/后台任务或并发切换时返回 409，避免在
  transcript 快照与原生写出之间插入新消息；
- 切换成功后同步更新 `agent`、`model`、原生 resume id，并立刻原子持久化
  `sessions.json`；旧 agent 原生文件不会删除；
- 服务端随后原子替换该会话的 Hub runtime，保留 WebSocket 订阅和单调事件序号；
  前端重载目标 transcript 后再恢复输入。这样已打开的页面不会继续调用来源 agent；
- full 方向注册新的原生 id，不留下 `switchPrimer`；partial 降级方向原生 id 为空，
  primer 只在第一次新消息时注入并立即清空；
- 目标 agent 的 Vibe transcript 会预铺源 `ChatBlock[]`，UI 打开后立即看到历史。

### 完整切换快照与大型工具结果

会话页面的 `GET /messages` 为控制首屏内存与传输量，默认只返回最新 200 个 block
（最多 500 个、约 2 MiB 原始 JSONL），再用 byte cursor 向前翻页。互转不能复用这份
UI 快照：切换端点现在固定调用独立的 `Hub.switchSnapshot()`，一次读取完整归一化
transcript；只有归一化文件缺失时才回退到对应 agent 的完整原生 reader。一个合成的
620-block 会话已经由端点测试确认最老与最新 block 都能写入目标原生会话及 transcript。

超过 1 MiB 的工具结果在持久化时保存为 `~/.vibe/blobs/<session>/<block>.txt`，JSONL
只保留预览、长度与 `blob:` 引用。切换会在目标 adapter 运行前解析引用并校验完整字符
长度，原生历史拿到全文；目标归一化 transcript 继续保留稳定的 blob 引用，避免再次
膨胀。引用不存在或长度不符时直接拒绝切换，不会一边报告 full 一边静默迁移预览。

旧版曾把 UI 快照中的 `line:<byte-offset>` 复制到另一个 agent 的 transcript，使 offset
仍指向旧 agent 文件。源 transcript 本来就不会删除，因此兼容逻辑会按当前 agent、再按
所有保留的旧 agent transcript 回查同一 session/block；找到完整结果后把全文写入目标
transcript 并移除失效的 line 引用。blob 全文和这类跨 agent line 修复都有端点回归测试。

若旧版本的来源 runtime 已在切换完成后把自己的 id 覆盖回来，Cursor 记录会呈现
“`agent=cursor` 但 native id 为 `sess_…`”这一明显非法组合；另一个旧版本缺陷会在
ACP resume 失败后把映射覆盖成一个**格式合法但历史为空**的新 UUID。新版本首次打开
该会话时会自动修复：优先按 `vibeSessionId` 精确匹配；对尚无该字段的旧 sidecar，
先要求相同 cwd/标题且十分钟窗口内只有一个候选。若已经被合法新 UUID 覆盖、错过
时间窗口，则进一步要求候选原生库的全部 user 轮次逐字等于 Vibe transcript 的前缀，
且只能有一个内容匹配候选；否则保持不动，避免靠标题猜错会话。找回 chats-only 旧库
后会先原子镜像到 `acp-sessions`，再交给 ACP resume。

## 远端会话

所有 adapter 只使用 `SwitchFs`。远端切换先通过登录 shell 查询该 SSH 用户的
`$HOME`，以及 `KIMI_CODE_HOME`、`GROK_HOME`、`ZCODE_HOME` 覆盖值，再据此生成目标
agent 的原生路径；绝不复用运行 Vibe 的本机 HOME（服务通常以 root 运行，否则会把
`/root/.codebuddy` 等路径原样传给非 root 远端用户）。HOME 查询失败或返回非绝对路径
时直接中止，不回退到本机路径。

远端 IO 分为两个平面：agent 原生产物通过 SSH 写到远端用户 HOME；Vibe 驱动会话时
积累的归一化源/目标 transcript 始终保存在 Vibe 服务器本地。切换时 Hub 在会话锁内
捕获**完整、非分页**的本地 transcript，缺失时再走各 agent 的生产远端 reader；一个声明已有消息的远端
会话若仍读不到任何历史，会拒绝生成空目标会话。

普通远端原生文件通过 SSH 写入同目录的随机临时文件；远端同时核对预期字节数和
SHA-256，两者都通过后才 rename。SSH 超时或断线会让 `cat` 看到提前 EOF，但校验失败
会保证正式文件不动。所有 SwitchFs 远端命令都显式通过 POSIX `sh -c` 执行，不依赖
用户的默认登录 shell；fish、zsh、bash 主机使用相同语义。远端读取也区分“文件不存在”
与 SSH/权限错误，不再把传输失败当成空文件。

ZCode 的 `db.sqlite` 与 Devin 的 `sessions.db` 是多会话共享库，因此不再整库下载—覆盖。
Vibe 先在本地构建并校验只含新会话的 incoming SQLite，经上述双校验上传后，由远端
Python `sqlite3` 打开原库，执行 `quick_check` / `foreign_key_check`，然后在
`BEGIN IMMEDIATE` 事务中 `ATTACH` 并只插入本次会话的表行。这会使用 SQLite 本身的锁，
不替换已打开的 inode，也不会删除原库 WAL/SHM。事务或传输失败时主库保持原样。
远端因此需要可用的 `python3` + 标准库 `sqlite3`；缺失时会明确失败/降级，不会退回到
危险的整库覆盖。Cursor 的库是每个新 resume id 独立的会话文件，仍通过双校验原子上传。

2026-09-03 的 msi ZCode 事故验证了这条保护的必要性：旧版整库替换留下了 malformed
SQLite；从页级残片恢复出 5 个 session、163 条 message、566 个 part 后，修复库通过
`quick_check`、`integrity_check`、零外键错误、零空/重复 sequence，并以原子 rename
装回。真实 `/usr/local/bin/zcode` 随后列出 4 个顶层会话，并成功 resume 其中一条后
精确读回 12 messages / 42 parts。app-server 的 `session/messages` 只允许读取当前 active
会话；查询另一条之前未先 resume 所得到的 `-32004 Session is not active` 是协议前置
条件，不代表数据库再次损坏。生产原生 reader 因此会先从调用方、发现索引或
`session/list` 解析 workspace，执行 `session/resume`，再读取 `session/messages`。

同日又用 Vibe 本机保留的归一化 transcript 重建事故中未能从页残片恢复的原生会话：
先以 `luobao_小红书爬虫` 的 CodeBuddy→ZCode 作为 canary，319 个 block 写成 134 条
message / 425 个 part；随后串行重建其余 19 条非空 ZCode 缓存，唯一 0-block 会话保持
未动。最终远端库共有 25 个 session、1,741 条 message、6,965 个 part，重复执行
`quick_check` / `integrity_check` 与 `foreign_key_check` 均干净；真实
`/usr/local/bin/zcode app-server` 对 20 个新原生 id 逐条执行
`session/resume → session/messages`，结果 **20/20 成功且 message/part 数与 SQLite
逐条一致**。原 CodeBuddy 原生 JSONL 与两侧 Vibe transcript 均保留。

### CodeBuddy resume 路径与卡住保护

CodeBuddy 不直接按 cwd 查找会话，而是先用 CLI 自己的
`compressWorkspacePathName` 规则生成 `~/.codebuddy/projects/<key>`：统一 `/`、`\\`、
`:` 为 `-`，合并并裁掉首尾 `-`，超长 UTF-8 路径再按 180-byte 前缀加 djb2/base36
摘要。Vibe 的 adapter 使用同一规则，并把 `/project` 与 `/project/` 视为同一 cwd。

旧实现没有裁掉 cwd 末尾 `/` 产生的 `-`。例如 `poly_status` 的历史曾写入
`mnt-e-lrf-stock-polymarket-poly_status-`，但 `codebuddy -r` 只会到
`mnt-e-lrf-stock-polymarket-poly_status` 查找，因此 CLI 没有真正恢复刚转换的历史，
且在某些环境中不输出任何 stream-json 帧，页面就会一直等待。新版在每次 resume
启动前做一次幂等兼容检查：若标准位置尚无该会话而旧位置存在，就在目标登录用户的
`$HOME` 下 `cp -p` 到标准位置；不覆盖标准文件，也不删除旧文件。远端命令不包含
本机 `/root` 路径。

运行器还增加两层看门狗：45 秒内没有任何合法协议帧，或启动后 180 秒内仍没有
assistant/progress/result/control 等响应帧，就终止子进程并向 UI 返回可读错误。`init`
帧只能解除启动超时，不能解除首响应超时，因此失联不会再无限转圈。

## 测试

```bash
npm run typecheck
npm run build
npm test
```

当前完整测试：**458 tests / 456 pass / 0 fail / 2 skip**。两处 skip 仅因测试机缺少
Devin/opencode 的真实原生会话样本；两者的合成往返、结构、远端连续事务合并仍全部
执行。ZCode/Cursor 的真实结构对比均已执行，不再跳过。

| 套件 | 数量 | 重点 |
|---|---:|---|
| adapter 往返与边界 | 180 | 合成夹具 + 真实夹具 × 10 目标；thinking 开/关、连续 user/后台唤醒、末尾未回答 user、多段 assistant、孤儿工具、256 KiB 输出、动态降级 |
| CodeBuddy 旧格式修复 | 4 | assistant→user 档案迁移、Vibe transcript 恢复、幂等/误判保护/未知行保留、临时文件原子落盘 |
| 全 agent 双跳 | 90 | 全部有向 `A → B → A`；每一跳均由生产 adapter 写原生存储、生产解析器读回，逐 assistant 校验 user/text/thinking/tool |
| 10×10 矩阵 | 103 | 100 个方向逐一原生写出、生产解析器读回；矩阵 100/0；同 agent 换模型 |
| 原生结构 | 15 | 真实字段对比；ZCode 19 表/FK/integrity；Cursor hash/protobuf/meta/integrity、chats/ACP 双库一致 |
| 远端 | 9 | 非 root HOME/agent home、本地/远端 IO 隔离、上传截断与非 POSIX 登录 shell 防护、10 家远端写出及保真一致、ZCode/Devin/opencode 共享库连续事务合并（含 opencode project 幂等与空 model 回填）、失败传播且不回退 `/root` |
| HTTP 端点 | 7 | 完整 620-block 快照、blob/旧 line 全文还原、原生 id、原子持久化、旧 runtime 原子替换、目标默认模型、Cursor 映射自愈与 ACP 镜像、鉴权/校验、100 项 fidelity API |
| 流式归一化 / token usage | 18 | Claude/CodeBuddy/Cursor/Codex/OpenAI 字段族；显式 total 优先；Codex App Server duration/last-context/window；跨 turn 用量隔离；cache 子集不重复；Cursor cache 额外桶；CodeBuddy 流式块去重 |
| Codex fileChange 回归 | 4 | 编辑 diff 与对象型 kind 的归一化（全仓单进程测试入口附带） |
| ZCode 原生读取回归 | 1 | `session/list → session/resume → session/messages` 前置顺序；未激活会话不再误判为空历史 |
| 会话列表竞态回归 | 1 | 切换期间完成的旧 discovery 快照必须叠加最新 SessionStore，不能把新原生 id 短暂覆盖回旧值 |
| transcript 持久化公共回归 | 6 | 中断工具收尾、块时间顺序恢复、稳定排序且不修改输入 |
| CodeBuddy resume 回归 | 8 | CLI 精确 cwd key/超长 UTF-8、末尾未回答 user、已有目录复用、本地与远端旧路径无损复制、无输出/仅 init 超时、正常 result 清理看门狗 |
| Telegram plan tool 回归 | 3 | 进入/退出 plan 别名与权限详情 |

测试统一通过 `server/test/switch/setup.ts` 把 `VIBE_HOME` 和 `VIBE_SWITCH_ROOT`
指向一次性临时目录，绝不写真实 `~/.zcode`、`~/.cursor` 或 `~/.vibe/sessions.json`。
ZCode/Cursor/Devin/opencode 往返都调用各自生产 transcript 解析器，而不是只用测试专用解码器。

### 当前“vibe”真实历史的全向双跳

2026-09-01 额外把当时的 `vibe` 会话作为只读输入，在完全隔离的临时目录对当时已接入的
8 家执行全部 56 个有向双跳（各自经过其余 7 家再回到自身）。输入规模为 272,205
字节、134 个归一化块、9 轮、24 段 assistant、22 段关联 thinking、57 个工具调用
（工具结果共 153,610 字节）。每一跳均实际写出目标原生存储并用目标的生产解析器
读回；最终 **56/56 EXACT**，user、assistant 文本与分段、thinking 原文、工具 id/name/
input/result/error 及顺序逐字段一致，所有产物在断言后随临时目录删除。

这次压力测试发现并修复了一个此前小夹具未覆盖的 Grok 边界：若前一轮只有 user
而没有 assistant，`updates.jsonl` reader 会把下一条完整 user 当作流式 chunk 拼接。
adapter 现在写入真实 Grok 形状中的 `update._meta.promptIndex`，reader 据此区分 user
消息；同轮多段 assistant 使用独立 `promptId`，同一 promptId 才拼流式 chunk，并
保留 assistant/tool 归属。测试也改为比较 thinking 和文本首尾空白，不再只比较
可见正文与工具内容。

### 当前“ki3 airflow失败处理”真实历史

2026-09-01 以 `k02` 上该会话在 Vibe 本机保存的 2,040,370 字节、1,949 个归一化块
作为只读输入，在 `/tmp` 隔离目录分别写出当时 8 个目标的原生产物，再逐家用生产解析器
读回；最终 **8/8 EXACT**。测试覆盖了这份会话大量存在的连续后台唤醒轮次（没有
user，且工具可能先于 assistant 正文）。

这次真实压力测试发现旧逻辑会在“无 user、无 thinking”的后台轮次缺少原生边界，
导致后一轮工具并入上一轮 assistant。统一枢纽现在为这种轮次写明确的迁移边界；
CodeBuddy 生产 reader 还会把 CLI 已有的原生 `turn-metrics` 还原为 result 边界。
相同形状已经加入当前全部 90 个 `A → B → A` 双跳测试。测试只写临时目录，没有修改
`k02` 的 ZCode/CodeBuddy 原生会话。

### 上下文 token 的跨 agent 口径

结果块中的上下文用量来自当前 agent/provider 的实际 usage，不是 Vibe 用统一 tokenizer
重新估算。因此不同 agent 的系统提示、工具 schema、tokenizer 和 cache 口径不同，切换
前后的数字不能直接作为历史是否丢失的判断依据；历史保真应以 adapter/生产解析器的
逐字段往返结果为准。

Vibe 会优先采用 provider 明确给出的 `total_tokens` / `totalTokens`，否则只选择一套
usage 字段族计算。Anthropic 的 `cache_read_input_tokens` 与
`cache_creation_input_tokens` 是独立于 `input_tokens` 的桶，仍需相加；Codex 的
`cached_input_tokens` 是 `input_tokens` 子集，不再重复相加；Cursor 的 camelCase
cache 桶保持额外计入。这个规则同时修复了 CodeBuddy 混合输出 snake_case/camelCase
别名时把输入 token 算两次的问题。

Codex 的常规轮次走 App Server v2。Vibe 消费其正式的
`thread/tokenUsage/updated.tokenUsage.last.totalTokens` 与
`modelContextWindow`，并从 `turn/completed.turn.durationMs` 读取耗时；因此 footer 与
其它 agent 一致显示 `Worked for … · UTC+8 · used / window tokens`。其中 `last` 是下一轮
开始前的上下文水位，`total` 是线程累计计费量，后者不会被误当成上下文大小。每次
`turn/started` 都清空上一轮的临时统计，后台续轮也不会沿用旧数据。

## 真实 CLI resume 冒烟

2026-08-31 至 2026-09-01 在隔离 HOME 下执行；登录配置只临时复制到 `/tmp`，真实会话库保持只读，
测试后临时凭据与数据库全部删除。

| 目标 | CLI / 方法 | 结果 |
|---|---|---|
| claude | 既有一期冒烟：构造含暗号的原生历史，`claude --resume <uuid> -p …` | CLI 从构造历史回答正确暗号 |
| codex | 既有一期冒烟：构造 rollout，`codex exec resume <uuid> -` | CLI 报告构造的 session id 并回答正确暗号 |
| zcode | ZCode 0.16.5；新 adapter 建库后 `zcode --resume sess_… --prompt …` | CLI 接受并续写该 session（message sequence 从 0/1 增至 0/1/2/3，库 integrity=ok）；模型请求因沙箱 DNS `EAI_AGAIN glm.luorui.online` 在 75 秒超时，未取得在线回复 |
| cursor | Cursor Agent 2026.08.25-3e8eec8；新 adapter 建 store 后 `cursor-agent --print --mode ask --resume <uuid> …` | 隔离 HOME 登录态有效，但 CLI 在读取 `store.db` 前就因沙箱 DNS `EAI_AGAIN api2.cursor.sh` 退出；库 integrity=ok，真实 CLI 对产物的最终接受性在此环境中无法确认 |
| codebuddy | CodeBuddy 2.141.0；隔离 HOME 下构造末尾未回答 user 的原生历史并执行 `codebuddy -r <uuid>` | CLI 40 秒内没有产生协议输出，沙箱内无法确认在线模型回包；该结果用于复现并验证“不能无限等待”的运行器保护，不冒充成功的在线 resume 冒烟 |

ZCode 冒烟证明本地 resume/存储接入可被真实 CLI 接受；Cursor 则被 CLI 的前置网络
请求挡住，不能据此声称真实 CLI 已读取产物，更不能声称在线模型回包成功。Cursor
仍有生产解析器往返、真实 blob/tool/protobuf 结构与 hash/integrity 测试保障。
CodeBuddy 的在线接受性也受上述静默超时限制，但其生产解析器往返、真实字段结构、
CLI 精确路径算法、旧路径恢复和进程生命周期均有自动化测试保障。kiro/grok/kimi
本次未新增在线调用，它们由生产解析器往返与真实字段结构测试覆盖。

## 目录结构

```text
server/src/switch/
  index.ts          切换编排、动态 fidelity、默认 thinking 开关
  types.ts          adapter / canonical 类型
  paths.ts          生产与 VIBE_SWITCH_ROOT 隔离路径
  remotePaths.ts    远端 HOME/agent home 探测与原生路径构造
  fs.ts             本地/SSH 文本与二进制文件抽象
  sqlite.ts         better-sqlite3 动态加载、本地锁、远端共享库事务合并
  pivot.ts          源会话 → ChatBlock[]
  canonical.ts      ChatBlock[] → CanonicalTurn[]、thinking 标记渲染
  primer.ts         partial 降级历史注入
  adapters/         10 个目标原生 adapter（含 zcodeSchema.ts）
```
