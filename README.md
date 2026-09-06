# OpenCanvas

OpenCanvas 是一个本地优先、开放文件格式的可视化知识库。它结合了 Markdown 卡片的可迁移性、结构化块编辑和事务化无限白板，并支持把白板嵌套进另一个白板。

当前核心交付版本为 **1.0.10**。开发时使用热更新，日常手动测试无需重复安装；安装包只用于正式部署。

## 已实现

- 无限白板：平移、缩放、对象拖动和尺寸调整；一次手势对应一次撤销
- Markdown 卡片：ProseMirror/Tiptap 结构化编辑，支持 `/` 命令和 `@` 卡片引用
- 实体与放置分离：同一卡片可在多个白板位置同步出现
- 可视化连线：连接卡片、文字和嵌套白板
- 嵌套白板：创建、预览并双击进入下一层
- 开放存储：笔记保存为 `.md`，白板保存为 `.board.json`
- 本地知识库：可选择任意文件夹，并从应用中直接打开
- 浏览器降级：非 Electron 环境下使用浏览器本地存储
- 标签、反向链接和卡片放置位置索引
- 轻量只读 Markdown 预览：只有正在编辑的卡片才加载完整 Tiptap 编辑器
- 大白板视口裁剪和空间索引：5000 节点桌面实测首屏只挂载约 20 个可见节点
- 原子保存、异常写入恢复、版本历史与知识库完整性检查
- 普通移动、删除、重命名和项目整理使用磁盘事务日志；崩溃后启动时自动回滚
- 白板撤销历史使用节点/连线差量，避免大白板为每次操作复制整张数据
- 全局错误边界、统一操作通知和可见的恢复结果
- Heptabase Markdown ZIP / OpenCanvas ZIP / Obsidian Canvas 导入预览、冲突重命名与整笔事务回滚
- 深色高密度工作区、搜索、复制粘贴和快捷键
- 亮色/深色主题、快捷键帮助、菜单键盘导航与降低动画支持
- 文件目录与白板组织相互独立；白板可按需“整理为项目”，跨项目引用不复制正文
- 右侧实时卡片栏、整页卡片过渡、块拖动、源码模式、表格与附件工具
- 连线四向/自动端点、重连、关键点、在线标签、三种线型、颜色、粗细和箭头方向
- 一次性三步首次引导、应用内完整手册、“关于与诊断”和脱敏反馈摘要
- GitHub 提交与合并请求自动运行全量构建和隔离 Electron 回归

第一次使用请从 [`docs/quick-start.md`](docs/quick-start.md) 开始；完整操作、数据安全和故障排查见 [`docs/user-guide.md`](docs/user-guide.md)，快捷键见 [`docs/shortcuts.md`](docs/shortcuts.md)。开放 Markdown、白板 JSON、Section 多关系与 ZIP / Obsidian Canvas 映射见 [`docs/open-formats.md`](docs/open-formats.md)；程序内核设计见 [`docs/architecture-v2.md`](docs/architecture-v2.md)；交付完整度和其他设计、验证与版本资料见 [`docs/README.md`](docs/README.md)。

## 开发

环境要求：Node.js 20 或更高版本、npm 10 或更高版本，以及 Windows 10/11（桌面端构建与完整 Electron 回归）。

```powershell
npm install
npm run dev
```

只运行浏览器版本：

```powershell
npm run dev:web
```

检查并构建：

```powershell
npm run build
```

独立桌面端完整回归（使用随机严格端口，不复用可能过期的开发服务器）：

```powershell
npm run test:electron
```

生成 Windows 安装程序：

```powershell
npm run dist
```

只刷新免安装桌面版（不会生成安装程序）：

```powershell
npm run pack
```

验证免安装目录确实使用打包后的 `file://` 生产文件、且不会碰现有知识库：

```powershell
npm run test:portable
```

## 文件结构

一个知识库目录包含：

```text
notes/          Markdown 笔记
boards/         白板 JSON
attachments/    附件目录
.opencanvas/    OpenCanvas 元数据
```

Markdown 文件的 frontmatter 保存稳定 ID、创建时间和更新时间；白板 JSON 保存 `placements`、`connectors` 和视口。v1 的 `nodes/edges` 会在读取时无损迁移。应用不会把卡片正文锁进专有数据库。

## 常用操作

- 双击画布空白处：创建卡片
- 单击卡片：在白板原位编辑；从卡片顶部工具条拖动
- 卡片四边与四角：连续调整宽度和高度，并参与对齐吸附
- 卡片顶部的展开按钮：在同一标签中切换到整页卡片视图
- 框选或 `Ctrl + A`：选择多个对象并一起拖动
- 左侧工具条：创建卡片、文字或嵌套白板
- 从左侧卡片库把已有卡片拖到当前白板
- 滚轮：以光标为中心缩放画布；仅当选中的卡片正文确实可滚动时滚动卡片内容
- 空格拖动或平移工具：平移画布
- `C`：切换到连线工具，然后依次点击两个对象；也可从卡片右上角菱形连接柄拖向目标
- `V`：选择工具
- `H`：平移工具
- `Delete` / `Backspace`：移除当前白板中的选中对象或连线
- 双击嵌套白板：进入该白板

日常测试不需要重新安装。直接双击项目根目录的 `启动 OpenCanvas 开发版.cmd`，代码修改后会自动刷新；安装包仅用于正式发布。

## 当前边界

当前版本聚焦单机、个人知识管理的核心闭环；尚未加入云同步、多人协作、移动端、PDF 标注和插件 API。Heptabase 的 Markdown 导出可以迁移笔记、目录与附件，但该格式本身不含白板坐标、Section、连线和嵌套白板；完整空间数据请使用 OpenCanvas ZIP。所有文件均保持可直接读取，后续功能可以在不迁移现有内容的基础上继续扩展。

## 开源许可证

OpenCanvas 采用 [GNU General Public License v3.0](LICENSE)，SPDX 标识为 `GPL-3.0-only`。你可以免费使用、研究、修改和重新分发本项目；分发修改版时需要遵守 GPL-3.0 的源代码与同许可证要求。

Windows 安装包目前没有付费代码签名，首次下载时可能出现“未知发布者”或 SmartScreen 提示。请从本仓库的 Release 下载，并使用发布页提供的 SHA-256 校验文件完整性。

## 第三方组件

OpenCanvas 使用 React、Electron、Tiptap、Lucide 等开源组件。完整的锁定运行时清单、版权声明和许可证正文见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)；随应用分发的 Inter 字体原始许可证也保存在 [`src/assets/fonts/inter/LICENSE.txt`](src/assets/fonts/inter/LICENSE.txt)。构建流程会校验清单没有落后于 `package-lock.json`，并把 OpenCanvas 与第三方许可证一起放入安装目录。

OpenCanvas 的部分产品理念与交互思路受到 Heptabase 和 Obsidian 的启发；本项目为独立开发项目，与二者均无官方关联。
