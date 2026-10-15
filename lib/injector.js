/* ==========================================================================
 * proto-tool · 注入核心 lib/injector.js
 * --------------------------------------------------------------------------
 * 纯字符串处理，不依赖 http / fs / 任何运行时环境。
 * 这样 Node 本地服务、Tauri sidecar、CLI、单元测试可以共用同一套注入语义，
 * 避免「两处实现各改各的」导致行为漂移。
 *
 * 数据在 HTML 里的存放形态：
 *
 *   <!-- AN:NOTES:BEGIN -->
 *   <script id="an-data" type="application/json">{ ...备注... }</script>
 *   <!-- AN:NOTES:END -->
 *   <!-- AN:RUNTIME:BEGIN -->
 *   <script> ...渲染运行时... </script>
 *   <!-- AN:RUNTIME:END -->
 *
 * 注释标记的作用是**幂等**：每次保存前先把旧标记段整段剥掉，再插入新的。
 * 因此存一百次，文件里也永远只有一份数据和一份脚本。
 * ========================================================================== */

'use strict';

/* ----------------------------------------------------------------- 常量 */

/** 数据块标记（给人看的可读标记） */
const MARK_NOTES = Object.freeze({
  begin: '<!-- AN:NOTES:BEGIN -->',
  end: '<!-- AN:NOTES:END -->'
});

/** 运行时脚本标记 */
const MARK_RUNTIME = Object.freeze({
  begin: '<!-- AN:RUNTIME:BEGIN -->',
  end: '<!-- AN:RUNTIME:END -->'
});

/** 数据块 <script> 的 id */
const DATA_SCRIPT_ID = 'an-data';

/** 运行时 <script> 的 id
 *
 *  为什么运行时也要 id：运行时源码里含有标记字符串常量（它需要知道标记长什么样），
 *  因此**不能用标记文本去定位运行时块**——一匹配就会从脚本源码内部命中，把
 *  段边界算错，导致标记残留、体积重复膨胀（实测过：保存 6 次标记变 2 份）。
 *  改用带 id 的 <script> 作为结构性锚点，稳定且与源码内容无关。 */
const RUNTIME_SCRIPT_ID = 'an-runtime';

/** 数据格式版本。加字段只增不改，改语义才升版本号。 */
const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------- 剥离注入 */

/**
 * 剥离文件中所有已注入的内容，返回干净 HTML。
 *
 * 实现要点（两处坑都踩过）：
 *
 *   坑 1：不能「找到 begin 就往后找最近 end」。文件里若因历史原因残留多段
 *   标记，单次配对会把两段之间的正常内容一起删掉（实际把示例文件截断过）。
 *
 *   坑 2：**不能用标记文本定位运行时块**。运行时脚本源码里含标记字符串常量，
 *   用标记正则去匹配会从源码内部命中，段边界算错 → 标记剥离不净、
 *   反复保存体积膨胀。
 *
 * 因此改为「结构性定位」：
 *   数据块 → 匹配 <script id="an-data" ...>...</script>
 *   运行时 → 匹配 <script id="an-runtime">...</script>
 * 两者的起止都锚在唯一 id 上，与文件里出现的任何文本内容无关，
 * 天然幂等、不会串段。
 *
 * 兼容旧格式：同时清理裸标记段（老版本写下的文件），走标记正则兜底。
 */
function stripInjected(html) {
  if (typeof html !== 'string' || !html) return html || '';

  let out = html;

  // 1) 先把「运行时块」整个摘掉。
  //    顺序很重要：运行时源码里可能含标记碎片，先摘它，避免后续扫标记时误判。
  //    剥离靠 <script id> 结构性定位，与源码内容无关。
  out = stripScriptById(out, RUNTIME_SCRIPT_ID);

  // 2) 再摘数据块。
  out = stripScriptById(out, DATA_SCRIPT_ID);

  // 3) 最后统一清掉裸露在外的注释标记行。
  //    单独成步，就不必在剥离 script 时做「向前/向后吸收」——
  //    那种吸收会在源码含标记字面量时算错边界（踩过坑）。
  out = stripBareMarkLines(out);

  // 4) 兜底：清理旧格式裸标记段与残缺标记。
  out = stripMarkedSegments(out);
  out = stripOrphanMarks(out);

  return out;
}

/** 按 <script id="x"> ... </script> 结构性剥离一个脚本块。
 *  只做这一件事：定位开标签 → 找到配对的 </script> → 整段删除。
 *  不碰周边文本，边界绝对准确。 */
