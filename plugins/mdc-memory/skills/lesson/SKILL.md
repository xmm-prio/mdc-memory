---
name: lesson
description: "把踩坑沉淀为一条经验（type: lesson）：何时值得沉淀、经验格式、先检索已有经验再新建或更新、用 supersedes 取代旧经验、标记 status: outdated。解决了一个非显然的问题，或用户要求“记下来”时，先读取本技能，再用 memory_* 记忆工具写入。"
---

# 沉淀经验

经验（`type: lesson`）是一篇记录一次踩坑的笔记：现象、根因、解决方法和适用条件。之后的会话里，用户发消息时会自动召回相关的经验，帮助在动手之前避开同一个坑。本技能说明如何用记忆工具 `memory_search_notes`、`memory_read_note`、`memory_write_note`、`memory_edit_note` 写好一条经验。下文的工具调用以同一个坑为例，照着替换内容即可。

## 何时沉淀

值得沉淀：

- 解决了一个非显然的问题：报错没有直接说明原因、排查花了不少工夫，或解决方法违反直觉，例如环境差异、工具的怪异行为、版本不兼容、配置陷阱。
- 用户明确要求“记下来”“记住这个”。这时直接沉淀，不必再判断是否值得。

不要沉淀：

- 一眼就能看出的错误（拼写错误、漏写参数），以及只对当前任务有效的临时状态。
- 还没有验证过的猜测：确认解决方法真的有效之后再写。
- 密码、token、密钥等敏感信息：写入前替换为占位符。

沉淀只在上面两种情况下发生，不需要在每个回合结束时检查。一条经验只记一个坑。

## 选择知识库

记忆提示词列出了生效知识库。只有一个时，调用记忆工具不传 `project`；有多个时，每次调用都传 `project`：写入用户指定的知识库，用户没有指定时选与这个坑最相关的一个，检索、读取和编辑都用同一个。

## 经验格式

| 部分 | 写法 |
|---|---|
| `title` | 一句话概括这个坑，例如“uv sync 把虚拟环境重建成 Python 3.14”。标题是这条经验的标识，读取、编辑和取代都靠它，所以要具体、能和其他经验区分开，并且不含 `/`、`[`、`]`。 |
| `note_type` | 固定为 `"lesson"`。 |
| `directory` | 固定为 `"lessons"`。 |
| `tags` | 2 到 5 个小写关键词：工具、语言、平台、组件，例如 `["uv", "python"]`。 |
| `metadata` | `{"status": "active"}`。 |
| `content` | 正文，只写下面的观察和关系，每行一条。 |

观察的写法是 `- [类别] 内容`：

- `[symptom]` 现象，必填，可多条：踩坑时能观察到的表现，优先写报错原文。召回主要靠现象匹配，所以照抄报错里最有区分度的那一行，不要改写或翻译；多行报错拆成多条。
- `[cause]` 根因，必填，写一条：为什么会出现这个现象。
- `[fix]` 解决方法，必填，可多条：能直接照做的命令、配置或代码改动。
- `[condition]` 适用条件，可选，可多条：在什么环境、版本、平台下成立。

报错原文、命令和路径都用反引号包起来。一行观察以 `)` 结尾时，最后一对括号里的文字会被当成备注从观察里拆出去，包上反引号才能保留原文。

关系是可选的，写法是 `- 关系 [[笔记标题]]`：

- `- supersedes [[旧经验的标题]]`：这条经验取代了旧经验，见“取代旧经验”。
- `- relates_to [[笔记标题]]`：相关的经验或参考笔记。

正文里不要写别的类别、关系或 `[[...]]` 链接。

## 先检索，再新建或更新

写入之前，先检索有没有记录同一个坑的经验：

```json memory_search_notes
{"query": "uv sync CPython 3.14", "note_types": ["lesson"]}
```

- `query` 用报错原文里最有区分度的词；没有结果时换一种说法（中文、英文、关键词）再检索一次。
- 一定带上 `"note_types": ["lesson"]`，只看经验。

结果里每条的 `###` 后面是已有经验的标题。读取最相关的一条，判断它记录的是不是同一个坑：

```json memory_read_note
{"identifier": "uv sync 把虚拟环境重建成 Python 3.14"}
```

