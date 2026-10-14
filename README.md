# mdc-memory

为 DeepSeek Harness（dsh）提供长期记忆的插件：把工作中踩坑得来的经验沉淀为 Markdown 笔记，并在之后的会话中召回给 agent。存储与检索由本机托管的 [basic-memory](https://github.com/basicmachines-co/basic-memory)（fork 版）提供。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `plugins/mdc-memory/` | dsh bundle `@local/mdc-memory`（Host 插件与 Web UI），说明见其 `README.md` |
| `vendor/basic-memory/` | basic-memory fork 的 submodule（`xmm-prio/basic-memory` 的 `dsh` 分支） |
| `tools/pack/` | 打包脚本：把 submodule 源码放进 bundle 并生成 tarball |
| `docs/adr/` | 架构决策记录 |
| `GLOSSARY.md` | 术语表 |

## 前置条件

- 已安装 dsh，并使用 Web profile（`dsh web`）。
- Node.js 与 npm（打包脚本只依赖 Node 自带模块）。
- git。
- Python 3.12，且已安装 uv（`python -m pip install uv`，插件通过 `python -m uv` 调用）。
- 首次启动需要联网：uv 从 PyPI 下载依赖，embedding 模型 `BAAI/bge-small-zh-v1.5` 从 Hugging Face 下载。走系统代理时，在启动 dsh 的环境中设置好 `HTTPS_PROXY` / `HTTP_PROXY`。

## 安装

1. 连同 submodule 一起克隆仓库：

   ```powershell
   git clone --recursive https://github.com/xmm-prio/mdc-memory.git
   cd mdc-memory
   ```

   如果克隆时漏了 `--recursive`，补一条 `git submodule update --init vendor/basic-memory`。

2. 打包：

   ```powershell
   node tools/pack/index.js
   ```

   脚本把 basic-memory 的构建所需文件（`pyproject.toml`、`uv.lock`、`src/` 等，不含测试、文档和缓存）复制进 bundle 的 `python/` 目录，用 `npm pack` 生成 tarball，再删除复制出的中间目录。tarball 默认写到 `dist/local-mdc-memory-<版本>.tgz`（`dist/` 不进 git），`--out <目录>` 可以改到别处。脚本最后会打印 tarball 的绝对路径和安装命令。

3. 安装到 dsh（路径必须是绝对路径）：

   ```powershell
   dsh plugin --profile web add C:\path\to\mdc-memory\dist\local-mdc-memory-0.1.0.tgz
   ```

4. 重启 dsh（关掉正在运行的 `dsh web` 再重新启动）。

5. 打开 dsh 设置中的 Memory 区域查看进度。首次启动会依次校验源码、在 `~/.dsh/memory/venv` 建立 Python 虚拟环境、下载 embedding 模型、启动 basic-memory，全部完成后状态变为“就绪”。任一步失败时 dsh 照常可用，Memory 区域显示错误输出和“重试”按钮。

安装产物是自包含的：tarball 里带着 basic-memory 源码，虚拟环境里装的是源码的副本，装好之后不再依赖仓库检出目录。

## 升级

1. 更新代码和 submodule：

   ```powershell
   git pull
   git submodule update --init vendor/basic-memory
   ```

2. 重新打包：`node tools/pack/index.js`。
3. 再次安装：`dsh plugin --profile web add <tarball 绝对路径>`。即使版本号没变、tarball 路径也和上次相同，重新 add 也会替换已安装的副本（已在 dsh 0.2.0-rc.2 上验证），不需要先卸载。
4. 重启 dsh。

插件每次启动都会对 bundle 内 basic-memory 的构建输入计算内容哈希，并与虚拟环境记录的哈希比较。源码有变化时，“准备 Python 环境”一步会自动重建虚拟环境中的 basic-memory；没有变化则直接复用。知识库、配置和索引都不受升级影响。

在更早的 dsh 版本上，如果重启后仍在运行旧代码，可以先执行下面的卸载命令再 add。

## 卸载

```powershell
dsh plugin --profile web remove @local/mdc-memory
```

然后重启 dsh。卸载不会删除任何数据：

- dsh 数据目录下的 `memory` 目录（默认 `~/.dsh/memory`，设置了 `DSH_HOME` 时为 `$DSH_HOME/memory`），其中有 basic-memory 的配置与索引、虚拟环境和模型缓存；
- 所有知识库目录及其中的 Markdown 笔记。

重新安装后，这些数据会被直接沿用。要彻底清理，需要手动删除上面的 `memory` 目录，以及不再需要的知识库目录。如果按下文的开发模式在 profile 的 `cordis.patch.yml` 中加过 `mdc-memory` 的配置，也一并删掉。

## 开发模式

开发 basic-memory fork 时，不必每次修改都重新打包：在 profile 的 patch（默认 `~/.dsh/profiles/web/cordis.patch.yml`）中用 `pythonSource` 把源码目录指向 submodule：

```yaml
- id: mdc-memory
  config:
    pythonSource: C:\path\to\mdc-memory\vendor\basic-memory
```

重启 dsh 后，插件从 submodule 建立虚拟环境。之后每次启动都会对 submodule 的构建输入（`pyproject.toml`、`uv.lock`、`src/` 等，与打包进 tarball 的文件相同）计算内容哈希，改了这些文件或切换了提交，下次启动时就会自动重建虚拟环境中的 basic-memory；只改测试、文档，或 `.venv`、`__pycache__` 之类的工具目录变化，不会触发重建。

说明：

- 所有配置项的默认值都在插件代码中（bundle 的 patch 不带配置），patch 中没写的字段（如 `dataDir`）使用默认值，所以只写 `pythonSource` 即可。
- 开发 Host 或 Web UI 的 JS 代码时，可以直接安装 bundle 目录：`dsh plugin --profile web add C:\path\to\mdc-memory\plugins\mdc-memory`。这种安装方式没有打包的 `python/` 目录，必须同时配置上面的 `pythonSource`。修改 JS 后需要重启 dsh 才会加载。
- 回到正常安装时，删除 patch 中的这段配置，按“安装”一节打包并 add。

## 测试

```powershell
npm test
```

在仓库根目录运行打包脚本与 bundle 的全部测试（Node 自带的测试运行器，无需 `npm install`）。真实 basic-memory 进程的测试默认跳过，用法见 `plugins/mdc-memory/README.md`。
