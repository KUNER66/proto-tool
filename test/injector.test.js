/* ==========================================================================
 * src/lib/injector.js 单元测试
 * 运行：node test/injector.test.js
 * ========================================================================== */

'use strict';

const assert = require('assert');
const path = require('path');
const inj = require(path.join(__dirname, '..', 'src', 'lib', 'injector.js'));

let pass = 0, fail = 0;
const cases = [];

function test(name, fn) {
  cases.push({ name, fn });
}

function run() {
  for (const c of cases) {
    try {
      c.fn();
      pass++;
      console.log('  PASS  ' + c.name);
    } catch (e) {
      fail++;
      console.log('  FAIL  ' + c.name);
      console.log('        ' + (e && e.message || e));
    }
  }
  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

/* ------------------------------------------------------------ 测试夹具 */

const RUNTIME = '/* fake runtime */ console.log("an");';

const BASE_HTML = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN">',
  '<head><meta charset="UTF-8"><title>T</title></head>',
  '<body>',
  '<h1>标题</h1>',
  '<p>正文内容</p>',
  '</body>',
  '</html>'
].join('\n');

/* ------------------------------------------------------------ 剥离逻辑 */

test('stripInjected: 干净 HTML 原样返回', () => {
  assert.strictEqual(inj.stripInjected(BASE_HTML), BASE_HTML);
});

test('stripInjected: 单段注入被完整剥离', () => {
  const withInj = inj.injectInto(BASE_HTML, [{ id: 'a', text: 'hi' }], RUNTIME);
  const back = inj.stripInjected(withInj);
  assert.ok(back.indexOf(inj.MARK_NOTES.begin) === -1, 'notes begin 残留');
  assert.ok(back.indexOf(inj.MARK_RUNTIME.begin) === -1, 'runtime begin 残留');
  assert.ok(back.indexOf('正文内容') !== -1, '正文被误删');
});

test('stripInjected: 重复注入后剥离回原状（幂等）', () => {
  let h = BASE_HTML;
  for (let i = 0; i < 5; i++) {
    h = inj.injectInto(h, [{ id: 'n' + i, text: 'x' }], RUNTIME);
  }
  const back = inj.stripInjected(h);
  assert.strictEqual(back.trim(), BASE_HTML.trim(), '多次注入后剥离结果与原文不一致');
});

/* ---- 这就是今天踩的坑：多段残留标记 ---- */

test('stripInjected: 文件里存在两段完整标记时，不吞掉中间正文', () => {
  // 模拟「历史原因残留了两段」的脏文件
  const dirty =
    BASE_HTML.slice(0, BASE_HTML.indexOf('</body>')) +
    '\n' + inj.MARK_NOTES.begin + '\n<script id="an-data" type="application/json">{"version":1,"notes":[]}</script>\n' + inj.MARK_NOTES.end + '\n' +
    inj.MARK_RUNTIME.begin + '\n<script>' + RUNTIME + '</script>\n' + inj.MARK_RUNTIME.end + '\n' +
    '<p>这段正文绝不能被删掉</p>\n' +
    inj.MARK_NOTES.begin + '\n<script id="an-data" type="application/json">{"version":1,"notes":[]}</script>\n' + inj.MARK_NOTES.end + '\n' +
    inj.MARK_RUNTIME.begin + '\n<script>' + RUNTIME + '</script>\n' + inj.MARK_RUNTIME.end + '\n' +
    '</body>\n</html>';

  const out = inj.stripInjected(dirty);
  assert.ok(out.indexOf('这段正文绝不能被删掉') !== -1, '中间正文被误删 —— 多标记串味 bug 复现');
  assert.strictEqual(inj.countMarks(out).notesBegin, 0, 'notes begin 未剥净');
  assert.strictEqual(inj.countMarks(out).runtimeBegin, 0, 'runtime begin 未剥净');
});

test('stripInjected: 剥离后正文段落数不减少', () => {
  const dirty = BASE_HTML.replace('</body>',
    inj.MARK_NOTES.begin + 'A' + inj.MARK_NOTES.end +
    '<div>keep-me-1</div>' +
    inj.MARK_NOTES.begin + 'B' + inj.MARK_NOTES.end +
    '<div>keep-me-2</div>' +
    '</body>');
  const out = inj.stripInjected(dirty);
  assert.ok(out.indexOf('keep-me-1') !== -1, 'keep-me-1 丢失');
  assert.ok(out.indexOf('keep-me-2') !== -1, 'keep-me-2 丢失');
});