- 没有同一个坑的经验：新建，见“新建经验”。
- 已有同一个坑的经验，而且它仍然成立：在它上面更新，见“更新已有经验”，不要再写一条重复的经验。
- 已有经验的结论被证明是错的，或者已经有了更好的做法、需要整体改写：写一条新经验取代它，见“取代旧经验”。

## 新建经验

```json memory_write_note
{
  "title": "uv sync 把虚拟环境重建成 Python 3.14",
  "directory": "lessons",
  "note_type": "lesson",
  "tags": ["uv", "python"],
  "metadata": {"status": "active"},
  "content": "- [symptom] `uv sync` 输出 `Using CPython 3.14.0` 后删除并重建了 `.venv`\n- [cause] 仓库根目录的 `.python-version` 写的是 3.14，uv 没有收到 `--python` 时按它选择解释器\n- [fix] 每条 uv 命令都加上 `--python 3.12`，例如 `python -m uv sync --python 3.12`\n- [condition] 仓库根目录有 `.python-version`，且其中的版本与项目要求不符\n"
}
```

- 写入报错说笔记已存在：同名的经验已经有了，读取它，按“更新已有经验”处理，不要用 `overwrite` 覆盖。
- 写入结果列出了相似的已有笔记，其中有记录同一个坑的经验：把那条经验里仍然有用的现象和解决方法补进刚写的经验，再给刚写的经验追加 `- supersedes [[那条经验的标题]]`。

写完后用一句话告诉用户记下了哪条经验、写在哪个知识库。

## 更新已有经验

用 `memory_edit_note` 修改原经验，`identifier` 填它的标题，与检索结果完全一致。补充新的现象、解决方法或适用条件时，用 `append` 追加观察：

```json memory_edit_note
{"identifier": "uv sync 把虚拟环境重建成 Python 3.14", "operation": "append", "content": "- [fix] 或者设置环境变量 `UV_PYTHON=3.12`，之后所有 uv 命令都会使用它\n"}
```

- 修正写错的一行：`"operation": "find_replace"`，`find_text` 填原来那一整行，`content` 填改好的一行。
- 更新标签：加上 `"metadata": {"tags": [...]}`，给出完整的新标签列表。

标识不存在时 `append` 会新建一篇笔记，所以编辑之前先用 `memory_read_note` 确认能读到这条经验。

## 取代旧经验

旧经验的结论错了，或者有了更好的做法、需要整体改写时，写一条新经验，在正文末尾加上指向旧经验的 `supersedes` 关系，`[[...]]` 里写旧经验的完整标题。用户要求“用新经验取代旧经验”时也这样做：

```json memory_write_note
{
  "title": "uv 按 .python-version 选择解释器，用 UV_PYTHON 固定版本",
  "directory": "lessons",
  "note_type": "lesson",
  "tags": ["uv", "python"],
  "metadata": {"status": "active"},
  "content": "- [symptom] `uv sync` 或 `uv run` 输出 `Using CPython 3.14.0` 后重建了 `.venv`\n- [cause] 没有 `--python` 也没有 `UV_PYTHON` 时，uv 按从项目目录向上找到的第一个 `.python-version` 选择解释器\n- [fix] 在环境中设置 `UV_PYTHON=3.12`，所有 uv 命令都会使用 Python 3.12\n- [condition] 项目目录或它的上级目录有 `.python-version`，且版本与项目要求不符\n- supersedes [[uv sync 把虚拟环境重建成 Python 3.14]]\n"
}
```

被取代的旧经验不用修改：它会被当作过时经验，不再被自动召回，但仍然能检索到。

## 标记过时

经验已经不再成立、又没有新经验取代它时（例如升级工具后这个坑不再出现），把它的 `status` 改为 `outdated`。`content` 为空的 `append` 不会改动正文：

```json memory_edit_note
{"identifier": "uv sync 把虚拟环境重建成 Python 3.14", "operation": "append", "content": "", "metadata": {"status": "outdated"}}
```

过时经验不再被自动召回，但仍然能检索到。它重新成立时，用同样的调用把 `status` 改回 `active`。

## 经验与参考笔记

用户放进知识库的参考资料是参考笔记（`type: note`），可以检索，但不会被自动召回。参考笔记不是经验：不要把它改写成经验，也不要给它加经验的观察。用户要保存的是资料而不是踩坑时，用 `memory_write_note` 写一篇 `"note_type": "note"` 的笔记，不套用经验格式。经验要引用参考笔记时，写 `- relates_to [[参考笔记的标题]]`。