function stripScriptById(html, id) {
  const openRe = new RegExp('<script\\s+id="' + escapeRegExp(id) + '"[^>]*>', 'g');
  let out = html;
  let m;
  let guard = 0;
  while ((m = openRe.exec(out)) !== null && guard++ < 10000) {
    const start = m.index;
    const closeIdx = out.indexOf('</script>', start + m[0].length);
    if (closeIdx === -1) break;                       // 残缺，交给兜底处理
    const end = closeIdx + '</script>'.length;
    out = out.slice(0, start) + out.slice(end);
    openRe.lastIndex = start;                         // 从删除点继续扫描
  }
  return out;
}

/** 清掉裸露在外、单独成行的注入标记（以及它们带来的空行）
 *
 *  注意：**只删标记本身，绝不压缩其他空行**。
 *  早先版本用正则压连续空行，会把用户原型里正常的空行也吃掉，
 *  导致「剥离后 != 原文」。用户的原型长什么样，剥离后就该长什么样。 */
function stripBareMarkLines(html) {
  let out = html;
  for (const mark of [MARK_NOTES, MARK_RUNTIME]) {
    for (const tag of [mark.begin, mark.end]) {
      out = out.split(tag).join('');
    }
  }
  return out;
}

/** 兜底：剥掉裸标记包裹的段落（老格式 / 残缺标记） */
function stripMarkedSegments(html) {
  let out = html;
  for (const mark of [MARK_NOTES, MARK_RUNTIME]) {
    const re = new RegExp(
      '[ \\t]*' + escapeRegExp(mark.begin) + '[\\s\\S]*?' + escapeRegExp(mark.end) + '[ \\t]*\\r?\\n?',
      'g'
    );
    out = out.replace(re, '');
  }
  return out;
}

/**
 * 剥离所有**残缺**标记（只有 begin 没有 end，或反之）。
 * 用于容错：用户手动编辑 HTML 时可能删掉了半个标记，
 * 这时 stripInjected 的正则匹配不到，残留标记会越积越多。
 */
function stripOrphanMarks(html) {
  if (typeof html !== 'string' || !html) return html || '';
  let out = html;
  for (const mark of [MARK_NOTES, MARK_RUNTIME]) {
    out = out.split(mark.begin).join('').split(mark.end).join('');
  }
  return out;
}

/* ------------------------------------------------------------- 构造注入 */

