# 备注数据格式（SCHEMA）

本文档描述 html-note 写进 HTML 文件的数据结构。
**如果你要写工具去读写这些备注，看这一份就够了。**

---

## 数据在 HTML 里的位置

注入内容放在 `</body>` 之前，由两段注释标记包裹：

```html
<!-- AN:NOTES:BEGIN --><script id="an-data" type="application/json">{
  "version": 1,
  "updatedAt": "2026-10-15T13:30:27.520Z",
  "notes": [ /* ... */ ]
}</script><!-- AN:NOTES:END --><!-- AN:RUNTIME:BEGIN --><script id="an-runtime">/* runtime */</script><!-- AN:RUNTIME:END -->
```

| 标记 | 含义 |
|---|---|
| `<!-- AN:NOTES:BEGIN -->` … `<!-- AN:NOTES:END -->` | 备注数据块 |
| `<!-- AN:RUNTIME:BEGIN -->` … `<!-- AN:RUNTIME:END -->` | 渲染运行时代码 |

**定位建议：不要靠标记文本。** 运行时脚本源码里含有这些标记的字符串常量，
用文本匹配容易命中源码内部、把段边界算错。
**请用结构性锚点**：

- 数据块 → `<script id="an-data" type="application/json">…</script>`
- 运行时 → `<script id="an-runtime">…</script>`

---

## 顶层结构

```jsonc
{
  "version": 1,               // number  数据格式版本，见下文「版本演进」
  "updatedAt": "ISO-8601",    // string  最后一次写入时间（UTC）
  "notes": [ /* Note[] */ ]   // array   备注列表，可为空数组
}
```

---

## Note 对象

```jsonc
{
  // ---- 身份 ----
  "id": "n1abc2def3",         // string  唯一标识，客户端生成
  "kind": "spec",             // string  "spec" | "todo"

  // ---- 内容 ----
  "text": "折返时间待确认",     // string  备注正文，允许空字符串
  "done": false,              // boolean 仅 todo 有意义：是否已完成

  // ---- 位置（绝对坐标，兜底用） ----
  "x": 559,                   // number  相对文档左上角的像素坐标
  "y": 428,

  // ---- 位置（锚定，主用） ----
  "anchor": "a1",             // string|null  锚点元素的 data-an-anchor 值
  "ax": 30,                   // number  相对锚点元素左上角的横向偏移
  "ay": 16,                   // number  相对锚点元素左上角的纵向偏移
  "aw": 800,                  // number  记录锚点当时的宽度（用于比例缩放）
  "ah": 120,                  // number  记录锚点当时的高度

  // ---- 样式与时间 ----
  "color": "#FAC775",         // string|null  自定义底色，null 表示用 kind 默认色
  "createdAt": 1792068989158, // number  创建时间（毫秒时间戳）
  "updatedAt": 1792068989158  // number  最后修改时间（毫秒时间戳）
}
```

### 字段详解

#### `kind`

| 值 | 界面名称 | 默认色 | 用途 |
|---|---|---|---|
| `spec` | 正式说明 | `#FAC775` 黄 | 给评审人看的正式批注 |
| `todo` | 内部待办 | `#AFA9EC` 紫 | 自己内部的待办事项 |

编辑时 `todo` 默认折叠，**展示（接收方双击）时全部可见**。

#### `text`

- 允许为空字符串。**空内容的备注是合法的**：用户可能先摆位置、后填字。
- 只有「原有备注被清空」才视为删除，由客户端决定，不是格式层面的约束。

#### 位置：`x` / `y` 与 `anchor` / `ax` / `ay` 的关系

两套坐标并存，**优先用锚定**：

1. 若 `anchor` 非空，且页面上存在对应元素且元素可见 →
   备注位置 = `元素左上角 + (ax, ay)`，并可选按 `aw` / `ah` 做比例缩放。
2. 若 `anchor` 为空，或锚点元素不存在/被隐藏 → 回退到绝对坐标 `(x, y)`。
3. 锚点元素被隐藏时，备注也应隐藏（原型切了标签页的典型场景）。

`aw` / `ah` 是**记录锚点当时的尺寸**，用于在容器被撑高后按比例调整偏移，
避免备注跑到别处。若容器尺寸变化，实现方可以选择按比例缩放或不缩放。

#### `done`

只对 `kind === "todo"` 有意义，表示该待办已勾选完成。
`spec` 类型的备注此字段无意义，写 `false` 即可。

---

## 版本演进规则

`version` 是**整数**，从 `1` 开始。

- **加字段** → 版本号**不变**。读取方遇到不认识的字段应忽略。
- **改字段语义 / 删字段 / 改类型** → 版本号 **+1**。
- 读取方遇到**更高版本**的数据：可以只渲染认识的部分，**不要丢弃原数据**。
- 写入时应始终带上当前实现支持的 `version`。

当前实现见 `lib/injector.js` 的 `SCHEMA_VERSION`。

---

## 读写示例（Node）

```js
const injector = require('./lib/injector.js');
const fs = require('fs');

// 读
const html = fs.readFileSync('prototype.html', 'utf8');
const notes = injector.extractNotes(html);      // Note[]，读不到返回 []
const data  = injector.extractData(html);       // { version, updatedAt, notes } | null

// 写（幂等：先剥离上次注入，再插入新的）
const runtime = fs.readFileSync('./src/runtime/annotator.js', 'utf8');
const out = injector.injectInto(html, notes, runtime);
fs.writeFileSync('prototype.html', out);

// 清除注入，还原干净原型
const clean = injector.stripInjected(html);
```

---

## 写入安全要求（给实现者）

如果你自己实现一套读写，请务必满足这几条，否则会破坏用户文件：

1. **幂等**：写入前必须先剥离上次注入的内容，再插入新的。
   否则反复保存会让文件不断膨胀。
2. **原子写**：先写临时文件，再 `rename` 替换。避免中途失败留下半个文件。
3. **正文零改动**：除注入块外，不得改动用户 HTML 的任何内容——
   包括空行。标准是「注入后再剥离，结果与原文**逐字节一致**」。
4. **编辑凭证不落盘**：编辑模式靠一行临时注入的全局变量开启，
   该变量**绝不能**写进磁盘文件，否则接收方拿到的是可编辑版本。
5. **`</script` 转义**：运行时源码与 JSON 里若出现 `</script`，
   必须转义为 `<\/script`，否则会提前闭合脚本块。
