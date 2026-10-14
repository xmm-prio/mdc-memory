---
title: lesson
type: schema
entity: lesson
version: 1
schema:
  symptom(array): string, 现象：踩坑时可观察到的表现，通常是报错原文
  cause: string, 根因
  fix(array): string, 解决方法
  condition?(array): string, 适用条件
  relates_to?(array): Note, 相关的经验或参考笔记
  supersedes?(array): Lesson, 被本经验取代的旧经验
settings:
  validation: warn
  frontmatter:
    status(enum): [active, outdated]
    tags?(array): string
---

# lesson

经验笔记（`type: lesson`）的结构定义，由 mdc-memory 在添加知识库时生成。文件已存在时不会被覆盖，可以按需修改。

- 必填观察：`[symptom]` 现象（可多条，写报错原文）、`[cause]` 根因、`[fix]` 解决方法（可多条）
- 可选观察：`[condition]` 适用条件（可多条）
- 可选关系：`relates_to` 相关笔记、`supersedes` 被本经验取代的旧经验
- frontmatter：`status` 为 `active` 或 `outdated`，`tags` 可选
