/* 端到端接口回归：注入 / 读回 / 幂等 / 清除 / 凭证不落盘 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT_TEST || '7318', 10);
const FILE = path.join(__dirname, '..', 'examples', 'demo.html');
const FILE_BACKUP = FILE + '.testbak';

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => resolve({ code: res.statusCode, body: s }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}

(async () => {
  // 备份原始示例
  fs.copyFileSync(FILE, FILE_BACKUP);

  try {
    let r;

    /* 1. 干净文件 stat */
    r = await req('GET', '/api/stat?file=' + encodeURIComponent(FILE));
    const st = JSON.parse(r.body);
    ok('stat 返回 ok', st.ok === true, st);
    ok('stat 干净文件 notes=0', st.notes === 0, st);

    /* 2. view 注入编辑凭证 */
    r = await req('GET', '/api/view?file=' + encodeURIComponent(FILE));
    ok('view 含编辑凭证', r.body.indexOf('__AN_EDIT__') !== -1);
    ok('view 含运行时', r.body.indexOf('AN:RUNTIME:BEGIN') !== -1);
    ok('view 含数据块', r.body.indexOf('<script id="an-data"') !== -1);

    /* 3. 写备注 */
    const notes = [
      { id: 'a1', kind: 'spec', text: '正式说明：折返时间待确认', x: 120, y: 160, anchor: 'a1', ax: 30, ay: 16, aw: 800, ah: 120 },
      { id: 'a2', kind: 'todo', text: '内部待办：补一版排班表', x: 300, y: 400, done: false }
    ];
    r = await req('PUT', '/api/notes', { file: FILE, notes });
    const save = JSON.parse(r.body);
    ok('保存返回 ok', save.ok === true, save);
    ok('保存条数=2', save.count === 2, save);

    /* 4. 读回 */
    r = await req('GET', '/api/notes?file=' + encodeURIComponent(FILE));
    const got = JSON.parse(r.body);
    ok('读回 2 条', got.notes.length === 2, got);
    ok('读回文本正确', got.notes[0].text === notes[0].text, got.notes[0]);
    ok('读回类型正确', got.notes[1].kind === 'todo', got.notes[1]);
    ok('读回锚定字段', got.notes[0].anchor === 'a1' && got.notes[0].ax === 30, got.notes[0]);

    /* 5. 磁盘检查
     *
     *  判据选择说明：不用「标记文本出现几次」来判定幂等——运行时脚本源码里
     *  本身就含 `an-data`、标记名等字面量，按文本计数会把源码内容也算进来，
     *  得出假阳性。真正可靠的判据是**结构性**的：
     *    · script 标签数量（<script id="an-data" / <script id="an-runtime"）
     *    · 剥离后能否精确还原成注入前的原文
     */
    const disk = fs.readFileSync(FILE, 'utf8');
    const tagCount = (id) => (disk.match(new RegExp('<script\\s+id="' + id + '"', 'g')) || []).length;
    ok('磁盘数据块 script 恰好 1 个', tagCount('an-data') === 1, tagCount('an-data'));
    ok('磁盘运行时 script 恰好 1 个', tagCount('an-runtime') === 1, tagCount('an-runtime'));
    /* 凭证泄露判据：不能只搜 `__AN_EDIT__` 这个字符串——
       运行时源码里本来就有 `window.__AN_EDIT__` 的**读取**代码（它要靠这个变量
       判断自己是不是编辑模式），这不算泄露。
       真正的泄露是**赋值**：磁盘文件里出现了 `window.__AN_EDIT__ = {...edit:true}`，
       那才意味着把编辑权限交给了接收方。 */
    const credAssign = /window\.__AN_EDIT__\s*=\s*\{[^}]*edit:\s*true/.test(disk);
    ok('磁盘无编辑凭证泄露（无赋值语句）', credAssign === false, { leaked: credAssign });
    const size1 = Buffer.byteLength(disk, 'utf8');

    /* 6. 幂等：再存 5 次 */
    for (let i = 0; i < 5; i++) await req('PUT', '/api/notes', { file: FILE, notes });
    const disk2 = fs.readFileSync(FILE, 'utf8');
    const tag2 = (id) => (disk2.match(new RegExp('<script\\s+id="' + id + '"', 'g')) || []).length;
    ok('6 次保存后 script 仍各 1 个', tag2('an-data') === 1 && tag2('an-runtime') === 1,
       { data: tag2('an-data'), runtime: tag2('an-runtime') });

    /* 6b. 用 injector 直接验证「剥离后 == 原文」——最硬的幂等判据 */
    const injector = require('../lib/injector.js');
    const restored = injector.stripInjected(disk2);
    const origRaw = fs.readFileSync(FILE_BACKUP, 'utf8');
    ok('剥离注入后与注入前原文完全一致', restored === origRaw,
       { restoredLen: restored.length, origLen: origRaw.length });

    const size2 = Buffer.byteLength(disk2, 'utf8');
    ok('6 次保存体积基本不涨（<64 字节）', Math.abs(size2 - size1) < 64, { size1, size2, drift: size2 - size1 });

    /* 7. 清除 */
    r = await req('POST', '/api/purge', { file: FILE });
    const purge = JSON.parse(r.body);
    ok('清除返回 ok', purge.ok === true, purge);
    const disk3 = fs.readFileSync(FILE, 'utf8');
    ok('清除后无标记残留', disk3.indexOf('AN:NOTES:BEGIN') === -1 && disk3.indexOf('AN:RUNTIME:BEGIN') === -1);
    ok('清除后正文完好', disk3.indexOf('待确认事项') !== -1, '正文丢了');
    ok('清除后结构闭合', disk3.indexOf('</body>') !== -1 && disk3.indexOf('</html>') !== -1);

    /* 8. 清除结果应与原始文件一致 */
    const orig = fs.readFileSync(FILE_BACKUP, 'utf8');
    ok('清除后与原始文件等长', Math.abs(Buffer.byteLength(disk3, 'utf8') - Buffer.byteLength(orig, 'utf8')) < 8,
       { after: Buffer.byteLength(disk3, 'utf8'), orig: Buffer.byteLength(orig, 'utf8') });

    /* 9. 目录浏览 */
    r = await req('GET', '/api/browse?dir=');
    const br = JSON.parse(r.body);
    ok('浏览根目录 ok', br.ok === true, br);
    ok('根目录有盘符或快捷入口', (br.items && br.items.length > 0) || (br.quick && br.quick.length > 0), br);

    r = await req('GET', '/api/browse?dir=' + encodeURIComponent(path.join(__dirname, '..', 'examples')));
    const br2 = JSON.parse(r.body);
    ok('浏览 examples 目录', br2.ok === true && br2.items.some(i => i.type === 'file'), br2);

    /* 10. 非法输入 */
    r = await req('GET', '/api/stat?file=' + encodeURIComponent('C:/nope/nope.html'));
    ok('不存在文件被拒', JSON.parse(r.body).ok === false, JSON.parse(r.body));

    r = await req('GET', '/api/stat?file=' + encodeURIComponent(path.join(__dirname, '..', 'package.json')));
    ok('非 html 文件被拒', JSON.parse(r.body).ok === false, JSON.parse(r.body));

  } finally {
    fs.copyFileSync(FILE_BACKUP, FILE);   // 还原
    fs.unlinkSync(FILE_BACKUP);
  }

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  try { if (fs.existsSync(FILE_BACKUP)) { fs.copyFileSync(FILE_BACKUP, FILE); fs.unlinkSync(FILE_BACKUP); } } catch (_) {}
  console.error('测试异常：', e);
  process.exit(1);
});
