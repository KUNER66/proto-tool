/* ==========================================================================
 * proto-tool · 本地服务 server/index.js
 * --------------------------------------------------------------------------
 * 职责：
 *   1. 提供工具宿主页（src/index.html）与静态资源
 *   2. 页面内文件浏览器（列目录 / 列盘符）
 *   3. 把任意 HTML 注入运行时后喂给 iframe（同源，绕开 file:// 限制）
 *   4. 接收前端备注，幂等写回源 HTML
 *   5. 清除备注，还原干净原型
 *
 * 注入语义全部来自 src/lib/injector.js —— 与桌面端共用同一份实现。
 *
 * 启动：node server/index.js [--open] [--port 7317]
 * ========================================================================== */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const injector = require('../src/lib/injector.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');   /* 前端资源目录：桌面端打包的也是这一份 */
const RUNTIME_FILE = path.join(SRC, 'runtime', 'annotator.js');

const HOST = '127.0.0.1';

const APP_NAME = 'proto-tool';

/* 版本号只认 package.json 一个源，避免两处各写各的、发版时对不上。 */
function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch (e) {
    return '0.0.0';
  }
}

/* 参数解析收在一处：端口、是否开浏览器、是否只看帮助/版本。
   端口优先级 —— 命令行 --port > 环境变量 PORT > 默认 7317。
   不写死端口，方便多实例或端口冲突时切换。 */
function parseArgs(argv) {
  const opt = { port: null, open: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') {
      const n = parseInt(argv[i + 1], 10);
      if (n > 0 && n < 65536) opt.port = n;
      i++;
    } else if (a === '--open' || a === '-o') {
      opt.open = true;
    } else if (a === '--help' || a === '-h') {
      opt.help = true;
    } else if (a === '--version' || a === '-v') {
      opt.version = true;
    }
  }
  if (opt.port === null) {
    const env = parseInt(process.env.PORT, 10);
    if (env > 0 && env < 65536) opt.port = env;
  }
  if (opt.port === null) opt.port = 7317;
  return opt;
}

const OPT = parseArgs(process.argv.slice(2));
const PORT = OPT.port;

function printHelp() {
  const lines = [
    '',
    '  ' + APP_NAME + ' v' + readVersion(),
    '  给任意 HTML 原型贴便利贴，备注直接烧进文件。',
    '',
    '  用法:',
    '    ' + APP_NAME + ' [选项]',
    '',
    '  选项:',
    '    -p, --port <端口>   监听端口（默认 7317，也可用环境变量 PORT）',
    '    -o, --open          启动后自动打开浏览器',
    '    -h, --help          显示本帮助',
    '    -v, --version       显示版本号',
    '',
    '  示例:',
    '    ' + APP_NAME + ' --open',
    '    ' + APP_NAME + ' --port 8080',
    '',
  ];
  console.log(lines.join('\n'));
}

if (OPT.help) {
  printHelp();
  process.exit(0);
}
if (OPT.version) {
  console.log(readVersion());
  process.exit(0);
}

/* ------------------------------------------------------------ 运行时读取 */

function readRuntime() {
  return fs.readFileSync(RUNTIME_FILE, 'utf8');
}

/* ------------------------------------------------------------ 目录浏览 */
/* 用页面内的文件浏览器而非系统弹窗：
   系统弹窗是独立进程，抢不到浏览器前台焦点；且 GUI 程序 stdout 不走管道，
   node 读回来是空。页面内浏览器把这两类问题一起消掉。 */

/** 跨平台：列出可用根（Windows 为盘符，*nix 为 /） */
function listRoots() {
  const items = [];
  if (process.platform === 'win32') {
    const drives = [];
    for (let c = 65; c <= 90; c++) {            // A: ~ Z:
      const d = String.fromCharCode(c) + ':\\';
      try { if (fs.existsSync(d)) drives.push(d); } catch (e) { /* 跳过不可访问 */ }
    }
    for (const d of drives) items.push({ name: d, path: d, type: 'drive' });
  } else {
    items.push({ name: '/', path: '/', type: 'drive' });
  }
  return items;
}