/** 把 JSON 里可能提前闭合 <script> 的 `</` 转义掉 */
function escapeJsonForHtml(json) {
  return String(json).replace(/<\//g, '<\\/');
}

/** 读取时把转义还原 */
function unescapeJsonFromHtml(json) {
  return String(json).replace(/<\\\//g, '</');
}

/**
 * 构造注入体（数据块 + 运行时脚本）。
 *
 * @param {Array}  notes    备注数组
 * @param {string} runtime  运行时脚本源码
 * @param {Object} [opt]
 * @param {boolean} [opt.editMode] 是否注入编辑凭证。
 *        该凭证让运行时进入「可编辑」模式，**只在喂给工具 iframe 的那次
 *        请求里为 true，落盘一律 false**，保证分发给别人的文件里没有它。
 * @param {string} [opt.meta] 附加到 window.__AN_META__ 的 JSON 串（可选）
 * @returns {string}
 */
function buildInjection(notes, runtime, opt) {
  const o = opt || {};
  const payload = {
    version: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    notes: Array.isArray(notes) ? notes : []
  };
  const json = escapeJsonForHtml(JSON.stringify(payload, null, 2));

  let head = '';
  if (o.editMode) {
    // 编辑凭证：仅存在于「服务端渲染给 iframe」的那份 HTML 里，不落盘
    head += '<script>window.__AN_EDIT__ = {embedded: true, edit: true};</script>';
  }

  // 版面：整块写成「单行标记 + 紧跟脚本行」的紧凑形式，块内外都不留多余空行。
  // 剥离时按 id 定位 + 顺手吃掉标记行，做到「注入再剥离 == 原文」，
  // 保存一百次文件体积也不涨。
  return (
    MARK_NOTES.begin +
    '<script id="' + DATA_SCRIPT_ID + '" type="application/json">' + json + '</script>' +
    MARK_NOTES.end +
    MARK_RUNTIME.begin +
    head +
    '<script id="' + RUNTIME_SCRIPT_ID + '">' + runtime + '</script>' +
    MARK_RUNTIME.end
  );
}

/**
 * 运行时源码消毒：确保它能安全地内嵌进 `<script>` 里。
 *
 * HTML 解析器在 `<script>` 内部只认一个终止序列 `</script`。运行时源码里若
 * 出现这个序列（例如注释里举例写了 `</script>`），浏览器会把它当作脚本结束，
 * 后面的代码变成页面正文——白屏或错乱。
 * 这里把 `</` 转义成 `<\/`（JS 字符串与正则里的等价写法，语义不变）。
 */
function sanitizeRuntime(code) {
  return String(code).replace(/<\/(script)/gi, '<\\/$1');
}

/**
 * 把注入体插到 `</body>` 前；没有 body 就插到 `</html>` 前；都没有则追加末尾。
 * @returns {string}
 */
function injectInto(html, notes, runtime, opt) {
  const clean = stripInjected(html);
  const injection = buildInjection(notes, sanitizeRuntime(runtime), opt);

  const bodyClose = clean.lastIndexOf('</body>');
  if (bodyClose !== -1) {
    return clean.slice(0, bodyClose) + injection + clean.slice(bodyClose);
  }
  const htmlClose = clean.lastIndexOf('</html>');
  if (htmlClose !== -1) {
    return clean.slice(0, htmlClose) + injection + clean.slice(htmlClose);
  }
  return clean + injection;
}

/* ------------------------------------------------------------- 读取备注 */

/**
 * 读出已保存的完整数据对象（不只 notes，还含 version / updatedAt）。
 * 读不到或解析失败时返回 null。
 */
function extractData(html) {
  if (typeof html !== 'string' || !html) return null;
  const re = new RegExp(
    '<script id="' + DATA_SCRIPT_ID + '"[^>]*>([\\s\\S]*?)</script>'
  );
  const m = html.match(re);
  if (!m) return null;
  try {
    return JSON.parse(unescapeJsonFromHtml(m[1]));
  } catch (e) {
    return null;
  }
}

/** 只取备注数组，读不到返回 [] */
function extractNotes(html) {
  const d = extractData(html);
  return d && Array.isArray(d.notes) ? d.notes : [];
}

/** 文件里是否已含注入 */
function hasInjection(html) {
  if (typeof html !== 'string') return false;
  return html.indexOf(MARK_NOTES.begin) !== -1 || html.indexOf(MARK_RUNTIME.begin) !== -1;
}

/* ----------------------------------------------------------------- 工具 */

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 统计各标记出现次数，调试与测试用。
 *
 *  口径说明：运行时脚本源码里本身含有 `an-data`、标记名等字面量（它需要知道
 *  数据块 id 才能读）。因此不能简单数字符串出现次数——那样会把源码内容也算进去。
 *  这里只统计**结构性出现**：
 *    · 标记行         → 按「整行只有这个标记」匹配
 *    · script 标签    → 按 `<script id="x"` 匹配（源码里的 id 字符串不带这个前缀）
 */
function countMarks(html) {
  if (typeof html !== 'string' || !html) {
    return { notesBegin: 0, notesEnd: 0, runtimeBegin: 0, runtimeEnd: 0, dataScript: 0, runtimeScript: 0 };
  }
  // 注入时整块是紧凑的：`标记<script ...>` 与 `</script>标记`。
  // 只有真正的注入块才会呈现这种「标记紧贴 script 标签」的形态；
  // 运行时源码里的标记字面量是孤立字符串，不会被这个结构匹配命中。
  const blockCount = (tag) => {
    const re = new RegExp(escapeRegExp(tag) + '(?=<script|</)', 'g');
    return (html.match(re) || []).length;
  };
  const scriptCount = (id) => {
    const re = new RegExp('<script\\s+id="' + escapeRegExp(id) + '"', 'g');
    return (html.match(re) || []).length;
  };
  return {
    notesBegin: blockCount(MARK_NOTES.begin),
    notesEnd: blockCount(MARK_NOTES.end),
    runtimeBegin: blockCount(MARK_RUNTIME.begin),
    runtimeEnd: blockCount(MARK_RUNTIME.end),
    dataScript: scriptCount(DATA_SCRIPT_ID),
    runtimeScript: scriptCount(RUNTIME_SCRIPT_ID)
  };
}

/* --------------------------------------------------------------- 导出 */

module.exports = {
  MARK_NOTES,
  MARK_RUNTIME,
  DATA_SCRIPT_ID,
  RUNTIME_SCRIPT_ID,
  SCHEMA_VERSION,

  stripInjected,
  stripOrphanMarks,
  buildInjection,
  injectInto,
  sanitizeRuntime,

  extractData,
  extractNotes,
  hasInjection,

  escapeJsonForHtml,
  unescapeJsonFromHtml,
  countMarks,
  escapeRegExp
};
