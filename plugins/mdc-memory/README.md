# @local/mdc-memory

dsh bundle：在本机托管一个 basic-memory 进程，为 agent 提供长期记忆（记忆工具与记忆提示词），并在设置的 Memory 区域展示运行状态、管理知识库。安装、升级、卸载与开发模式见仓库根目录的 `README.md`。

## 结构

| 路径 | 作用 |
|---|---|
| `host/` | Host 插件行 `mdc-memory`（包入口 `@local/mdc-memory/host`） |
| `host/config.js` | 配置默认值与形状校验 |
| `host/runtime/` | 托管运行时：状态机、子进程组、隔离环境，以及 `stages/` 下的四个阶段（source、venv、model、server） |
| `host/basic-memory/` | basic-memory 的客户端：v2 REST API 与 MCP 端点（只在运行时就绪时可用） |
| `host/knowledge-base/` | 知识库：列表、添加、删除、使能、生效知识库计算、注册校验，以及经验 schema 笔记（`lesson-schema.md`） |
| `host/agents/` | 主 agent 跟踪（`watchMainAgents`），供记忆工具与召回共用 |
| `host/memory-tools/` | 记忆工具代理：上游工具目录与白名单、代理工具定义、每次调用的知识库判定、记忆提示词段落、lesson 技能的读取 |
| `skills/lesson/` | bundle 自带的 lesson 技能（`SKILL.md`），告诉 agent 如何沉淀经验 |
| `host/http/` | 通用 JSON 路由注册（鉴权、请求体、错误映射）、运行时接口和知识库接口 |
| `client/` | Client 插件行 `mdc-memory-ui`（包入口 `@local/mdc-memory`），设置中的 Memory 区域 |
| `python/` | 打包时由 `tools/pack` 放入的 basic-memory 源码，只存在于 tarball 中，不进 git |
| `test/` | node:test 测试，从 `apply(ctx, config)` 入口驱动 |

## 配置（Host 行 `mdc-memory`）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `pythonSource` | bundle 内的 `python/` | basic-memory 源码目录的绝对路径，需包含 `pyproject.toml` 与 `uv.lock`；开发时指向 submodule |
| `dataDir` | `dshHomePath('memory')`，即 `~/.dsh/memory` | 虚拟环境、模型缓存与 basic-memory 配置和索引所在目录 |
| `python` | `python` | 用来执行 `python -m uv` 的解释器，可写 PATH 上的名字或绝对路径 |
| `segmentation` | `jieba` | 全文检索对中文等无空格文字的切分策略：`jieba` 按词切分，`ngram` 为上游的单字加双字片段 |
| `segmentationUserDict` | 无 | jieba 用户词典的绝对路径（UTF-8，每行 `词语 [词频] [词性]`），其中的术语作为整词切分；仅 `jieba` 策略使用 |
| `memoryTools` | `[write_note, read_note, edit_note, search_notes, build_context, recent_activity, list_directory]` | 记忆工具白名单：暴露给主 agent 的 basic-memory MCP 工具名（字母、数字、`_`、`-`，不超过 57 个字符），按此顺序注册 |

profile 的 `cordis.patch.yml` 中覆盖配置会整体替换 `config`，未写的字段使用上表默认值。开发时把 `pythonSource` 指向 submodule：

```yaml
- id: mdc-memory
  config:
    pythonSource: C:\path\to\mdc-memory\vendor\basic-memory
```

## 运行流程

启动后在后台依次执行四个阶段，任一阶段失败都只把状态置为“错误”，dsh 照常运行（fail-open）：

1. `source`：确认 `pythonSource` 是 basic-memory 源码目录，并对其内容计算 SHA-256 指纹（相对路径与文件内容，跳过隐藏条目、`__pycache__` 与 `node_modules`）。打包的源码没有 `.git`，版本号恒为 `0.0.0`，所以只能靠内容区分新旧源码。
2. `venv`：虚拟环境位于 `<dataDir>/venv`，其中的 `mdc-memory-build.json` 记录它由哪份源码（指纹）和哪组 `uv sync` 参数建成。记录与当前一致时直接复用；否则先删除记录，执行 `python -m uv sync --python 3.12 --frozen --no-dev --no-editable --reinstall-package basic-memory`，成功后写入新记录。
   - `--no-editable`：把 basic-memory 复制进虚拟环境，不依赖 bundle 目录。
   - `--reinstall-package basic-memory`：版本号不变时 uv 会认为已安装的包是最新的，必须强制用新源码重新构建。
   - 构建中断或失败时不会留下记录，下次启动一定重建。
