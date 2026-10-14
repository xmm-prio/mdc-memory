# 以 fork 加 submodule 的方式引入 basic-memory

mdc-memory 的存储、索引与检索能力来自上游 basic-memory。我们没有把它当作 pip 依赖直接安装，也没有坚持零改动，而是在 `xmm-prio/basic-memory` 维护一个 fork，以 submodule 形式放在 `vendor/basic-memory`，跟踪 fork 的 `dsh` 分支并定期 rebase 上游。原因有两点。第一，中文关键词检索需要 jieba 分词，而上游只提供字符 n-gram，没有可插拔的分词扩展点。第二，Web UI 需要通过 HTTP 访问上游的 REST API，而上游只在进程内调用它。这两项都要改上游代码，fork 是代价最小的办法。

## Considered Options

- **直接依赖上游包、零改动**：最容易跟进上游，但做不到 jieba 分词，也无法对外提供 REST。
- **fork 加 submodule**（采纳）：能改源码，同时保留跟进上游的能力。

## Consequences

- fork 中的补丁只允许新增模块（jieba 分词策略、同时提供 MCP 与 REST 的启动命令），对上游已有文件只做让配置能够选择这些模块的最小改动，以降低 rebase 冲突。
- 上游采用 AGPL-3.0。本机自用不受影响，若对外分发 fork 则须开放源码。
