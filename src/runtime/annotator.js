/* ==========================================================================
   html-note · 运行时 annotator.js
   --------------------------------------------------------------------------
   这份代码会被烧进目标 HTML，接收方双击即可看到备注，全程零依赖、零联网。

   三种运行形态，同一份代码自动判定：
     1) 独立展示模式 —— 接收方直接双击 HTML。
        没有父窗口握手，读页内数据块（id 为 an-data 的 script），只读渲染便利贴。
     2) 工具编辑模式 —— 在 html-note 的 iframe 里运行。
        与父窗口握手后拿到写回通道，增删改拖实时通知父窗口写盘。
     3) 早期本地服务模式 —— 兼容保留，非主路径。

   判定顺序：编辑凭证 > 父窗口握手 > 独立展示。
   ========================================================================== */
(function () {
  'use strict';

  if (window.__AN_READY__) return;
  window.__AN_READY__ = true;

  var NS = 'an';
  var DATA_ID = 'an-data';

  /* 标记常量：这里**故意用字符串拼接**构造，不让完整的标记序列以字面量
     形式出现在运行时源码里。
     原因：运行时被原样烧进目标 HTML，宿主端剥离注入块时要扫描标记文本。
     若源码里就躺着 '<!-- AN:NOTES:BEGIN -->' 这样的完整序列，扫描会从
     脚本内部命中，把段边界算错，导致标记剥离不净、反复保存体积膨胀。
     拼接后源码里只有碎片，扫不出完整序列，宿主端定位才干净。 */
  var MARK_BEGIN = '<' + '!-- AN:NOTES:BEGIN --' + '>';
  var MARK_END = '<' + '!-- AN:NOTES:END --' + '>';

  /* ---------------------------------------------------------------- 基础 */
  var KINDS = {
    spec: { label: '正式说明', color: '#FAC775', edge: '#BA7517', text: '#412402' },
    todo: { label: '内部待办', color: '#AFA9EC', edge: '#534AB7', text: '#26215C' }
  };

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function uid() {
    return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function debounce(fn, ms) {
    var t;
    return function () {
      var self = this, a = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, a); }, ms);
    };
  }

  /* ---------------------------------------------------------------- 状态 */
  var api = window.__AN_EDIT__ || null;
  var IN_FRAME = (function () {
    try { return window.parent && window.parent !== window; } catch (e) { return false; }
  })();

  var state = {
    notes: [],
    showTodo: true,
    editing: false,
    saving: false
  };

  /* ---------------------------------------------------------------- 通道 */
  /* 与宿主页通信。同源 iframe 下优先直接调用父页面注册的 host 对象，
     退化为 postMessage。两者都不可用时说明是独立展示模式。 */
  function post(msg) {
    // 路径 1：同源直连（宿主页主动注册）
    if (IN_FRAME) {
      try {
        var host = window.parent.__AN_HOST__;
        if (host && typeof host.onNoteChange === 'function') {
          if (msg.type === 'save') { host.onNoteChange(msg.notes); return true; }
          if (msg.type === 'status' && typeof host.onStatus === 'function') {
            host.onStatus(msg.text, msg.isErr); return true;
          }
          if (msg.type === 'ready' && typeof host.onReady === 'function') {
            host.onReady(msg.count); return true;
          }
        }
      } catch (e) { /* 跨源则落到路径 2 */ }
    }
    // 路径 2：postMessage
    if (IN_FRAME) {
      try {
        window.parent.postMessage(Object.assign({ __an: true }, msg), '*');
        return true;
      } catch (e) { /* 落到路径 3 */ }
    }
    return false;
  }

  function reportStatus(text, isErr) {
    var s = document.getElementById(NS + '-status');
    if (s) {
      s.textContent = text || '';
      s.classList.toggle('is-err', !!isErr);
    }
    post({ type: 'status', text: text || '', isErr: !!isErr });
  }

  var saveDebounced = debounce(function () {
    state.saving = true;
    reportStatus('保存中…');
    // 编辑模式下由宿主页面接住 save 消息并写盘；
    // 展示模式没有 EDIT，压根不会走到这里。
    post({ type: 'save', notes: state.notes });
  }, 350);

  function touch() { saveDebounced(); }

  var EDIT = false;

  /* ---------------------------------------------------------------- 读数 */
  function readEmbedded() {
    var node = document.getElementById(DATA_ID);
    if (!node) return null;
    try { return JSON.parse(node.textContent); } catch (e) { return null; }
  }

  function loadNotes() {
    // 无论哪种模式，页内嵌的数据块都是唯一权威来源。
    // 编辑模式下由宿主页面负责写盘，运行时只需渲染 + 通知。
    var d = readEmbedded();
    if (d) {
      if (d.notes) state.notes = d.notes;
    }
    // 展示模式：两类备注全部呈现，接收方一眼看全
    // 编辑模式：内部待办默认折叠，工具条可展开
    state.showTodo = !EDIT;
    return Promise.resolve();
  }

  /* ---------------------------------------------------------------- 渲染 */
  function visibleNotes() {
    return state.notes.filter(function (n) { return n.kind === 'spec' || state.showTodo; });
  }

  var layer = null;
  function getLayer() {
    if (layer && layer.parentNode) return layer;
    layer = document.getElementById(NS + '-layer');
    if (!layer) {
      layer = el('div', NS + '-layer');
      layer.id = NS + '-layer';
      (document.body || document.documentElement).appendChild(layer);
    }
    return layer;
  }

  function buildNote(n, idx) {
    var k = KINDS[n.kind] || KINDS.spec;
    var box = el('div', NS + '-note ' + NS + '-note-' + n.kind + (n.done ? ' ' + NS + '-note-done' : ''));
    box.id = NS + '-note-' + n.id;
    box.dataset.id = n.id;
    box.style.cssText = 'position:absolute;left:' + (n.x || 0) + 'px;top:' + (n.y || 0) + 'px;' +
      'background:' + (n.color || k.color) + ';border-color:' + k.edge + ';color:' + k.text + ';';

    var head = el('div', NS + '-note-head');
    head.appendChild(el('span', NS + '-note-kind', idx + '·' + k.label));

    var body = el('div', NS + '-note-text');
    body.textContent = n.text || '';
    head.appendChild(body);

    if (EDIT) {
      var tools = el('div', NS + '-note-tools');
      tools.appendChild(mkTool('✎', '编辑内容', function () { startEdit(n.id); }));
      tools.appendChild(mkTool('✕', '删除备注', function () { removeNote(n.id); }));
      head.appendChild(tools);
      box.addEventListener('pointerdown', function (e) { startDrag(e, n.id); });
    }

    box.appendChild(head);
    return box;
  }

  function mkTool(txt, title, fn) {
    var b = el('button', NS + '-note-tool', txt);
    b.type = 'button';
    b.title = title;
    b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
    return b;
  }

  function renderNotes() {
    var L = getLayer();
    L.innerHTML = '';
    var list = visibleNotes();
    var frag = document.createDocumentFragment();
    list.forEach(function (n, i) { frag.appendChild(buildNote(n, i + 1)); });
    L.appendChild(frag);
    reflowAnchors();
    syncTodoBtn();
    updatePanel();
    updateDock();
  }

  /* ---------------------------------------------------------------- 拖动 */
  /* 用 pointerdown + transform 位移，避开旋转包围盒的测量误差，跟手更准 */
  var drag = null;
  function startDrag(e, id) {
    if (state.editing || e.button !== 0) return;
    var node = document.getElementById(NS + '-note-' + id);
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();

    // 拖动的起点用 note 自身的 left/top（未旋转的布局值），不用 getBoundingClientRect，
    // 因为后者返回的是旋转后的包围盒，会导致偏移量失真。
    var n = findNote(id);
    if (!n) return;

    drag = {
      id: id, node: node,
      startX: e.clientX, startY: e.clientY,
      origX: n.x || 0, origY: n.y || 0
    };
    node.classList.add(NS + '-note-dragging');
    document.addEventListener('pointermove', onDrag);
    document.addEventListener('pointerup', endDrag);
  }

  function onDrag(e) {
    if (!drag) return;
    var n = findNote(drag.id);
    if (!n) return;
    var x = drag.origX + (e.clientX - drag.startX);
    var y = drag.origY + (e.clientY - drag.startY);
    n.x = Math.round(Math.max(0, x));
    n.y = Math.round(Math.max(0, y));
    drag.node.style.left = n.x + 'px';
    drag.node.style.top = n.y + 'px';
  }

  function endDrag() {
    if (!drag) return;
    drag.node.classList.remove(NS + '-note-dragging');
    document.removeEventListener('pointermove', onDrag);
    document.removeEventListener('pointerup', endDrag);
    var n = findNote(drag.id);
    if (n) {
      n.updatedAt = Date.now();
      // 落点重新锚定：记住它现在盖在哪个元素上
      rebindAnchor(n);
    }
    touch();
    drag = null;
  }

  /* ------------------------------------------------- 元素锚定（跟随页面切换） */
  /* 备注若是死钉在文档像素上，原型一切换页签就"漂"在那里不动。
     解法：记录备注盖住的元素（data-an-anchor 标记）+ 相对该元素的偏移，
     页面结构变化后重新按锚点计算位置；锚点消失则隐藏该备注。 */

  var ANCHOR_ATTR = 'data-an-anchor';
  var anchorSeq = 0;
  var HOST_SELECTOR = 'section,article,main,nav,header,footer,aside,table,form,ul,ol,' +
    'div[class],tr,li,td,th,h1,h2,h3,h4,h5,h6,p,label,button,a';

  /** 取元素在锚点元素坐标系下的偏移 */
  function offsetIn(el, anchor) {
    var a = anchor.getBoundingClientRect();
    var r = el.getBoundingClientRect();
    return {
      dx: (r.left + window.scrollX) - (a.left + window.scrollX),
      dy: (r.top + window.scrollY) - (a.top + window.scrollY)
    };
  }

  /** 找出某个屏幕点下方"最合适"的锚点元素 */
  function pickAnchor(x, y) {
    // 临时隐藏备注层，避免采到备注自身
    var L = getLayer();
    var prev = L.style.pointerEvents;
    L.style.pointerEvents = 'none';
    var stack;
    try {
      stack = document.elementsFromPoint(x, y) || [];
    } catch (e) {
      stack = [];
    }
    L.style.pointerEvents = prev;

    for (var i = 0; i < stack.length; i++) {
      var el = stack[i];
      if (!el || el.nodeType !== 1) continue;
      if (el.id === NS + '-layer' || el.closest('.' + NS + '-note') ||
        el.closest('.' + NS + '-bar') || el.closest('.' + NS + '-panel') ||
        el.closest('.' + NS + '-dock')) continue;
      if (el === document.body || el === document.documentElement) continue;
      if (!el.matches || !el.matches(HOST_SELECTOR)) continue;

      // 优先取"有意义的容器"：可见且有尺寸
      var r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;

      if (!el.getAttribute(ANCHOR_ATTR)) {
        el.setAttribute(ANCHOR_ATTR, 'a' + (++anchorSeq));
      }
      return el;
    }
    return null;
  }

  /** 新建/拖动落点后，绑定锚点 */
  function rebindAnchor(n) {
    var node = document.getElementById(NS + '-note-' + n.id);
    if (!node) return;
    var anchor = pickAnchor(n.x + 20, n.y + 10);
    if (!anchor) { n.anchor = null; n.ax = n.ay = n.aw = n.ah = null; return; }
    var off = offsetIn(node, anchor);
    var ar = anchor.getBoundingClientRect();
    n.anchor = anchor.getAttribute(ANCHOR_ATTR);
    n.ax = Math.round(off.dx);
    n.ay = Math.round(off.dy);
    n.aw = Math.round(ar.width);
    n.ah = Math.round(ar.height);
  }

  /** 按锚点重算所有备注位置 */
  function reflowAnchors() {
    var changed = false;
    state.notes.forEach(function (n) {
      var node = document.getElementById(NS + '-note-' + n.id);
      if (!node) return;

      // 没有锚点的旧数据：保持绝对坐标
      if (!n.anchor) {
        if (node.getAttribute('data-an-hidden')) {
          node.style.display = '';
          node.removeAttribute('data-an-hidden');
        }
        return;
      }

      var anchor = document.querySelector('[' + ANCHOR_ATTR + '="' + n.anchor + '"]');

      // 锚点被移除 or 被隐藏（典型：切了页签）→ 隐藏备注，数据保留
      if (!anchor || !isVisible(anchor)) {
        if (node.style.display !== 'none') {
          node.style.display = 'none';
          node.setAttribute('data-an-hidden', '1');
        }
        return;
      }

      // 锚点可见 → 恢复显示并按锚点重算
      if (node.style.display === 'none') {
        node.style.display = '';
        node.removeAttribute('data-an-hidden');
      }
      var a = anchor.getBoundingClientRect();
      var nx = Math.round(a.left + window.scrollX + (n.ax || 0));
      var ny = Math.round(a.top + window.scrollY + (n.ay || 0));

      // 若锚点尺寸大变（如容器被撑高），按比例缩放偏移，避免跑到别处
      var r = anchor.getBoundingClientRect();
      if (n.aw && n.ah && r.width && r.height) {
        var sx = r.width / n.aw, sy = r.height / n.ah;
        if (Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02) {
          nx = Math.round(a.left + window.scrollX + (n.ax || 0) * sx);
          ny = Math.round(a.top + window.scrollY + (n.ay || 0) * sy);
        }
      }

      if (nx !== n.x || ny !== n.y) {
        n.x = nx;
        n.y = ny;
        changed = true;
      }
      node.style.left = nx + 'px';
      node.style.top = ny + 'px';
    });
    return changed;
  }

  function isVisible(el) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    return true;
  }

  /** 监听页面结构变化，自动重算锚定位置 */
  var reflowTimer = null;
  function scheduleReflow() {
    clearTimeout(reflowTimer);
    reflowTimer = setTimeout(function () {
      if (drag) return;         // 拖动中不重算，否则便利贴会被拽回去
      reflowAnchors();
    }, 120);
  }

  function watchDom() {
    if (!window.MutationObserver) return;
    var mo = new MutationObserver(function (muts) {
      // 只关心元素增删与 class/style 变化，忽略备注层自身
      for (var i = 0; i < muts.length; i++) {
        var t = muts[i].target;
        if (t && t.id === NS + '-layer') continue;
        if (t && t.closest && t.closest('.' + NS + '-note')) continue;
        if (drag) return;
        scheduleReflow();
        return;
      }
    });
    mo.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['class', 'style', 'hidden']
    });
    window.addEventListener('resize', scheduleReflow);
    window.addEventListener('scroll', function () {
      if (drag) return;
      reflowAnchors();
    }, { passive: true });
  }

  /* ------------------------------------------------------------ 增删改 */
  function findNote(id) {
    for (var i = 0; i < state.notes.length; i++) if (state.notes[i].id === id) return state.notes[i];
    return null;
  }

  function addNoteAt(x, y, kind) {
    var n = {
      id: uid(), kind: kind === 'todo' ? 'todo' : 'spec', text: '',
      x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)),
      createdAt: Date.now(), updatedAt: Date.now(), done: false
    };
    state.notes.push(n);
    // 新建内部待办时自动展开，否则刚贴完就看不见，以为工具坏了
    if (n.kind === 'todo') state.showTodo = true;
    renderNotes();
    // 立刻绑定锚点：记住它盖在哪个元素上，页面切换时才能跟着走
    rebindAnchor(n);
    if (EDIT) { startEdit(n.id); } else { touch(); }
    return n;
  }

  function removeNote(id) {
    state.notes = state.notes.filter(function (n) { return n.id !== id; });
    renderNotes();
    touch();
    reportStatus('已删除 1 条');
  }

  function setKind(id, kind) {
    var n = findNote(id);
    if (!n || n.kind === kind) return;
    n.kind = kind; n.updatedAt = Date.now();
    renderNotes(); touch();
  }

  function startEdit(id) {
    var n = findNote(id);
    if (!n) return;
    var node = document.getElementById(NS + '-note-' + id);
    if (!node) return;
    var ta = node.querySelector('.' + NS + '-note-text');
    if (!ta || ta.getAttribute('contenteditable') === 'true') return;

    var tools = node.querySelector('.' + NS + '-note-tools');
    if (tools) tools.style.display = 'flex';

    ta.setAttribute('contenteditable', 'true');
    ta.focus();
    try { document.execCommand('selectAll', false, null); } catch (e) {}

    var orig = n.text || '';
    var isNew = !orig;               /* 新建空备注：先摆位置后填字，别误删 */
    var closed = false;
    function finish() {
      if (closed) return;
      closed = true;
      ta.removeEventListener('blur', finish);
      ta.removeEventListener('keydown', onKey);
      ta.removeAttribute('contenteditable');
      var val = ta.textContent.replace(/\u00a0/g, ' ').trim();

      if (!val) {
        if (isNew) {
          /* 新建时没输入内容：保留这条备注 */
          n.text = '';
        } else {
          /* 原有备注被清空：视为删除 */
          state.notes = state.notes.filter(function (x) { return x.id !== id; });
        }
      } else {
        n.text = val;
      }
      n.updatedAt = Date.now();
      if (tools) tools.style.display = '';   /* 收工：把内联 display 清掉，回到 hover 才出现的规则 */
      renderNotes();
      if (!val && isNew && !n.anchor) rebindAnchor(n);
      touch();
    }
    function onKey(e) {
      e.stopPropagation();
      if (e.key === 'Escape') { ta.textContent = orig; ta.blur(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ta.blur();
    }
    ta.addEventListener('blur', finish);
    ta.addEventListener('keydown', onKey);
  }

  /* ------------------------------------------------------------ 贴纸模式 */
  function setEditing(on) {
    state.editing = !!on;
    document.body.classList.toggle(NS + '-editing', state.editing);
    var btn = document.getElementById(NS + '-btn-add');
    if (btn) {
      btn.classList.toggle('is-active', state.editing);
      btn.textContent = state.editing ? '点页面放置 · Esc 取消' : '+ 备注';
    }
    reportStatus(state.editing ? '贴纸模式：点击页面任意位置放置' : '');
  }

  function onDocClick(e) {
    if (!state.editing) return;
    var t = e.target;
    if (t.closest && (t.closest('.' + NS + '-bar') || t.closest('.' + NS + '-panel') ||
      t.closest('.' + NS + '-note') || t.closest('.' + NS + '-dock'))) return;
    var sel = document.getElementById(NS + '-kind');
    addNoteAt(e.clientX + window.scrollX, e.clientY + window.scrollY, sel ? sel.value : 'spec');
    setEditing(false);
  }

  /* ------------------------------------------------------------ 工具条 */
  function buildBar() {
    if (document.getElementById(NS + '-bar')) return;
    var bar = el('div', NS + '-bar');
    bar.id = NS + '-bar';

    bar.appendChild(el('span', NS + '-bar-title', '备注'));

    var kind = el('select', NS + '-kind');
    kind.id = NS + '-kind';
    kind.title = '新建备注的类型';
    Object.keys(KINDS).forEach(function (k) {
      var o = el('option', null, KINDS[k].label);
      o.value = k;
      kind.appendChild(o);
    });
    bar.appendChild(kind);

    var addBtn = el('button', NS + '-btn', '+ 备注');
    addBtn.id = NS + '-btn-add';
    addBtn.type = 'button';
    addBtn.addEventListener('click', function () { setEditing(!state.editing); });
    bar.appendChild(addBtn);

    var todoBtn = el('button', NS + '-btn ' + NS + '-btn-ghost', '');
    todoBtn.id = NS + '-btn-todo';
    todoBtn.type = 'button';
    todoBtn.title = '内部待办默认折叠，点这里临时展开';
    todoBtn.addEventListener('click', function () {
      state.showTodo = !state.showTodo;
      renderNotes();
    });
    bar.appendChild(todoBtn);

    var panelBtn = el('button', NS + '-btn ' + NS + '-btn-ghost', '清单');
    panelBtn.id = NS + '-btn-panel';
    panelBtn.type = 'button';
    panelBtn.title = '备注清单：集中查看 / 定位 / 改类型';
    panelBtn.addEventListener('click', togglePanel);
    bar.appendChild(panelBtn);

    var expBtn = el('button', NS + '-btn ' + NS + '-btn-ghost', '导出文本');
    expBtn.type = 'button';
    expBtn.title = '复制全部备注为纯文本';
    expBtn.addEventListener('click', function () {
      var txt = state.notes.map(function (n, i) {
        return (i + 1) + '. [' + (KINDS[n.kind] || KINDS.spec).label + '] ' + (n.text || '');
      }).join('\n');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt);
        reportStatus('已复制 ' + state.notes.length + ' 条到剪贴板');
      } else {
        reportStatus('浏览器拒绝了剪贴板，请手动复制', true);
      }
    });
    bar.appendChild(expBtn);

    var status = el('span', NS + '-status');
    status.id = NS + '-status';
    bar.appendChild(status);

    (document.body || document.documentElement).appendChild(bar);
    syncTodoBtn();
  }

  function syncTodoBtn() {
    var b = document.getElementById(NS + '-btn-todo');
    if (!b) return;
    var c = state.notes.filter(function (n) { return n.kind === 'todo'; }).length;
    b.textContent = '内部待办 ' + c + (state.showTodo ? '·展开' : '·折叠');
    b.classList.toggle('is-active', state.showTodo);
  }

  var panelOpen = false;
  function togglePanel() {
    panelOpen = !panelOpen;
    var p = document.getElementById(NS + '-panel');
    if (!p) return;
    p.style.display = panelOpen ? 'flex' : 'none';
    var b = document.getElementById(NS + '-btn-panel');
    if (b) b.classList.toggle('is-active', panelOpen);
    if (panelOpen) updatePanel();
  }

  function mkPanelBtn(txt, fn) {
    var b = el('button', NS + '-panel-btn', txt);
    b.type = 'button';
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
    return b;
  }

  function updatePanel() {
    var p = document.getElementById(NS + '-panel');
    if (!p) return;
    var list = p.querySelector('.' + NS + '-panel-list');
    if (!list) return;
    list.innerHTML = '';

    var items = state.notes.slice().sort(function (a, b) {
      if (a.kind !== b.kind) return a.kind === 'spec' ? -1 : 1;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
    if (!items.length) {
      list.appendChild(el('div', NS + '-panel-empty', '还没有备注。点「+ 备注」开始。'));
      return;
    }
    items.forEach(function (n, i) {
      var k = KINDS[n.kind] || KINDS.spec;
      var row = el('div', NS + '-panel-row');
      var idx = el('span', NS + '-panel-idx', String(i + 1));
      idx.style.background = n.color || k.color;
      row.appendChild(idx);
      row.appendChild(el('span', NS + '-panel-text', n.text || '(空)'));
      row.appendChild(el('span', NS + '-panel-tag', k.label));
      var acts = el('span', NS + '-panel-acts');
      acts.appendChild(mkPanelBtn('定位', function () { locate(n.id); }));
      acts.appendChild(mkPanelBtn(n.kind === 'todo' ? '转正式' : '转待办', function () {
        setKind(n.id, n.kind === 'todo' ? 'spec' : 'todo');
      }));
      if (n.kind === 'todo') {
        acts.appendChild(mkPanelBtn(n.done ? '重开' : '完成', function () {
          n.done = !n.done; renderNotes(); touch();
        }));
      }
      acts.appendChild(mkPanelBtn('删', function () { removeNote(n.id); }));
      row.appendChild(acts);
      list.appendChild(row);
    });
  }

  function locate(id) {
    state.showTodo = true;
    renderNotes();
    var node = document.getElementById(NS + '-note-' + id);
    if (!node) return;
    var r = node.getBoundingClientRect();
    window.scrollTo({ top: Math.max(0, r.top + window.scrollY - window.innerHeight / 2), behavior: 'smooth' });
    node.classList.add(NS + '-note-flash');
    setTimeout(function () { node.classList.remove(NS + '-note-flash'); }, 1400);
  }

  function buildPanel() {
    if (document.getElementById(NS + '-panel')) return;
    var p = el('div', NS + '-panel');
    p.id = NS + '-panel';
    p.style.display = 'none';

    var head = el('div', NS + '-panel-head');
    head.appendChild(el('span', NS + '-panel-title', '备注清单'));
    var acts = el('span', NS + '-panel-head-acts');
    var cl = el('button', NS + '-panel-btn', '关闭');
    cl.type = 'button';
    cl.addEventListener('click', togglePanel);
    acts.appendChild(cl);
    head.appendChild(acts);
    p.appendChild(head);
    p.appendChild(el('div', NS + '-panel-list'));
    (document.body || document.documentElement).appendChild(p);
  }

  /* ------------------------------------------------- 展示模式的迷你浮标 */
  var dockOpen = false;
  function buildDock() {
    if (document.getElementById(NS + '-dock')) return;
    var d = el('div', NS + '-dock');
    d.id = NS + '-dock';
    var btn = el('button', NS + '-dock-btn', '');
    btn.type = 'button';
    btn.id = NS + '-dock-btn';
    btn.addEventListener('click', function () {
      dockOpen = !dockOpen;
      d.classList.toggle('is-open', dockOpen);
      btn.textContent = dockOpen ? '收起' : '备注 ' + state.notes.length;
    });
    d.appendChild(btn);
    var list = el('div', NS + '-dock-list');
    list.id = NS + '-dock-list';
    d.appendChild(list);
    (document.body || document.documentElement).appendChild(d);
    btn.textContent = '备注 ' + state.notes.length;
  }

  function updateDock() {
    var list = document.getElementById(NS + '-dock-list');
    var btn = document.getElementById(NS + '-dock-btn');
    if (!list) return;
    if (!dockOpen && btn) btn.textContent = '备注 ' + state.notes.length;
    list.innerHTML = '';
    if (!state.notes.length) {
      list.appendChild(el('div', NS + '-panel-empty', '无备注'));
      return;
    }
    state.notes.slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); })
      .forEach(function (n, i) {
        var k = KINDS[n.kind] || KINDS.spec;
        var row = el('div', NS + '-panel-row');
        var idx = el('span', NS + '-panel-idx', String(i + 1));
        idx.style.background = n.color || k.color;
        row.appendChild(idx);
        row.appendChild(el('span', NS + '-panel-text', n.text || '(空)'));
        row.appendChild(el('span', NS + '-panel-tag', k.label));
        list.appendChild(row);
      });
  }

  /* ---------------------------------------------------------------- 样式 */
  var CSS = [
    '.' + NS + '-layer{position:absolute;inset:0;pointer-events:none;z-index:2147482000;}',
    '.' + NS + '-note{position:absolute;pointer-events:auto;min-width:150px;max-width:280px;border:1px solid;',
    'border-radius:2px 2px 10px 10px;padding:8px 10px 10px;box-shadow:0 3px 10px rgba(0,0,0,.18);',
    'font:13px/1.65 "Microsoft YaHei","PingFang SC",-apple-system,"Segoe UI",sans-serif;}',
    '.' + NS + '-note-spec{transform:rotate(-1.2deg);}',
    '.' + NS + '-note-todo{transform:rotate(1deg);}',
    '.' + NS + '-note-dragging{box-shadow:0 8px 22px rgba(0,0,0,.28);z-index:10;}',
    '.' + NS + '-note-flash{animation:' + NS + '-flash 1.4s ease;}',
    '@keyframes ' + NS + '-flash{0%,100%{outline:0}25%,60%{outline:3px solid #165DFF;outline-offset:2px}}',
    '.' + NS + '-note-kind{font-size:11px;opacity:.72;display:block;margin-bottom:3px;}',
    '.' + NS + '-note-text{white-space:pre-wrap;word-break:break-word;outline:none;min-height:18px;}',
    '.' + NS + '-note-text[contenteditable="true"]{background:rgba(255,255,255,.55);border-radius:3px;}',
    '.' + NS + '-note-tools{position:absolute;top:4px;right:5px;display:none;gap:2px;}',
    '.' + NS + '-note:hover .' + NS + '-note-tools{display:flex;}',
    '.' + NS + '-note-tool{border:none;background:rgba(255,255,255,.6);cursor:pointer;font-size:12px;',
    'padding:1px 4px;border-radius:3px;color:inherit;}',
    '.' + NS + '-note-tool:hover{background:#fff;}',
    '.' + NS + '-note-done{opacity:.5;}',
    '.' + NS + '-note-done .' + NS + '-note-text{text-decoration:line-through;}',

    '.' + NS + '-bar{position:fixed;top:0;right:14px;z-index:2147483000;display:flex;align-items:center;gap:8px;',
    'padding:8px 12px;background:#fff;border:1px solid rgba(0,0,0,.15);border-radius:10px;',
    'box-shadow:0 4px 16px rgba(0,0,0,.12);font:13px/1.5 "Microsoft YaHei","PingFang SC",-apple-system,"Segoe UI",sans-serif;}',
    '.' + NS + '-bar-title{font-weight:500;color:#1f2329;padding-right:2px;}',
    '.' + NS + '-kind{font:13px/1.5 inherit;padding:4px 6px;border:1px solid rgba(0,0,0,.15);border-radius:6px;background:#fff;}',
    '.' + NS + '-btn{font:13px/1.5 inherit;padding:5px 10px;border:1px solid rgba(0,0,0,.15);border-radius:6px;',
    'background:#fff;color:#1f2329;cursor:pointer;white-space:nowrap;}',
    '.' + NS + '-btn:hover{background:#f3f5f8;}',
    '.' + NS + '-btn.is-active{background:#165DFF;border-color:#165DFF;color:#fff;}',
    '.' + NS + '-btn-ghost{color:#4e5969;}',
    '.' + NS + '-status{color:#86909c;font-size:12px;min-width:0;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.' + NS + '-status.is-err{color:#f53f3f;}',

    '.' + NS + '-panel{position:fixed;top:52px;right:14px;width:440px;max-height:72vh;z-index:2147483100;',
    'background:#fff;border:1px solid rgba(0,0,0,.15);border-radius:10px;',
    'box-shadow:0 8px 28px rgba(0,0,0,.16);overflow:hidden;flex-direction:column;',
    'font:13px/1.5 "Microsoft YaHei","PingFang SC",-apple-system,"Segoe UI",sans-serif;}',
    '.' + NS + '-panel-head{display:flex;align-items:center;padding:10px 12px;border-bottom:1px solid rgba(0,0,0,.08);}',
    '.' + NS + '-panel-title{font-weight:500;color:#1f2329;}',
    '.' + NS + '-panel-head-acts{margin-left:auto;display:flex;gap:6px;}',
    '.' + NS + '-panel-list{overflow:auto;padding:6px;}',
    '.' + NS + '-panel-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;}',
    '.' + NS + '-panel-row:hover{background:#f5f7fa;}',
    '.' + NS + '-panel-idx{flex:none;width:20px;height:18px;border-radius:4px;font-size:11px;line-height:18px;',
    'text-align:center;color:#412402;}',
    '.' + NS + '-panel-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#1f2329;}',
    '.' + NS + '-panel-tag{flex:none;font-size:11px;color:#86909c;}',
    '.' + NS + '-panel-acts{flex:none;display:none;gap:4px;}',
    '.' + NS + '-panel-row:hover .' + NS + '-panel-acts{display:flex;}',
    '.' + NS + '-panel-btn{font:12px/1.5 inherit;padding:3px 7px;border:1px solid rgba(0,0,0,.12);',
    'border-radius:5px;background:#fff;cursor:pointer;color:#4e5969;}',
    '.' + NS + '-panel-btn:hover{background:#f3f5f8;}',
    '.' + NS + '-panel-empty{padding:18px 8px;text-align:center;color:#86909c;font-size:12px;}',

    '.' + NS + '-dock{position:fixed;right:14px;bottom:14px;z-index:2147483000;display:flex;flex-direction:column;',
    'align-items:flex-end;gap:6px;font:13px/1.5 "Microsoft YaHei","PingFang SC",-apple-system,"Segoe UI",sans-serif;}',
    '.' + NS + '-dock-btn{border:1px solid rgba(0,0,0,.15);background:rgba(255,255,255,.94);color:#4e5969;',
    'padding:5px 11px;border-radius:14px;cursor:pointer;font:12px/1.5 inherit;box-shadow:0 2px 8px rgba(0,0,0,.1);}',
    '.' + NS + '-dock-btn:hover{background:#fff;color:#165DFF;}',
    '.' + NS + '-dock-list{width:320px;max-height:52vh;overflow:auto;background:#fff;border:1px solid rgba(0,0,0,.15);',
    'border-radius:10px;box-shadow:0 8px 26px rgba(0,0,0,.16);padding:6px;display:none;}',
    '.' + NS + '-dock.is-open .' + NS + '-dock-list{display:block;}',
    '.' + NS + '-dock.is-open .' + NS + '-dock-btn{color:#165DFF;border-color:#165DFF;}',

    'body.' + NS + '-editing,body.' + NS + '-editing *{cursor:crosshair !important;}'
  ].join('\n');

  function injectStyle() {
    if (document.getElementById(NS + '-style')) return;
    var s = document.createElement('style');
    s.id = NS + '-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ---------------------------------------------------------------- 启动 */
  var booted = false;
  function realBoot() {
    if (booted) return;
    booted = true;
    injectStyle();

    if (EDIT) {
      buildBar();
      buildPanel();
      document.addEventListener('click', onDocClick);
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && state.editing) setEditing(false);
      });
    } else {
      buildDock();
    }

    loadNotes().then(function () {
      renderNotes();
      watchDom();
      if (EDIT) {
        reportStatus(state.notes.length ? ('已加载 ' + state.notes.length + ' 条') : '点「+ 备注」开始贴');
      }
      post({ type: 'ready', count: state.notes.length });
    });
  }

  function boot() {
    // 编辑模式的唯一判据：宿主页注入了编辑凭证。
    // 该凭证只在「喂给工具 iframe」时存在，不落盘。
    EDIT = !!api;

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', realBoot);
    } else {
      realBoot();
    }
  }

  /* --------------------------------------------------------- 自动化测试口 */
  window.__AN__ = {
    state: state,
    addNoteAt: addNoteAt,
    removeNote: removeNote,
    startEdit: startEdit,
    setKind: setKind,
    render: renderNotes,
    setEditing: setEditing,
    setShowTodo: function (v) { state.showTodo = !!v; renderNotes(); },
    reflow: reflowAnchors,
    rebind: rebindAnchor,
    isEditMode: function () { return EDIT; },
    markBegin: MARK_BEGIN,
    markEnd: MARK_END
  };

  boot();
})();