3. `model`：用虚拟环境预下载 embedding 模型 `BAAI/bge-small-zh-v1.5` 到 `<dataDir>/fastembed_cache`（走系统代理）。
4. `server`：在 `127.0.0.1` 的空闲端口上启动 `basic-memory serve`，`/v2/projects/` 返回 200 即就绪。

basic-memory 的配置与索引位于 `<dataDir>/config`，默认项目位于 `<dataDir>/main`，不会读写用户自己的 `~/.basic-memory`。插件卸载或 dsh 关闭时终止整个进程树。

中文切分策略通过环境变量 `BASIC_MEMORY_SCRIPT_SEGMENTATION`（取自 `segmentation`）和 `BASIC_MEMORY_SCRIPT_SEGMENTATION_USER_DICT`（取自 `segmentationUserDict`）传给 basic-memory，建索引与查询使用同一策略。basic-memory 在索引库中记录生成全文索引所用的策略（含 jieba 版本与用户词典内容的哈希），启动时发现不一致就原地重算全文索引中的中文切分列，不重读笔记文件，也不重新计算 embedding。用户词典不存在时 basic-memory 启动失败，状态区显示错误。

传给 Python 子进程的 `NO_PROXY` / `no_proxy` 会改写成 httpx 能解析的形式：dsh 追加的 `[::1]` 这类带方括号的 IPv6 地址改为裸地址，无法改写的条目（如 `[::1]:8080`）丢弃，其余条目按原顺序去重保留。

## 知识库

- 知识库就是 basic-memory 的项目。名称和路径只来自 basic-memory 自己的项目配置，插件不另存副本。
- basic-memory 的默认项目（即 `<dataDir>/main`）保留给插件内部使用：不出现在列表中，不能删除，名称和目录也不能被新知识库占用。
- 使能状态存放在 dsh 插件存储的 `mdc_memory_kb` 域（`~/.dsh/storages/mdc_memory_kb.json`），以知识库名称为键，全局唯一，重启后保持；没有记录的知识库视为使能。
- 添加：先校验名称（不区分大小写）不重名、路径为完整的绝对路径、且与已登记的目录不相同也不互相嵌套；再在 basic-memory 中注册（目录不存在时自动创建），把经验 schema 笔记写到 `schema/lesson.md`（文件已存在则跳过，不覆盖），然后让 basic-memory 在后台为目录中的文件建立索引，最后记为使能。注册之后的任一步骤失败都会注销该知识库。
- 删除：在 basic-memory 中注销并清理索引，删除使能记录，磁盘上的文件保留。
- 生效知识库 = 所有使能的知识库，每次调用实时计算。Host 内部接口（供工具代理和召回使用）：

| 方法 | 说明 |
|---|---|
| `knowledgeBases.effective(signal?)` | 返回生效知识库数组，每项含 `name`、`path`、`enabled`、`projectId`（basic-memory 内部 id，跨项目检索的 `project_ids` 用它）、`externalId`（REST 路径用）；basic-memory 未就绪时抛出 `BasicMemoryUnavailableError` |
| `knowledgeBases.list(signal?)` | 返回全部知识库（含未使能的，不含内部默认项目），字段同上 |
| `knowledgeBases.onChange(listener)` | 知识库增删、开关变化，或 basic-memory 就绪状态变化时回调；返回取消订阅函数。回调里自行重新读取 `effective()` |

### 经验 schema

`schema/lesson.md` 定义经验笔记（`type: lesson`）：必填观察 `[symptom]`（可多条）、`[cause]`、`[fix]`（可多条），可选观察 `[condition]`（可多条），可选关系 `relates_to`、`supersedes`，frontmatter 含 `status`（`active` | `outdated`）与可选的 `tags`，校验模式为告警（`warn`）。

## 记忆工具

