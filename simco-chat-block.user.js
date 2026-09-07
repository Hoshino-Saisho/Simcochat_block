// ==UserScript==
// @name         Sim Companies 聊天室屏蔽
// @namespace    https://github.com/
// @version      3.2.0
// @description  在游戏聊天室里屏蔽指定玩家：他发的消息不显示。只在聊天室生效，不采集、不上传、完全不联网。
// @author       -
// @match        https://www.simcompanies.com/*
// @match        https://simcompanies.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// @noframes
// ==/UserScript==
//
// 从「聊天记录归档」v2.4.0 改来的。
//
// ----------------------------------------------------------------------------
// 删掉了什么
// ----------------------------------------------------------------------------
// 采集那一整套全部删了：房间 API 路径、5 分钟一个槽位的限速、跨标签页抢锁、
// from-id 回溯补断档、本地按天存消息、GitHub 推送与合并、导出。
//
// ⚠️ 连带把这几个权限也删了，这不是顺手，是**这个脚本现在根本没有联网能力**：
//      @grant GM_xmlhttpRequest   ← 删了
//      @connect api.github.com    ← 删了
//      @grant GM_deleteValue / GM_listValues ← 删了（不再管理日文件）
//    权限留着而代码不用，等于"它随时可以联网，只是现在没有" ——
//    从外面看这两件事一模一样，而它们完全不是一回事。
//
// 留下的框架：GM 存储 + 跨标签页同步、悬浮面板、日志、被 SPA 路由删掉后自动重挂、
// 以及给 Node 离线自测用的导出。
//
// ----------------------------------------------------------------------------
// 新功能：屏蔽玩家（只在聊天室）
// ----------------------------------------------------------------------------
// ⚠️ 这里【不写死任何 class 名】。
//    游戏是打包过的 SPA，class 是构建产物（.sc-fzXfNJ 这种），下次发版就变。
//    写死的后果是最坏那种：脚本照常跑、面板照常显示"已屏蔽 3 人"，
//    但一条都没挡住 —— 而屏幕上没有任何一处会说它失效了。
//
//    所以改成【点一下学一次】：你点一下聊天里某个玩家的名字，脚本从那个节点
//    往上找出"一条消息"是哪一层、名字在里面怎么取，把这份"配方"记下来。
//    配方失效时面板会直接报出来，而不是安安静静地不干活。
//
(function () {
  'use strict';

  // ==========================================================================
  // 存储
  // ==========================================================================
  const K_BLOCK = 'blocklist';     // [{ name, at }]
  const K_RECIPE = 'recipe';       // { rowSel, nameSel, rootSel, learnedAt }
  const K_UI = 'ui_collapsed';

  const getBlock = () => GM_getValue(K_BLOCK, []);
  const setBlock = (v) => GM_setValue(K_BLOCK, v);
  const getRecipe = () => GM_getValue(K_RECIPE, null);
  const setRecipe = (v) => GM_setValue(K_RECIPE, v);

  /**
   * 名字归一化：去掉首尾空白、把连续空白压成一个、转小写。
   *
   * ⚠️ 大小写不敏感是【故意】的：手打名字时打错大小写，
   *    在"精确匹配"下会安安静静地一条都挡不住 —— 而面板上照样写着"已屏蔽"。
   *    宁可稍微宽一点，也不要一个看不见的失败。
   *    （面板上每个名字后面都有"刚挡了几条"，是 0 就一眼看得见。）
   */
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

  function isBlocked(name) {
    const n = norm(name);
    if (!n) return false;
    return getBlock().some((b) => norm(b.name) === n);
  }

  // ==========================================================================
  // 配方：一条消息长什么样，名字在哪儿
  // ==========================================================================

  /** 元素的选择器：标签 + 它自己的 class（不带 id，id 常是随机的）。 */
  function selOf(el) {
    if (!el || !el.tagName) return '';
    const cls = String(el.className || '').trim().split(/\s+/).filter(Boolean);
    return el.tagName.toLowerCase() + cls.map((c) => '.' + cssEsc(c)).join('');
  }
  /** class 里可能有 CSS 选择器的特殊字符，转义掉。 */
  function cssEsc(s) {
    return String(s).replace(/[^a-zA-Z0-9_ -￿-]/g, (c) => '\\' + c);
  }

  /** 兄弟里有几个"长得一样"的（同标签 + 同 class）。 */
  function alikeSiblings(el) {
    const p = el.parentElement;
    if (!p) return 0;
    const me = selOf(el);
    let n = 0;
    for (const c of Array.from(p.children || [])) if (selOf(c) === me) n++;
    return n;
  }

  /**
   * 从"被点到的名字元素"学出配方。
   *
   * 往上走，找第一个【有好几个长得一样的兄弟】的祖先 —— 那就是"一条消息"。
   * 消息列表天生是一串同构的兄弟，这个特征比任何 class 名都稳。
   *
   * ⚠️ 学完当场自检：拿学到的选择器从头找一遍，必须能找回刚才那个名字。
   *    不自检的话，学歪了要等到"怎么一条都没挡住"才发现，
   *    而那时候你根本分不清是学歪了还是名字打错了。
   */
  function learnFrom(nameEl) {
    if (!nameEl || !nameEl.tagName) return { err: '没点到元素上' };
    const text = String(nameEl.textContent || '').trim();
    if (!text) return { err: '点到的那个元素没有文字 —— 请点【玩家名字】那几个字' };
    if (text.length > 60) {
      return { err: '点到的那块文字太长（' + text.length + ' 字），八成点到整条消息了 —— 请只点玩家名字' };
    }

    let row = nameEl, hops = 0;
    while (row && hops < 12) {
      if (alikeSiblings(row) >= 3) break;
      row = row.parentElement; hops++;
    }
    if (!row || alikeSiblings(row) < 3) {
      return { err: '往上找了 ' + hops + ' 层也没找到"一条消息"—— ' +
                    '聊天里至少要有 3 条消息才学得出来，先等几条消息再学' };
    }

    const rowSel = selOf(row);
    const nameSel = selOf(nameEl);
    if (!rowSel || !nameSel) return { err: '这些节点没有 class，认不出来' };

    const rootSel = selOf(row.parentElement);
    const recipe = { rowSel, nameSel, rootSel, learnedAt: Date.now() };

    // ---- 自检 ----
    const probe = readRows(recipe);
    if (probe.err) return { err: '学完自检没过：' + probe.err };
    if (!probe.rows.length) return { err: '学完自检没过：按学到的选择器一条消息都找不到' };
    const hit = probe.rows.some((r) => norm(r.name) === norm(text));
    if (!hit) {
      return { err: '学完自检没过：找得到 ' + probe.rows.length +
                    ' 条消息，但里面没有刚点的「' + text + '」—— 名字的位置认错了' };
    }
    return { recipe, name: text, rows: probe.rows.length };
  }

  /**
   * 按配方把当前页面上的消息读出来。
   * 返回 { rows: [{el, name, inherited}], seen, named, inherited, err }
   *
   * ⚠️⚠️ 同一个人【连发】的几条会被聊天界面合并显示 —— 只有第一条带名字，
   *      后面那些行里根本没有名字那个节点。
   *
   *      3.0.0 在这儿直接 `continue` 跳过了它们，于是**那些消息永远挡不住**：
   *      屏蔽一个话痨，只有他每一串的第一条消失，后面照常刷屏。
   *      而面板上「挡了 N」还是个正数，看起来在干活。
   *
   *      现在改成：没有名字的行，**接着上一条有名字的算**（界面就是这么分组的）。
   *
   * ⚠️ 继承只在【同一个父节点里】延续。跨容器还接着用的话，
   *    上一个聊天框最后一个人的名字会漏到下一个框的开头去。
   */
  function readRows(recipe) {
    const empty = { rows: [], seen: 0, named: 0, inherited: 0 };
    if (!recipe || !recipe.rowSel) return Object.assign({ err: '还没学过结构' }, empty);
    /*
     * ⚠️ 先找【学到的那个容器】，再在容器里面找消息 —— 不在整个文档里瞎找。
     *
     *    真页面上 class 是打包生成的，聊天列表外面撞上同名 class 很正常。
     *    在整个文档里找的话，撞上的那些行会一起被扫进来：
     *    「看到 N 条」凭空变大，更糟的是名字对上了就把页面别处的东西也藏了。
     *
     *    容器没 class（选择器只剩个 div）时退回全文档找 —— 那种情况下
     *    限定范围反而会把真正的聊天也框掉。面板上会写明是哪一种。
     */
    let all;
    try {
      const scoped = recipe.rootSel && /\./.test(recipe.rootSel);
      if (scoped) {
        all = [];
        for (const box of Array.from(document.querySelectorAll(recipe.rootSel))) {
          all = all.concat(Array.from(box.querySelectorAll(recipe.rowSel)));
        }
      } else {
        all = Array.from(document.querySelectorAll(recipe.rowSel));
      }
    } catch (e) {
      return Object.assign({ err: '选择器不合法：' + e.message }, empty);
    }
    const rows = [];
    let named = 0, inherited = 0, lastName = '', lastParent = null;
    for (const el of all) {
      if (el.parentElement !== lastParent) { lastName = ''; lastParent = el.parentElement; }
      let ne = null;
      try { ne = el.querySelector(recipe.nameSel); } catch (e) { /* 下面统一报 */ }
      const txt = ne ? String(ne.textContent || '').trim() : '';
      if (txt) {
        named++; lastName = txt;
        rows.push({ el, name: txt, inherited: false });
      } else {
        inherited++;
        rows.push({ el, name: lastName, inherited: true });
      }
    }
    return { rows, seen: all.length, named, inherited };
  }

  // ==========================================================================
  // 屏蔽
  // ==========================================================================
  const MARK = 'scbHidden';        // dataset 上的标记
  let LAST = { hidden: 0, seen: 0, named: 0, inherited: 0, perName: {}, err: null };

  /**
   * 跑一遍：该藏的藏起来，不该藏的放回去。
   *
   * ⚠️ 只【隐藏】，绝不删节点。删了的话游戏自己的滚动、未读计数、
   *    以及 React 下一次 diff 全都会出问题，而表现出来是"聊天偶尔卡住"，
   *    根本没人会想到是屏蔽脚本干的。
   *
   * ⚠️ 每次都要把不再匹配的放回去 —— 只做"藏"不做"放"的话，
   *    取消屏蔽之后旧消息永远不回来，你会以为取消没生效。
   */
  function apply() {
    const recipe = getRecipe();
    if (!recipe) { LAST = { hidden: 0, seen: 0, named: 0, inherited: 0, perName: {}, err: null }; return LAST; }

    const r = readRows(recipe);
    if (r.err) { LAST = { hidden: 0, seen: 0, named: 0, inherited: 0, perName: {}, err: r.err }; return LAST; }

    /*
     * ⚠️ 配方失效的判据是**一条名字都读不出来**，不是"读出来的比例低"。
     *
     *    3.0.0 写的是 `named / seen < 0.5` —— 而连发合并本来就会让
     *    一大半的行没有名字（那是正常的）。于是话多的时候会**误报失效**，
     *    误报之后 apply 直接不干活：屏蔽整个失灵，面板上还说是"游戏改版了"。
     *    比例判据在这里是错的。
     */
    let err = null;
    if (r.seen >= 3 && r.named === 0) {
      err = '找到 ' + r.seen + ' 条消息，但一条名字都读不出来 —— ' +
            '游戏大概改版了。点「＋ 屏蔽一个人」再点一次那个人的名字就好。';
    }

    const perName = {};
    let hidden = 0;
    for (const { el, name } of r.rows) {
      const block = !err && isBlocked(name);
      if (block) {
        if (el.dataset[MARK] !== '1') { el.dataset[MARK] = '1'; el.style.display = 'none'; }
        hidden++;
        const k = norm(name);
        perName[k] = (perName[k] || 0) + 1;
      } else if (el.dataset[MARK] === '1') {
        delete el.dataset[MARK];
        el.style.display = '';
      }
    }
    LAST = { hidden, seen: r.seen, named: r.named, inherited: r.inherited, perName, err };
    return LAST;
  }

  /** 取消屏蔽 / 卸载时，把藏起来的全放回来。 */
  function unhideAll() {
    const recipe = getRecipe();
    if (!recipe) return 0;
    let n = 0;
    const r = readRows(recipe);
    for (const { el } of r.rows) {
      if (el.dataset[MARK] === '1') { delete el.dataset[MARK]; el.style.display = ''; n++; }
    }
    return n;
  }

  function addBlock(name) {
    const n = String(name || '').trim();
    if (!n) return { err: '名字是空的' };
    if (isBlocked(n)) return { err: '「' + n + '」已经在名单里了' };
    const list = getBlock();
    list.push({ name: n, at: Date.now() });
    setBlock(list);
    return { ok: true, name: n };
  }

  function removeBlock(name) {
    const n = norm(name);
    const list = getBlock().filter((b) => norm(b.name) !== n);
    setBlock(list);
    unhideAll();          // 先全放回来，下一趟 apply 再把该藏的藏回去
    return list.length;
  }

  // ==========================================================================
  // 点选屏蔽
  // ==========================================================================
  let picking = null;      // 'block' | 'learn' | null

  /**
   * ⚠️ 用【捕获阶段】并且吞掉这一次点击。
   *    不吞的话，点玩家名字会同时触发游戏自己的"打开这个公司"，
   *    页面当场跳走 —— 屏蔽是加上了，但你看不见任何反馈。
   */
  function onPick(e) {
    if (!picking) return;
    const el = e.target;

    /*
     * ⚠️ 面板【自己】身上的点击不算选人。
     *    不挡的话，开着点选状态再去点那个按钮（想取消），这个捕获监听会先抢到，
     *    然后一本正经地去"学"面板按钮的结构 —— 面板里的按钮也是一串同构兄弟，
     *    学出来的配方看着还挺像样。等你发现不对，真正的配方已经被这份垃圾覆盖了。
     */
    if ($panel && $panel.contains && $panel.contains(el)) return;

    picking = null;
    e.preventDefault(); e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();

    const res = learnFrom(el);
    if (res.err) { log('error', res.err); refresh(); return; }

    /*
     * 每次点选都【顺带把结构重认一遍】—— 所以没有单独的"学结构"按钮。
     * 游戏改版之后，你照常点一次那个人的名字，配方自己就更新了。
     */
    setRecipe(res.recipe);
    log('info', '认出：一条消息 = ' + res.recipe.rowSel + '　名字 = ' + res.recipe.nameSel +
                '（当前 ' + res.rows + ' 条）');
    const a = addBlock(res.name);
    log(a.err ? 'warn' : 'info', a.err || ('已屏蔽「' + a.name + '」'));
    apply(); refresh(true);
  }

  /** Esc 取消点选。不给退路的话，开了之后只能硬点一下别处才结束。 */
  function onKey(e) {
    if (picking && (e.key === 'Escape' || e.key === 'Esc')) {
      picking = null; log('info', '取消点选'); refresh();
    }
  }

  // ==========================================================================
  // 界面（从归档版原样留下来的框架）
  // ==========================================================================
  const LOGS = [];
  const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
  function log(level, msg) {
    LOGS.unshift({ level, line: `[${hhmm(Date.now())}] ${msg}` });
    if (LOGS.length > 60) LOGS.pop();
    (console[level] || console.log)('[SimcoBlock]', msg);
    renderLogs();
  }

  /*
   * ⚠️⚠️ 面板【建一次】，之后只改变化的那几个字。
   *
   *    3.0.0 是每 1.5 秒把整个 $body 清空重建一遍。后果有两个，你两个都撞上了：
   *      · 正在输入的名字被连人带框换掉 —— 打到一半就没了
   *      · 展开/折叠、光标位置这些也一起丢
   *    这和"每次重画都把滚动条弹回顶上"是同一类错：
   *    **重建整块 DOM 是最省事的写法，代价全落在正在操作的人身上。**
   *
   *    现在：结构建一次，refresh() 只写状态那一行的文字和每个名字后面的计数；
   *    名单只在【真的变了】的时候才重建（用一个签名比对）。
   */
  let $panel, $head, $body, $state, $rows, $pick, $logs;
  let collapsed = GM_getValue(K_UI, false);
  let listSig = null;
  const css = (el, o) => (Object.assign(el.style, o), el);
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    for (const k of kids) if (k) e.append(k);
    return e;
  }
  function btn(label, fn, tone) {
    const b = css(h('button', { textContent: label }), {
      margin: '2px 4px 2px 0', padding: '3px 8px', fontSize: '11px', cursor: 'pointer',
      background: tone === 'on' ? 'rgba(252,198,86,.22)' : 'rgba(255,255,255,.1)',
      color: tone === 'on' ? '#fc6' : '#e6e6e6',
      border: '1px solid ' + (tone === 'on' ? 'rgba(252,198,86,.5)' : 'rgba(255,255,255,.18)'),
      borderRadius: '4px',
    });
    b.onclick = fn; return b;
  }

  function buildUI() {
    $panel = css(h('div'), {
      position: 'fixed', right: '12px', bottom: '12px', zIndex: 2147483000,
      font: '12px/1.55 ui-monospace,Menlo,Consolas,monospace',
      background: 'rgba(18,20,26,.95)', color: '#e6e6e6', borderRadius: '8px',
      boxShadow: '0 4px 22px rgba(0,0,0,.5)', overflow: 'hidden',
      border: '1px solid rgba(255,255,255,.12)',
    });
    /*
     * ⚠️ 折叠起来要变成【一个小条】，不是把内容藏起来却还占着 320px。
     *    3.0.0 就是后者 —— 面板"缩小"之后还是那么宽，等于没缩。
     */
    $head = css(h('div'), {
      padding: '6px 10px', cursor: 'pointer', background: 'rgba(255,255,255,.07)',
      userSelect: 'none', fontWeight: '600', whiteSpace: 'nowrap',
    });
    $head.onclick = () => {
      collapsed = !collapsed; GM_setValue(K_UI, collapsed);
      layout(); refresh(true);
    };
    $body = css(h('div'), { padding: '8px 10px' });
    $state = css(h('div'), { marginBottom: '6px' });

    /*
     * ⚠️ 按钮上写什么，一律由 refresh() 从 `picking` 推出来 —— **不在点击处理器里写第二遍**。
     *
     *    3.1.0 就是写了两遍：点击时在闭包里改按钮文字，而选完之后
     *    onPick 只把 `picking` 置回 null。于是选完一个人，按钮永远停在
     *    「👆 去点一个玩家名字…」上 —— 状态和显示各说各的，两边各自看都对。
     *
     *    这就是"一条规则活在两个地方"的老毛病：状态只有一个来源，
     *    显示只从那个来源推。
     */
    const bar = css(h('div'), { marginBottom: '6px' });
    $pick = btn('', () => { picking = picking ? null : 'block'; refresh(); });
    bar.append($pick);

    $rows = css(h('div'), {});
    $body.append($state, bar, $rows);

    $logs = css(h('div'), {
      maxHeight: '110px', overflowY: 'auto', borderTop: '1px solid rgba(255,255,255,.1)',
      padding: '6px 10px',
    });
    $panel.append($head, $body, $logs);
    document.body.appendChild($panel);
    layout();
  }

  function layout() {
    if (!$panel) return;
    $panel.style.width = collapsed ? 'auto' : '320px';
    $body.style.display = $logs.style.display = collapsed ? 'none' : 'block';
  }

  /** 状态那一行怎么说。三种"没生效"必须分开，见说明。 */
  function stateLine() {
    if (!getRecipe()) return ['还没屏蔽过谁 —— 点下面那个按钮，再点聊天里的名字', '#fc6'];
    if (LAST.err) return ['⚠️ ' + LAST.err, '#f7a'];
    if (LAST.seen === 0) return ['现在页面上没有聊天（不在聊天室）', '#9aa'];
    return ['生效中 · 看到 ' + LAST.seen + ' 条' +
            (LAST.inherited ? '（' + LAST.inherited + ' 条接上一条的名字）' : '') +
            ' · 挡掉 ' + LAST.hidden + ' 条', '#8fd'];
  }

  /**
   * 只改变化的那几处。
   * @param {boolean} force 名单本身变了（加/删）时传 true，强制重建名单那一块
   */
  function refresh(force) {
    if (!$panel) return;
    const list = getBlock();

    // 折叠时只写标题那一条
    const nHid = LAST.hidden || 0;
    $head.textContent = collapsed
      ? '🚫 ' + list.length + ' 人 · 挡 ' + nHid + '　▸'
      : '🚫 聊天屏蔽　▾';
    if (collapsed) return;

    const [txt, color] = stateLine();
    if ($state.textContent !== txt) $state.textContent = txt;
    $state.style.color = color;

    // 按钮状态【只从 picking 推】—— 见 buildUI 里那段
    const on = picking === 'block';
    const label = on ? '👆 去聊天里点那个人的名字（Esc 取消）' : '＋ 屏蔽一个人';
    if ($pick.textContent !== label) $pick.textContent = label;
    $pick.style.color = on ? '#fc6' : '#e6e6e6';
    $pick.style.background = on ? 'rgba(252,198,86,.22)' : 'rgba(255,255,255,.1)';
    $pick.style.borderColor = on ? 'rgba(252,198,86,.5)' : 'rgba(255,255,255,.18)';

    /*
     * ⚠️ 名单只在【真的变了】的时候重建。
     *    每次都重建的话，鼠标正悬在某个 ✕ 上会被换掉，点不中。
     */
    const sig = list.map((b) => b.name).join('\u0001');
    if (force || sig !== listSig) {
      listSig = sig;
      $rows.textContent = '';
      if (!list.length) {
        $rows.append(css(h('div', { textContent: '名单是空的。' }), { color: '#889' }));
      } else {
        for (const b of list) {
          const line = css(h('div'), {
            display: 'flex', alignItems: 'center', gap: '6px', padding: '1px 0',
          });
          const nameEl = css(h('span', { textContent: b.name }), { flex: '1' });
          /*
           * ⚠️ 计数那个 span 存成 line._cnt，下面每一拍【只改它的文字】。
           *    不留引用的话就只能重建整行，那又回到"重建整块 DOM"的老路上。
           */
          const cnt = css(h('span'), { fontSize: '11px' });
          line._cnt = cnt; line._name = b.name;
          line.append(nameEl, cnt, btn('✕', () => {
            removeBlock(b.name); log('info', '取消屏蔽「' + b.name + '」');
            apply(); refresh(true);
          }));
          $rows.append(line);
        }
      }
    }
    // 每一拍都刷计数（这就是"挡了 N"要显示实际数据的地方）
    for (const line of $rows.children || []) {
      if (!line._cnt) continue;
      const n = LAST.perName[norm(line._name)] || 0;
      const t = '挡了 ' + n;
      if (line._cnt.textContent !== t) line._cnt.textContent = t;
      line._cnt.style.color = n ? '#8fd' : '#889';
    }

    renderLogs();
  }
  // 老名字留个别名，boot 和点选那边还在用
  const render = refresh;

  function renderLogs() {
    if (!$logs) return;
    $logs.textContent = '';
    for (const l of LOGS.slice(0, 8)) {
      $logs.append(css(h('div', { textContent: l.line }), {
        color: l.level === 'error' ? '#f7a' : l.level === 'warn' ? '#fc6' : '#9aa',
      }));
    }
  }

  // ==========================================================================
  // 启动
  // ==========================================================================
  function boot() {
    buildUI();
    log('info', '启动 · 只在聊天室生效 · 不采集、不上传、没有联网权限');

    // 点选：捕获阶段，抢在游戏自己的处理之前
    document.addEventListener('click', onPick, true);
    document.addEventListener('keydown', onKey, true);

    /*
     * 游戏是单页应用，路由切换时可能把面板一起删掉 —— 掉了就补回去。
     * （这一段是从归档版原样留下来的，那边真踩过。）
     */
    setInterval(() => {
      if ($panel && document.body && !document.body.contains($panel)) {
        document.body.appendChild($panel);
        log('warn', '面板被页面移除，已重新挂载');
      }
    }, 5000);

    /*
     * ⚠️ MutationObserver ＋ 定时器【两个都要】。
     *    只靠 observer：React 有时候是复用节点改属性，我们设的 display:none
     *    会被它的下一次 diff 抹掉，而那次改动未必触发我们订阅的那类 mutation。
     *    只靠定时器：新消息要等下一拍才被挡，会闪一下。
     *
     * ⚠️ observer 里【不要直接 apply】—— 一屏消息进来能触发几十次回调，
     *    每次都跑一遍全量扫描会把页面拖住。合并到下一帧跑一次。
     */
    let pending = false;
    const soon = () => {
      if (pending) return;
      pending = true;
      const run = () => { pending = false; apply(); refresh(); };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else setTimeout(run, 0);
    };
    try {
      const mo = new MutationObserver(soon);
      mo.observe(document.body, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ['style', 'class'],
      });
    } catch (e) { log('warn', 'MutationObserver 起不来：' + e.message); }

    /*
     * ⚠️ 兜底那一拍从 1500ms 提到 250ms。
     *    1.5 秒的后果你已经撞上了：切回聊天时先看见一整屏本该屏蔽的消息，
     *    过一秒多才消失 —— 而"闪一下"和"根本没挡住"在当下分不清。
     *    这一拍只做 apply，很轻（一次 querySelectorAll + 遍历），
     *    面板的重绘由 refresh 自己判断有没有变化。
     */
    setInterval(soon, 250);

    /*
     * ⚠️ 切标签页 / 切路由回来时立刻跑一次 —— 后台标签页里
     *    requestAnimationFrame 和定时器都会被浏览器压到很慢甚至停掉，
     *    回来的第一眼恰恰是最容易看见漏网消息的时刻。
     */
    try {
      document.addEventListener('visibilitychange', () => { if (!document.hidden) soon(); });
      window.addEventListener('focus', soon);
    } catch (e) {}

    try { GM_addValueChangeListener(K_BLOCK, (_k, _o, _n, remote) => {
      if (remote) { unhideAll(); apply(); refresh(true); }
    }); } catch (_) {}

    apply(); refresh(true);
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.body ? boot() : window.addEventListener('DOMContentLoaded', boot);
  }

  // 仅供 Node 下的离线自测使用；浏览器里 module 未定义，这行是死代码。
  if (typeof module !== 'undefined' && module.exports)
    module.exports = { norm, isBlocked, addBlock, removeBlock, getBlock, setBlock,
                       getRecipe, setRecipe, learnFrom, readRows, apply, unhideAll,
                       selOf, alikeSiblings, K_BLOCK, K_RECIPE,
                       buildUI, refresh, stateLine,
                       __ui: () => ({ panel: $panel, head: $head, body: $body,
                                      state: $state, rows: $rows, pick: $pick }),
                       __collapse: (v) => { collapsed = v; layout(); },
                       __pick: (v) => { if (v !== undefined) picking = v; return picking; },
                       onPick, onKey };
})();