test('stripOrphanMarks: 清掉残缺标记', () => {
  const dirty = BASE_HTML.replace('</body>',
    inj.MARK_NOTES.begin + '\n<p>正文</p>\n</body>');  // 只有 begin，没有 end
  const out = inj.stripOrphanMarks(dirty);
  assert.ok(out.indexOf(inj.MARK_NOTES.begin) === -1, '残缺 begin 未清掉');
  assert.ok(out.indexOf('正文') !== -1, '正文丢失');
});

/* ------------------------------------------------------------ 幂等性 */

test('injectInto: 连续注入 7 次，各结构块恒为 1 份', () => {
  let h = BASE_HTML;
  for (let i = 0; i < 7; i++) {
    h = inj.injectInto(h, [{ id: 'n' + i, text: '第 ' + i + ' 条' }], RUNTIME);
  }
  const tagCount = (id) => (h.match(new RegExp('<script\\s+id="' + id + '"', 'g')) || []).length;
  assert.strictEqual(tagCount(inj.DATA_SCRIPT_ID), 1, '数据块数量');
  assert.strictEqual(tagCount(inj.RUNTIME_SCRIPT_ID), 1, '运行时块数量');
});

test('injectInto: 多次注入后剥离 == 原文（最硬的幂等判据）', () => {
  const orig = BASE_HTML;
  let h = orig;
  for (let i = 0; i < 7; i++) {
    h = inj.injectInto(h, [{ id: 'n1', text: 'x' }], RUNTIME);
  }
  const back = inj.stripInjected(h);
  assert.strictEqual(back, orig, '剥离结果与原文不一致');
});

test('injectInto: 用户原型的空行不被破坏', () => {
  const withBlank = '<body>\n<p>A</p>\n\n<p>B</p>\n\n\n<p>C</p>\n</body>';
  let h = inj.injectInto(withBlank, [{ id: 'z', text: 't' }], RUNTIME);
  h = inj.injectInto(h, [{ id: 'z', text: 't' }], RUNTIME);
  assert.strictEqual(inj.stripInjected(h), withBlank, '空行被改动');
});

test('injectInto: 注入再剥离 == 原文（真实长运行时）', () => {
  // 用一个「源码里含 an-data 与标记字面量」的运行时，模拟真实情况
  const realistic = "var DATA_ID='an-data';var M='<!-- AN:NOTES:BEGIN -->';";
  let h = inj.injectInto(BASE_HTML, [{ id: 'x', text: '内容' }], realistic);
  h = inj.injectInto(h, [{ id: 'x', text: '内容' }], realistic);
  assert.strictEqual(inj.stripInjected(h), BASE_HTML, '含标记字面量的运行时导致剥离不净');
});

test('injectInto: 多次注入后文件体积不持续膨胀', () => {
  let h = BASE_HTML;
  h = inj.injectInto(h, [{ id: 'n1', text: 'x' }], RUNTIME);
  const size1 = Buffer.byteLength(h, 'utf8');
  for (let i = 0; i < 6; i++) {
    h = inj.injectInto(h, [{ id: 'n1', text: 'x' }], RUNTIME);
  }
  const size7 = Buffer.byteLength(h, 'utf8');
  // updatedAt 时间戳长度固定，允许极小抖动
  assert.ok(Math.abs(size7 - size1) < 8, '体积膨胀了：' + size1 + ' -> ' + size7);
});

/* ------------------------------------------------------------ 编辑凭证 */

test('buildInjection: editMode=false 不含凭证', () => {
  const s = inj.buildInjection([], RUNTIME, { editMode: false });
  assert.ok(s.indexOf('__AN_EDIT__') === -1, '不该有编辑凭证');
});

test('buildInjection: editMode=true 含凭证', () => {
  const s = inj.buildInjection([], RUNTIME, { editMode: true });
  assert.ok(s.indexOf('__AN_EDIT__') !== -1, '缺少编辑凭证');
  assert.ok(s.indexOf('"edit": true') !== -1 || s.indexOf('edit: true') !== -1, '凭证格式不对');
});

test('injectInto: 落盘调用（不传 opt）绝不含编辑凭证', () => {
  const s = inj.injectInto(BASE_HTML, [{ id: 'x' }], RUNTIME);
  assert.ok(s.indexOf('__AN_EDIT__') === -1, '落盘内容泄露了编辑凭证');
});