按 ADR 0002，Host 插件把 basic-memory 的 MCP 工具代理为 dsh 原生工具，只注册给主 agent。

- 主 agent：创建时没有所属 agent 的运行时根 agent，且会话不是以子 agent 身份创建的（`session.header.origin` 不为 `subagent`）。记忆工具和记忆提示词注册在主 agent 自己的作用域上；子 agent 的作用域链不包含委派它的 agent，所以看不到。插件加载时已经存在的主 agent 同样会被接管。
- 工具目录：basic-memory 就绪后用 MCP `tools/list` 读取上游工具，按白名单 `memoryTools` 的顺序取出其中在单个项目内工作的工具（参数里有 `project`），注册为 `memory_<上游工具名>`。上游新增的工具只需加入白名单即可暴露。白名单里上游没有的工具，以及不在单个项目内工作的工具（如 `list_memory_projects`），都不会暴露，并在日志中告警。上游工具列表不变时沿用同一组工具定义，开关知识库不会让工具重新注册。
- 参数：上游用来选择项目的 `project_id`、`projects`、`search_all_projects`、`workspace` 不暴露给模型，`project` 改为可选的知识库名称。调用里出现工具没有声明的参数（包括上游的别名，如 `all_projects`）时直接拒绝。
- 每次调用都实时读取生效知识库，再确定目标知识库：
  - 传了 `project`：必须是生效知识库（名称不区分大小写）。已关闭的知识库、不存在的名称（包括内部默认项目 `main`）都会被拒绝，错误中说明原因并列出生效知识库。
  - 没传 `project`：只有一个生效知识库时自动补全；有多个时拒绝，错误中列出可选的知识库。
  - 参数值是 `memory://` URL、且首段指向某个项目时，该项目必须就是目标知识库：指向另一个生效知识库时提示改传对应的 `project`；指向未生效的知识库或内部默认项目时拒绝。
  - 转发给 basic-memory 的调用总是带上显式的 `project`。basic-memory 报告的工具错误作为工具调用失败返回给 agent。
- 记忆提示词：一个常驻系统提示词段落，列出生效知识库，并说明何时读取 `lesson` 技能（见下节）。段落和工具一起注册在主 agent 上，文字随生效知识库实时变化。
- 没有生效知识库、basic-memory 未就绪或读取工具目录失败时，主 agent 上既没有记忆工具，也没有记忆提示词和 lesson 技能。进行中的会话会随设置变化即时增减；插件卸载时一并撤下。
- 记忆工具、记忆提示词和 lesson 技能依赖 dsh 的 `tools`、`systemPrompt`、`skills` 服务（`skills` 来自 dsh-base 的 `skill` 行，默认挂载）；缺少任一服务时三者都不注册。

## lesson 技能

