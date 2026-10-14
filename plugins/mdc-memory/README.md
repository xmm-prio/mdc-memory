# @local/mdc-memory

dsh bundle：在本机托管一个 basic-memory 进程，为 agent 提供长期记忆，并在设置的 Memory 区域展示运行状态、管理知识库。安装、升级、卸载与开发模式见仓库根目录的 `README.md`。

## 结构

| 路径 | 作用 |
|---|---|
| `host/` | Host 插件行 `mdc-memory`（包入口 `@local/mdc-memory/host`） |
| `host/config.js` | 配置默认值与形状校验 |
| `host/runtime/` | 托管运行时：状态机、子进程组、隔离环境，以及 `stages/` 下的四个阶段（source、venv、model、server） |
| `host/basic-memory/` | basic-memory v2 REST API 的客户端（只在运行时就绪时可用） |
| `host/knowledge-base/` | 知识库：列表、添加、删除、使能、生效知识库计算、注册校验，以及经验 schema 笔记（`lesson-schema.md`） |
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

测试文件串行执行（`--test-concurrency=1`），因为两个真实进程测试共用同一个 `dataDir`。真实进程测试默认跳过，设置 `MDC_MEMORY_REAL_TEST=1` 后运行：

- `test/real-basic-memory.test.js`：用 submodule 源码和 dsh 自带的子进程服务把 basic-memory 拉到就绪再关闭。
- `test/real-knowledge-base.test.js`：在真实 basic-memory 和 dsh 自带的存储服务上验证知识库的列表、添加、校验、schema 生成、检索、开关、删除和重启后保持。

可选环境变量见 `test/support/real-dsh.js` 文件头。