/* ------------------------------------------------------------ 数据读写 */

test('extractNotes: 读回写入的备注', () => {
  const notes = [
    { id: 'a', kind: 'spec', text: '正式说明', x: 10, y: 20 },
    { id: 'b', kind: 'todo', text: '内部待办', x: 30, y: 40, done: false }
  ];
  const h = inj.injectInto(BASE_HTML, notes, RUNTIME);
  const got = inj.extractNotes(h);
  assert.strictEqual(got.length, 2, '条数不符');
  assert.strictEqual(got[0].text, '正式说明');
  assert.strictEqual(got[1].kind, 'todo');
  assert.deepStrictEqual([got[0].x, got[0].y], [10, 20]);
});

test('extractData: 读回 version 与 updatedAt', () => {
  const h = inj.injectInto(BASE_HTML, [], RUNTIME);
  const d = inj.extractData(h);
  assert.ok(d, '读不到数据');
  assert.strictEqual(d.version, inj.SCHEMA_VERSION);
  assert.ok(typeof d.updatedAt === 'string' && d.updatedAt.length > 10, 'updatedAt 异常');
});

test('extractNotes: 无注入时返回空数组', () => {
  assert.deepStrictEqual(inj.extractNotes(BASE_HTML), []);
});

test('extractNotes: 数据损坏时返回空数组而不抛异常', () => {
  const broken = BASE_HTML.replace('</body>',
    inj.MARK_NOTES.begin + '<script id="an-data" type="application/json">{ 这不是 JSON }</script>' + inj.MARK_NOTES.end + '</body>');
  assert.deepStrictEqual(inj.extractNotes(broken), []);
});

test('extractNotes: 备注含 </script> 字样也不会破块', () => {
  const notes = [{ id: 'x', text: '示例代码：</script> 结尾' }];
  const h = inj.injectInto(BASE_HTML, notes, RUNTIME);
  const got = inj.extractNotes(h);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].text, '示例代码：</script> 结尾');
});

/* ------------------------------------------------------------ 插入位置 */

test('injectInto: 插在 </body> 之前', () => {
  const h = inj.injectInto(BASE_HTML, [], RUNTIME);
  assert.ok(h.indexOf(inj.MARK_NOTES.begin) < h.lastIndexOf('</body>'), '注入位置不对');
});

test('injectInto: 无 </body> 时插在 </html> 前', () => {
  const noBody = '<html><head></head><body-x></body-x></html>';
  const h = inj.injectInto(noBody, [], RUNTIME);
  assert.ok(h.indexOf(inj.MARK_NOTES.begin) !== -1, '注入丢失');
  assert.ok(h.indexOf(inj.MARK_NOTES.begin) < h.lastIndexOf('</html>'), '插入位置不对');
});

test('injectInto: 什么都没有时追加末尾', () => {
  const h = inj.injectInto('<p>裸片段</p>', [], RUNTIME);
  assert.ok(h.indexOf('<p>裸片段</p>') !== -1);
  assert.ok(h.indexOf(inj.MARK_NOTES.begin) > h.indexOf('<p>裸片段</p>'), '应追加在末尾');
});

/* ------------------------------------------------------------ 边界 */

test('stripInjected: 空串不崩', () => {
  assert.strictEqual(inj.stripInjected(''), '');
  assert.strictEqual(inj.stripInjected(null), '');
  assert.strictEqual(inj.stripInjected(undefined), '');
});

test('injectInto: notes 传 null 当成空数组', () => {
  const h = inj.injectInto(BASE_HTML, null, RUNTIME);
  assert.deepStrictEqual(inj.extractNotes(h), []);
});

test('hasInjection: 判定准确', () => {
  assert.strictEqual(inj.hasInjection(BASE_HTML), false);
  assert.strictEqual(inj.hasInjection(inj.injectInto(BASE_HTML, [], RUNTIME)), true);
});

/* 中文备注往返 */

test('往返：中文 + emoji + 换行 + 特殊字符不丢', () => {
  const text = '中文备注 ✓\n第二行 & <tag> "引号" \'单引号\' \\反斜杠';
  const h = inj.injectInto(BASE_HTML, [{ id: 'u', text }], RUNTIME);
  assert.strictEqual(inj.extractNotes(h)[0].text, text);
});

run();
