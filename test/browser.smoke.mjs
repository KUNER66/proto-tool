/* 改名后的真机回归：验证运行时启动、贴备注、锚定、拖动、落盘 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 找一个可用的 Chromium。优先环境变量，其次 Playwright 常见安装位置。 */
function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    'C:/Users/石坤/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}
const CHROME = findChrome();
if (!CHROME) {
  console.log('SKIP: 未找到 Chromium。设置 CHROME_PATH 环境变量后重试。');
  process.exit(0);
}
const PORT = 9336;
const BASE = 'http://127.0.0.1:' + (process.env.PORT_TEST || '7318');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'examples', '_t.html');
const URL = BASE + '/api/view?file=' + encodeURIComponent(FILE) + '&edit=1';

/* 测试前准备一份临时原型，测试后清理 */
fs.copyFileSync(path.join(ROOT, 'examples', 'tabs-demo.html'), FILE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1440,900',
  '--user-data-dir=C:/Users/石坤/AppData/Local/Temp/an-cdp-r', 'about:blank'
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); wsUrl = j.webSocketDebuggerUrl; if (wsUrl) break; } catch (e) {}
  await sleep(250);
}
if (!wsUrl) { console.log('FAIL chrome'); child.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params, sessionId })); });
}
const t = await send('Target.createTarget', { url: 'about:blank' });
const targetId = t.result.targetId;
const sid = (await send('Target.attachToTarget', { targetId, flatten: true })).result.sessionId;
await send('Page.enable', {}, sid);
await send('Runtime.enable', {}, sid);
await send('Page.navigate', { url: URL }, sid);
await sleep(2500);

