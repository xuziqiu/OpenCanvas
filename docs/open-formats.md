# OpenCanvas 开放格式

本文说明 OpenCanvas 1.0 使用的可移植数据。Markdown 是卡片正文的事实源；白板 JSON 只保存空间放置、Section、连线和视口，不复制正文。

## 知识库目录

```text
notes/                    Markdown 卡片
boards/*.board.json       白板 version 4
attachments/              原始附件
.opencanvas/desktop.json  根白板桌面布局
.opencanvas/organization.json  项目与文件夹信息
```

卡片可以被多个白板引用，也可以在同一白板出现多次。每个 `placement` 是一个独立空间实例；它用 `entityId` 指向卡片或嵌套白板实体。

## 白板 version 4

白板的核心字段如下：

```json
{
  "version": 4,
  "id": "board-id",
  "fileName": "研究.board.json",
  "title": "研究",
  "placements": [],
  "connectors": [],
  "attachments": [],
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

`placement.kind` 为 `card`、`board` 或 `text`。Section 也是放置实例，使用 `kind: "text"` 和 `isFrame: true`，其标题保存在 `text`。

## Section 多关系

Section 与普通组合是两套独立关系。对象可同时属于多个相交 Section；嵌套 Section 只有被另一个 Section 完整包含时才建立关系。

```json
{
  "id": "card-placement",
  "kind": "card",
  "entityId": "card-id",
  "x": 120,
  "y": 140,
  "width": 320,
  "height": 180,
  "color": "paper",
  "sectionId": "inner-section",
  "sectionIds": ["inner-section", "outer-section"]
}
```

- `sectionIds`：当前格式的完整有序关系，成员是同一白板内 Section 的 placement ID。
- `sectionId`：兼容旧版和第三方读取器的主关系，必须与 `sectionIds[0]` 一致。
- 读取时会去重，并把有效的 `sectionId` 放到数组首位；只有旧 `sectionId` 时会自动生成单元素 `sectionIds`。
- 写入多关系时应同时写两个字段；没有归属时省略二者，不写空字符串。
- 删除、复制或重建 placement ID 时，必须同步更新 `sectionId`、`sectionIds`、连线端点和附件关系。

Section 为内容自动扩边时，会额外保存用户最后一次手动确定的基准框：

```json
{
  "id": "outer-section",
  "kind": "text",
  "isFrame": true,
  "x": 60,
  "y": 60,
  "width": 720,
  "height": 480,
  "sectionBaseBounds": { "x": 80, "y": 80, "width": 680, "height": 440 }
}
```

`sectionBaseBounds` 只表示手动基准，不是第二个可见边框。内容压力消失后，Section 回到这个基准；当前几何与基准一致时应省略该字段。

## OpenCanvas ZIP

ZIP 的 `manifest.json` 使用 `format: "opencanvas"`、`version: 1`，并包含完整 Card 与 Board 清单；同一数据还以可直接读取的 Markdown 和 `.board.json` 文件放在 `notes/` 与 `boards/` 中。附件保留在 `attachments/`。

导入流程先预览 ID、路径和附件冲突，再在单个文件事务中提交。OpenCanvas ZIP 完整保留 `sectionId`、`sectionIds` 和 `sectionBaseBounds`；导入发生实体 ID 冲突时只重映射实体 ID，不改变白板内部 placement ID，因此 Section 关系保持有效。

## Obsidian Canvas

- Markdown placement 映射为 `file` node。
- 普通文字映射为 `text` node。
- Section 映射为 `group` node。
- 嵌套白板映射为带 `opencanvas-board://<id>` URL 的 `link` node。
- 连线保留端点、方向、标签和颜色；OpenCanvas 特有的关键点、曲线类型、虚线和精确粗细无法由标准 Canvas 完整表达。

Obsidian Canvas 没有显式的多 Section 字段。导入时 OpenCanvas 会按 group 几何重建关系：普通对象与每个相交 group 建立关系，group 之间只有完整包含才嵌套。因此重叠 group 中的卡片导入后可以同时拥有多个 `sectionIds`。

## Heptabase / Markdown ZIP

OpenCanvas 可预检并导入 Heptabase 的 Markdown 导出 ZIP，也兼容普通的 Markdown 目录 ZIP：

- 保留 Markdown 目录层级，并从 frontmatter、首个一级标题或文件名确定卡片标题。
- 相对附件链接会改写到开放的 `attachments/` 目录；同名附件在确认提交时安全改名。
- 预检只读展示卡片、附件、路径冲突和损失边界；取消不会修改知识库。
- 确认后使用与 OpenCanvas ZIP 相同的导入事务，任何写入失败都会回滚本次新增文件。

Heptabase 的 Markdown 导出不包含白板坐标、Section、连线或嵌套白板关系，因此不能据此重建空间布局。专有完整备份可能随 Heptabase 数据库版本变化，OpenCanvas 不会把它当作稳定开放格式直接写入。

## 兼容与恢复

- 当前读取器接受 v1、v3 和 v4，并在内存中迁移；只有真实修改后才写回 v4。
- 缺失实体、断裂连线和无法解析的文件不会被静默删除，而是进入恢复与完整性界面。
- 文件路径必须保持在知识库目录内，并遵守 Windows 路径片段、设备保留名和大小写不敏感重名规则。
- 导入前建议保留原 ZIP 或知识库副本；事务失败会回滚本次新建文件，但不会替用户删除原始来源。