/** 跨平台：用户常用目录快捷入口 */
function quickDirs() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return [];
  const cand = process.platform === 'win32'
    ? [['桌面', 'Desktop'], ['下载', 'Downloads'], ['文档', 'Documents']]
    : [['Home', ''], ['Desktop', 'Desktop'], ['Downloads', 'Downloads'], ['Documents', 'Documents']];
  const out = [];
  for (const [label, sub] of cand) {
    const p = sub ? path.join(home, sub) : home;
    try {
      if (fs.existsSync(p)) out.push({ name: label, path: p, type: 'quick' });
    } catch (e) { /* skip */ }
  }
  return out;
}

function listDir(dir) {
  if (!dir) {
    return { ok: true, cwd: '', parent: null, driveRoot: true, items: listRoots(), quick: quickDirs() };
  }
  if (!fs.existsSync(dir)) return { ok: false, error: '目录不存在' };

  let st;
  try { st = fs.statSync(dir); } catch (e) { return { ok: false, error: '无法访问' }; }
  if (!st.isDirectory()) return { ok: false, error: '不是目录' };

  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return { ok: false, error: '无权限读取' }; }

  const dirs = [], files = [];
  for (const n of names) {
    if (n.startsWith('.') || n.startsWith('~$')) continue;   // 跳过隐藏与 Office 临时文件
    const full = path.join(dir, n);
    let s;
    try { s = fs.statSync(full); } catch (e) { continue; }
    if (s.isDirectory()) {
      dirs.push({ name: n, path: full, type: 'dir' });
    } else if (/\.html?$/i.test(n)) {
      files.push({ name: n, path: full, type: 'file', size: s.size, mtime: s.mtimeMs });
    }
  }
  const cmp = (a, b) => a.name.localeCompare(b.name, 'zh-CN');
  dirs.sort(cmp);
  files.sort(cmp);

  const parent = path.dirname(dir);
  return {
    ok: true,
    cwd: dir,
    parent: parent === dir ? null : parent,
    items: dirs.concat(files),
    quick: quickDirs()
  };
}

/* ------------------------------------------------------------ HTTP 工具 */

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