- bundle 自带 `skills/lesson/SKILL.md`。Host 启动时读取它，`name`、`description` 取自 frontmatter，正文去掉 frontmatter 后作为技能内容，以 `lesson` 为名、`source: bundled` 注册到 dsh 的技能注册表。
- 注册在主 agent 自己的作用域上，与记忆工具、记忆提示词同时出现、同时撤下；子 agent 看不到。主 agent 从 dsh 的技能目录中发现它，用 `skill` 工具读取；技能目录变化时 dsh 会在下一步给会话追加新的目录。用户也可以输入 `/lesson` 直接注入。主 agent 作用域里的 `lesson` 优先于全局的同名技能（如用户目录中的技能）。
- 不注册 basic-memory 上游自带的技能。沉淀没有自动触发：只在 agent 按技能判断值得沉淀、或用户要求时发生。
- 技能内容：何时沉淀、多个生效知识库时如何选择、经验格式（与 `schema/lesson.md` 一致）、先检索再新建或更新、用 `supersedes` 取代旧经验、标记 `status: outdated`、经验与参考笔记的区别。
- 技能中的示例工具调用写成 ```` ```json memory_<工具名> ```` 代码块，并以同一个坑为例前后连贯。`test/real-lesson-skill.test.js` 从 agent 读到的技能内容中取出这些调用，按顺序通过记忆工具执行，再用 basic-memory 的 `schema_validate` 校验写出的经验。修改示例时要保持它们可以照原样执行，且写出的经验没有告警。

## HTTP 接口

都需要 dsh 的浏览器登录凭据。失败时返回 `{ code, message, details? }`。

| 方法与路径 | 说明 |
|---|---|
| `GET /mdc-memory/status` | 运行状态：`state`（`preparing` / `ready` / `error`）、`stages`、`detail`（当前阶段最新输出）、`endpoint`（就绪时）、`error`（`stage`、`message`、`output`） |
| `POST /mdc-memory/retry` | 仅在 `error` 状态下从第一阶段重跑，否则返回 409 |
| `GET /mdc-memory/kbs` | `{ items: [{ name, path, enabled }], effective: [name] }` |
| `POST /mdc-memory/kbs/add` | 请求体 `{ name, path }`，返回 `{ item }` |
| `POST /mdc-memory/kbs/delete` | 请求体 `{ name }`，返回被删除的 `{ item }` |
| `POST /mdc-memory/kbs/set-enabled` | 请求体 `{ name, enabled }`，返回 `{ item }` |

知识库接口的错误码：

| 状态 | `code` | 含义 |
|---|---|---|
| 400 | `invalid-request` | 缺少名称或路径、`enabled` 不是布尔值等 |
| 400 | `path-not-absolute` | 路径不是完整的绝对路径（Windows 上 `\dir`、`C:dir` 也算相对路径） |
| 409 | `name-taken` | 已有同名知识库（不区分大小写），`details.knowledgeBase` 为已有名称 |
| 409 | `name-reserved` | 与内部默认项目同名 |
| 409 | `path-registered` | 与已登记知识库的目录相同或互相嵌套，`details.knowledgeBase` 为该知识库 |
| 409 | `path-reserved` | 与内部默认项目的目录相同或互相嵌套 |
| 404 | `not-found` | 没有该名称的知识库，`details.knowledgeBase` 为请求的名称 |
| 400 | `rejected` | basic-memory 拒绝（例如名称与已有知识库只差标点，permalink 冲突），`message` 带原因 |
| 503 | `unavailable` | basic-memory 尚未就绪 |
| 502 | `backend-error` | basic-memory 返回了其他错误 |

## 测试

```powershell
npm test
```

测试文件串行执行（`--test-concurrency=1`），因为各个真实进程测试共用同一个 `dataDir`。真实进程测试默认跳过，设置 `MDC_MEMORY_REAL_TEST=1` 后运行：

- `test/real-basic-memory.test.js`：用 submodule 源码和 dsh 自带的子进程服务把 basic-memory 拉到就绪再关闭。
- `test/real-knowledge-base.test.js`：在真实 basic-memory 和 dsh 自带的存储服务上验证知识库的列表、添加、校验、schema 生成、检索、开关、删除和重启后保持。
- `test/real-memory-tools.test.js`：在真实 basic-memory 前面挂上 dsh 自带的工具注册表与系统提示词服务，验证主 agent 与子 agent 看到的工具和提示词、白名单、`project` 补全与拒绝、开关即时生效，以及插件卸载后撤下。
- `test/real-lesson-skill.test.js`：通过 dsh 自带的技能注册表验证主 agent 能发现并读取 lesson 技能（且只有它）、子 agent 看不到、随最后一个知识库开关撤下和恢复；再按顺序执行技能中的示例调用（先检索、新建、再次检索后原地更新、取代、标记过时），用 basic-memory 的 `schema_validate` 确认经验没有告警，并检查 `supersedes` 关系已解析到旧经验。

假 ctx 带有一个 agent 平面（`test/support/agent-plane.js`）：测试通过它创建、销毁主 agent 和子 agent，并查看每个 agent 实际拿到的工具 schema、系统提示词、技能和工具调用结果。快速测试用内存实现，真实进程测试换成 dsh 自带的 `dsh-tools`、`dsh-system-prompt`、`dsh-skill` 与 `dsh-scope`。快速测试中的 basic-memory 由 `test/support/fake-subprocess.js` 模拟，`basicMemoryServer` 可以让它持有知识库并提供 MCP 工具列表。

可选环境变量见 `test/support/real-dsh.js` 文件头。