async function ev(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(function(){try{return JSON.stringify(${expr})}catch(e){return JSON.stringify({__err:String(e)})}})()`,
    returnByValue: true
  }, sid);
  const v = r.result && r.result.result && r.result.result.value;
  try { return JSON.parse(v); } catch (e) { return v; }
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* 1. 运行时启动自检（光看 __AN__ 存在会误判，必须看 DOM 节点） */
const boot = await ev(`({
  hasApi: !!window.__AN__,
  editMode: window.__AN__ ? window.__AN__.isEditMode() : null,
  styleNode: !!document.getElementById('an-style'),
  bar: !!document.getElementById('an-bar'),
  layer: !!document.getElementById('an-layer')
})`);
ok('运行时已挂载 __AN__', boot.hasApi === true, boot);
ok('进入编辑模式', boot.editMode === true, boot);
ok('样式节点已注入', boot.styleNode === true, boot);
ok('工具条已渲染', boot.bar === true, boot);
ok('便利贴图层已建立', boot.layer === true, boot);

/* 2. 新建空备注 → 失焦 → 应保留（之前修过的 bug） */
const t1 = await ev(`(function(){
  var A = window.__AN__;
  A.state.notes.length = 0; A.render();
  var n = A.addNoteAt(300, 250, 'spec');
  var node = document.getElementById('an-note-' + n.id);
  var ta = node.querySelector('.an-note-text');
  ta.blur();
  return { count: A.state.notes.length, kept: A.state.notes.some(x=>x.id===n.id), anchor: n.anchor };
})()`);
ok('新建空备注失焦后保留', t1.kept === true && t1.count === 1, t1);
ok('新建备注已绑定锚点', !!t1.anchor, t1);

/* 3. 编辑保存 */
const t2 = await ev(`(function(){
  var A = window.__AN__;
  var n = A.state.notes[0];
  A.startEdit(n.id);
  var node = document.getElementById('an-note-' + n.id);
  var ta = node.querySelector('.an-note-text');
  ta.textContent = '改名后回归测试';
  ta.blur();
  var m = A.state.notes.filter(x=>x.id===n.id)[0];
  return { text: m ? m.text : '(gone)', count: A.state.notes.length };
})()`);
ok('编辑内容已保存', t2.text === '改名后回归测试', t2);

/* 4. 锚定：切页签 */
const t3a = await ev(`(function(){
  var A = window.__AN__;
  A.state.notes.length = 0; A.render();
  var tabs = document.querySelectorAll('.tab');
  tabs[0].click();
  var box = document.querySelector('.panel.on .note-box');
  var r = box.getBoundingClientRect();
  var n = A.addNoteAt(r.left + 30, r.top + 16, 'spec');
  var node = document.getElementById('an-note-' + n.id);
  node.querySelector('.an-note-text').textContent = '锚定测试';
  node.querySelector('.an-note-text').blur();
  window.__T3__ = { id: n.id, off: [n.ax, n.ay] };
  tabs[1].click();
  return { anchor: n.anchor, off: [n.ax, n.ay] };
})()`);
await sleep(500);
const t3b = await ev(`(function(){
  var A = window.__AN__;
  var id = window.__T3__.id;
  var node = document.getElementById('an-note-' + id);
  return { hidden: node ? node.style.display === 'none' : null, count: A.state.notes.length };
})()`);
ok('切页签后备注隐藏', t3b.hidden === true, t3b);
ok('隐藏后备注数据保留', t3b.count === 1, t3b);

await ev(`document.querySelectorAll('.tab')[0].click()`);
await sleep(500);
const t3c = await ev(`(function(){
  var A = window.__AN__;
  var id = window.__T3__.id;
  var node = document.getElementById('an-note-' + id);
  var n = A.state.notes.filter(x=>x.id===id)[0];
  return { visible: node ? node.style.display !== 'none' : null,
           offSame: n ? (n.ax === window.__T3__.off[0] && n.ay === window.__T3__.off[1]) : null };
})()`);
ok('切回页签后备注恢复显示', t3c.visible === true, t3c);
ok('锚定偏移保持一致', t3c.offSame === true, t3c);

/* 5. 拖动精度 */
const t4 = await ev(`(function(){
  var A = window.__AN__;
  A.state.notes.length = 0; A.render();
  var n = A.addNoteAt(400, 300, 'spec');
  n.text = '拖动'; A.render();
  var node = document.getElementById('an-note-' + n.id);
  var sx = n.x, sy = n.y;
  function pe(type, x, y) {
    node.dispatchEvent(new PointerEvent(type, {bubbles:true, cancelable:true, clientX:x, clientY:y, button:0, buttons:1, pointerId:1, isPrimary:true}));
  }
  pe('pointerdown', 410, 310);
  var dev = [];
  [[30,20],[60,40],[90,60],[120,80]].forEach(function(d){
    pe('pointermove', 410+d[0], 310+d[1]);
    dev.push([n.x - sx - d[0], n.y - sy - d[1]]);
  });
  pe('pointerup', 530, 390);
  return { dev: dev, allExact: dev.every(function(d){return d[0]===0 && d[1]===0;}) };
})()`);
ok('拖动 1:1 精确跟手', t4.allExact === true, t4);

/* 8. 宿主 → 运行时的状态回写通道
   背景：运行时把工具条刷成「保存中…」后，写盘结果只有宿主知道。
   以前没有任何回写通道，导致那行字永远挂着（HTTP 与桌面端都中招）。
   现在运行时多了 __AN__.setStatus 供宿主回写。

   注意本测试的上下文：它是直接打开 /api/view 输出的 HTML 单跑运行时，
   没有宿主页，所以「保存中…」在这里挂着是正确行为，不能拿它当断言。
   这里只验证通道本身存在且生效；宿主是否调用它由真机手动验证。 */
const t5 = await ev(`(function(){
  var A = window.__AN__;
  var before = (document.getElementById('an-status') || {}).textContent;
  var hasSetter = typeof A.setStatus === 'function';
  if (hasSetter) A.setStatus('已保存 · 测试', false);
  var s = document.getElementById('an-status');
  return {
    hasSetter: hasSetter,
    before: before,
    after: s ? s.textContent : null,
    saving: A.state ? A.state.saving : '(no state)'
  };
})()`);
ok('运行时暴露状态回写口 setStatus', t5.hasSetter === true, t5);
ok('回写后工具条文案被改写', t5.after === '已保存 · 测试', t5);
ok('回写后 saving 标记复位', t5.saving === false, t5);

/* 9. 错误态回写：宿主保存失败时应把红色错误态也刷进工具条 */
const t6 = await ev(`(function(){
  window.__AN__.setStatus('保存失败', true);
  var s = document.getElementById('an-status');
  return { text: s ? s.textContent : null, isErr: s ? s.classList.contains('is-err') : null };
})()`);
ok('回写错误态带 is-err 样式', t6.text === '保存失败' && t6.isErr === true, t6);

console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed');

try { await send('Target.closeTarget', { targetId }); } catch (e) {}
ws.close(); child.kill(); await sleep(300);
try { fs.unlinkSync(FILE); } catch (e) {}
process.exit(fail ? 1 : 0);