function serveFile(res, filePath, type) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 32 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/** 原子写：先写临时文件再改名替换，避免中途失败毁掉用户原型 */
function atomicWrite(file, content) {
  const tmp = file + '.an-tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/** 校验目标确实是 html 文件且在可访问位置 */
function assertHtml(file) {
  if (!file || typeof file !== 'string') return '缺少文件路径';
  if (!/\.html?$/i.test(file)) return '只支持 .html / .htm 文件';
  if (!fs.existsSync(file)) return '文件不存在';
  return null;
}

/* ------------------------------------------------------------ 路由 */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + HOST + ':' + PORT);
  const p = decodeURIComponent(u.pathname);

  try {
    /* ---- 宿主页 ---- */
    if (p === '/' || p === '/index.html') {
      return serveFile(res, path.join(SRC, 'index.html'), 'text/html');
    }

    /* ---- 静态资源（限 SRC 与 lib 目录） ---- */
    if (p.startsWith('/static/')) {
      const rel = p.replace('/static/', '').replace(/\.\./g, '');
      const f = path.join(SRC, rel);
      if (!f.startsWith(SRC)) { res.writeHead(403); return res.end('forbidden'); }
      const ext = path.extname(f).toLowerCase();
      const type = ext === '.css' ? 'text/css'
        : ext === '.js' ? 'application/javascript'
        : 'application/octet-stream';
      return serveFile(res, f, type);
    }

    /* ---- 目录浏览 ---- */
    if (p === '/api/browse') {
      const dir = u.searchParams.get('dir') || '';
      return json(res, 200, listDir(dir));
    }

    /* ---- 文件信息 ---- */
    if (p === '/api/stat') {
      const file = u.searchParams.get('file');
      const err = assertHtml(file);
      if (err) return json(res, 200, { ok: false, error: err });
      const stat = fs.statSync(file);
      return json(res, 200, {
        ok: true,
        file,
        name: path.basename(file),
        size: stat.size,
        mtime: stat.mtimeMs,
        notes: injector.extractNotes(fs.readFileSync(file, 'utf8')).length
      });
    }

    /* ---- 渲染给 iframe 的视图（编辑模式，凭证不落盘） ---- */
    if (p === '/api/view') {
      const file = u.searchParams.get('file');
      const err = assertHtml(file);
      if (err) { res.writeHead(404); return res.end(err); }
      const src = fs.readFileSync(file, 'utf8');
      const html = injector.injectInto(src, injector.extractNotes(src), readRuntime(), { editMode: true });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    /* ---- 读备注 ---- */
    if (p === '/api/notes' && req.method === 'GET') {
      const file = u.searchParams.get('file');
      const err = assertHtml(file);
      if (err) return json(res, 404, { ok: false, error: err });
      const data = injector.extractData(fs.readFileSync(file, 'utf8'));
      return json(res, 200, { ok: true, notes: data ? data.notes : [], version: injector.SCHEMA_VERSION });
    }

    /* ---- 写备注（幂等落盘） ---- */
    if (p === '/api/notes' && req.method === 'PUT') {
      const body = await readBody(req);
      const file = body.file;
      const err = assertHtml(file);
      if (err) return json(res, 404, { ok: false, error: err });

      const src = fs.readFileSync(file, 'utf8');
      const out = injector.injectInto(src, body.notes || [], readRuntime());
      atomicWrite(file, out);

      const st = fs.statSync(file);
      return json(res, 200, {
        ok: true,
        count: (body.notes || []).length,
        size: st.size,
        mtime: st.mtimeMs
      });
    }

    /* ---- 清除备注，还原干净原型 ---- */
    if (p === '/api/purge' && req.method === 'POST') {
      const body = await readBody(req);
      const file = body.file;
      const err = assertHtml(file);
      if (err) return json(res, 404, { ok: false, error: err });

      const out = injector.stripOrphanMarks(injector.stripInjected(fs.readFileSync(file, 'utf8')));
      atomicWrite(file, out);
      return json(res, 200, { ok: true, size: fs.statSync(file).size });
    }

    /* ---- 健康检查（启动器据此判断是否已在运行） ---- */
    if (p === '/api/ping') {
      return json(res, 200, { ok: true, app: APP_NAME, version: APP_VERSION, port: PORT });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

/* ------------------------------------------------------------ 启动 */

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'start "" "' + url + '"'
    : process.platform === 'darwin' ? 'open "' + url + '"'
    : 'xdg-open "' + url + '"';
  exec(cmd, { windowsHide: true }, () => {});
}

server.listen(PORT, HOST, () => {
  const url = 'http://' + HOST + ':' + PORT + '/';
  console.log('');
  console.log('  ' + APP_NAME + ' v' + readVersion() + ' 已启动');
  console.log('  ' + url);
  console.log('');
  console.log('  保持本窗口开启；关闭窗口即停止服务。');
  console.log('  备注已经写进 HTML 文件，关窗不会丢。');
  console.log('');
  if (OPT.open) openBrowser(url);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    const url = 'http://' + HOST + ':' + PORT + '/';
    console.log('');
    console.log('  端口 ' + PORT + ' 已被占用，可能工具已经在运行。');
    console.log('  直接访问 ' + url);
    console.log('  或换端口： ' + APP_NAME + ' --port 7318');
    console.log('');
    if (OPT.open) openBrowser(url);
  } else {
    console.error('启动失败：', e);
  }
});
