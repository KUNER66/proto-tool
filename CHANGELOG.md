# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 变更
- **主仓库迁到 Gitee**：`https://gitee.com/SKSKCODE/nami`，GitHub 地址保留为镜像。
  README 中英双版、`package.json`、`CONTRIBUTING.md`、CHANGELOG 里的链接已同步更新；
  GitHub Actions 的 CI 徽章换成 Gitee 星标徽章（Gitee 不提供流水线徽章）。
- **新增 Gitee Go 流水线** `.workflow/ci.yml`。GitHub Actions 与 Gitee Go 的差异：
  触发写在 `triggers.push.branches.precise`（不是 `on.push.branches`）；
  没有 `strategy.matrix` / `runs-on`，Node 版本矩阵只能展开成多个 `stage`；
  `nodeVersion` 必须写具体版本号，不支持 `18` 这类大版本简写。
- 桌面端 bundle identifier 由 `io.github.kuner66.proto-tool` 改为 `com.skskcode.proto-tool`。

### 计划中
- 备注导出为 Markdown / 需求文档格式
- 多文件原型支持
- macOS / Linux 桌面产物

---

## [0.2.0] - 2026-10-16

Tauri 桌面客户端。

### 新增
- **桌面客户端（Tauri 2）**：单个安装包，免装 Node。Windows 实测 NSIS 1.2 MB、
  MSI 1.6 MB、主程序 3.07 MB。产物在 `src-tauri/target/release/bundle/`。
- **Rust 侧文件指令**：`list_roots` / `list_dir` / `read_text_file` /
  `write_text_file`（原子写）/ `stat_file` / `read_runtime`。
- **前端双层宿主适配**：`src/index.html` 新增 `host` 层——HTTP 模式走 `fetch('/api/*')`，
  桌面模式走 Tauri `invoke`，两者对外暴露完全相同的数据形状，业务代码零改动。

### 变更
- **目录结构**：前端资源收进 `src/`（含 `lib/injector.js`），Node 服务独立为 `server/index.js`。
  起因是 Tauri 打包会把 `frontendDist` 指向的目录整体嵌入二进制，其中不能混入非前端文件。
- **`src/lib/injector.js` 改为 UMD**：Node 走 `require()`，浏览器 / WebView 挂
  `AN_INJECTOR` 全局；用 IIFE 包裹避免内部辅助函数泄漏到全局作用域。
- `package.json` 版本升到 0.2.0，新增 `desktop` / `desktop:build` / `tauri` 脚本。

### 设计说明
Rust 侧**只做文件 IO**；剥离旧标记、构造数据块、插入运行时全部交给
`src/lib/injector.js`，桌面端与 Node 服务端共用同一份实现。两处各写一份必然漂移，
最后会出现「同一个文件用不同方式打开、存出来的结果不一样」。

### 已知限制
- 仓库只配置了 Windows 的 `nsis` / `msi` 产物。macOS / Linux 需各自的原生依赖
  （Xcode CLT / webkit2gtk），并在 `tauri.conf.json` 的 `bundle.targets` 里放开对应格式。

## [0.1.0] - 2026-10-15

首个开源版本。

### 新增
- **注入核心 `lib/injector.js`**：纯函数模块，负责剥离 / 构造 / 读写注入内容，
  不依赖任何运行环境，供本地服务、桌面端、CLI 与测试共用。
- **本地服务 `src/server.js`**：静态资源、页面内文件浏览器、幂等写盘、清除备注。
- **运行时 `src/runtime/annotator.js`**：烧进目标 HTML，接收方双击即渲染便利贴。
  支持编辑模式与只读展示模式自动判定。
- **工具界面 `src/index.html`**：顶栏操作 + iframe 预览 + 文件浏览器。
- **两类备注**：正式说明（黄）/ 内部待办（紫）。编辑时待办折叠，展示时全放。
- **元素锚定**：备注记住所覆盖的元素与相对偏移，页面切换 / 缩放时自动重算；
  锚点消失则隐藏，回来则复原。
- **精确拖动**：基于 `PointerEvent`，1:1 跟手。
- **幂等注入**：反复保存只保留一份数据与一份运行时，体积稳定。
- **凭证隔离**：编辑凭证只在渲染给工具的副本里存在，落盘自动排除。
- **跨平台启动器**：`start.bat`（CRLF + GBK）/ `start.sh`，端口可用 `PORT` 环境变量覆盖。
- **命令行参数**：`--port` / `--open` / `--help` / `--version`，版本号从 `package.json` 单一来源读取。
- **测试**：注入逻辑单元测试 26 项、本地服务端到端测试 27 项、真机浏览器冒烟 13 项。

### 修复
- 修复剥离注入段时，文件里存在多段标记会吞掉中间正常内容的问题
  （改为按 `script id` 结构性定位，不依赖标记文本）。
- 修复运行时源码含标记字面量导致段边界算错、标记剥离不净的问题。
- 修复剥离时误压缩用户原型正常空行的问题（现在保证逐字节还原）。
- 修复新建空备注在失焦后被静默删除的问题，允许「先摆位置、后填字」。
- 修复编辑结束后便利贴操作按钮内联样式未复位的问题。

[未发布]: https://gitee.com/SKSKCODE/nami/compare/v0.1.0...HEAD
[0.1.0]: https://gitee.com/SKSKCODE/nami/releases
