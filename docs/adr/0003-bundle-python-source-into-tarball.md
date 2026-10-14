# 把 basic-memory 的 Python 源码打包进 bundle 的 tarball

dsh 通过 pnpm 安装 bundle，而 pnpm 不会拉取 git submodule，所以 `vendor/basic-memory` 无法随 bundle 一起安装。我们的做法是用打包脚本把 submodule 的源码复制进 bundle 的 `python/` 目录，再用 `npm pack` 生成 tarball 安装。Host 插件基于包内源码，用 uv 建立虚拟环境。这样安装产物自包含，版本与 submodule 严格对应，不依赖仓库检出的位置，运行时也不需要访问 GitHub。开发时用 `pythonSource` 配置项把源码路径指向 submodule，打包后的安装和开发调试共用同一条代码路径。

## Considered Options

- **从仓库路径安装，按相对路径找 submodule**：最简单，但必须保留仓库检出目录，而且只能用本地路径安装。
- **运行时用 uv 从 fork 的 git 地址加固定 commit 安装**：bundle 很轻，但运行时依赖 GitHub，固定 commit 也要在构建时另外同步。
- **打包进 tarball**（采纳）：多一步打包，换来可复现、自包含的安装产物。
