# @local/mdc-memory

dsh bundle：在本机托管一个 basic-memory 进程，为 agent 提供长期记忆。安装、升级、卸载与开发模式见仓库根目录的 `README.md`。

## 结构

| 路径 | 作用 |
|---|---|
| `host/` | Host 插件行 `mdc-memory`（包入口 `@local/mdc-memory/host`） |
| `host/config.js` | 配置默认值与形状校验 |
| `host/runtime/` | 托管运行时：状态机、子进程组、隔离环境，以及 `stages/` 下的四个阶段（source、venv、model、server） |
| `host/http/` | 通用 JSON 路由注册（鉴权、请求体、错误映射）和运行时接口 |
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

## HTTP 接口

都需要 dsh 的浏览器登录凭据。

| 方法与路径 | 说明 |
|---|---|
| `GET /mdc-memory/status` | 运行状态：`state`（`preparing` / `ready` / `error`）、`stages`、`detail`（当前阶段最新输出）、`endpoint`（就绪时）、`error`（`stage`、`message`、`output`） |
| `POST /mdc-memory/retry` | 仅在 `error` 状态下从第一阶段重跑，否则返回 409 |

## 测试

```powershell
npm test
```

真实进程测试默认跳过。设置 `MDC_MEMORY_REAL_TEST=1` 后，会用 submodule 源码和 dsh 自带的子进程服务把 basic-memory 拉到就绪再关闭。可选环境变量见 `test/real-basic-memory.test.js` 文件头。
