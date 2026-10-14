# 以 fork 加 submodule 的方式引入 basic-memory

mdc-memory 的存储、索引与检索能力来自上游 basic-memory。我们没有把它当作 pip 依赖直接安装，也没有坚持零改动，而是在 `xmm-prio/basic-memory` 维护一个 fork，以 submodule 形式放在 `vendor/basic-memory`，跟踪 fork 的 `dsh` 分支并定期 rebase 上游。原因有两点。第一，中文关键词检索需要 jieba 分词，而上游只提供字符 n-gram，没有可插拔的分词扩展点。第二，Web UI 需要通过 HTTP 访问上游的 REST API，而上游只在进程内调用它。这两项都要改上游代码，fork 是代价最小的办法。

## Considered Options

- **直接依赖上游包、零改动**：最容易跟进上游，但做不到 jieba 分词，也无法对外提供 REST。
- **fork 加 submodule**（采纳）：能改源码，同时保留跟进上游的能力。

## Consequences

- fork 中的补丁以新增模块为主（`script_segmentation/` 下的 jieba 分词策略、`serve/` 与 `cli/commands/serve.py` 中同时提供 MCP 与 REST 的启动命令），对上游已有文件只做接入这些模块所必需的最小改动，以降低 rebase 冲突：
  - `config_models.py`：分词策略与 jieba 用户词典两个配置字段；`db.py`：打开数据库时调用一次分词策略的启动步骤；`cli/main.py`：注册 `serve` 命令；`pyproject.toml`、`uv.lock`：jieba 依赖。
  - `repository/script_ngrams.py`：上游函数保持原名和原实现，只在 `build_script_ngrams`、`analyze_script_query` 中各加一处分派，并在文件末尾增加可安装策略的接缝（`ScriptSegmentation` 协议与 `install_script_segmentation`）；`ScriptQuery` 增加 `relaxed_phrases` 字段，默认为空。
  - `repository/sqlite_search_query.py`：零结果时的宽松重试读取 `relaxed_phrases`。字段为空时与上游行为一致，只有 jieba 策略会给出它：整句查询中多字词任一命中即可，让自然语言句子也能产生关键词命中。
- 依赖方向是单向的：`script_segmentation` 依赖 `repository.script_ngrams`，后者不导入 fork 的任何模块。
- 分词策略是进程级状态，这是有意保留的取舍。上游所有搜索后端都通过 `script_ngrams` 的模块级函数生成索引文本、分析查询，而不是持有一个注入的依赖。要改成构造注入，至少要改动 SQLite 与 Postgres 的搜索仓库、FTS 查询、已接受笔记的索引行构造及其工厂等七个以上的上游文件，以及大量直接构造这些对象的测试，违背上面的最小改动原则。所以策略由 `run_migrations`（每个入口打开数据库的必经步骤）在建立索引、执行检索之前安装一次。代价是同一进程只能使用一种策略，测试切换策略后要恢复默认。
- 上游采用 AGPL-3.0。本机自用不受影响，若对外分发 fork 则须开放源码。
