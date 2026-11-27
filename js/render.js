/*
 * render.js —— 渲染层
 *
 * 纯函数式的 DOM 构建：每个函数只负责往容器里填内容，不读写业务状态。
 *
 * 一条贯穿全文件的规矩：**所有来自模型或用户的文本都走 textContent 或
 * createTextNode，绝不用字符串拼 HTML。**
 * 模型的返回是外部输入，用户的问题也是外部输入，只要有一处用 innerHTML 拼接，
 * 就给了 XSS 一个入口。这里宁可多写几行 createElement。
 */
(function (root) {
  'use strict';

  var Tarot = root.Tarot = root.Tarot || {};
  var Cards = Tarot.Cards;

  /* ------------------------------------------------------------------ *
   * 基础 DOM 工具
   * ------------------------------------------------------------------ */

  /**
   * 建元素。
   * @param {string} tag
   * @param {string} [className]
   * @param {(string|Node)} [text] 文本内容（走 textContent，安全）
   * @returns {HTMLElement}
   */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** 清空容器 */
  function clear(container) {
    while (container.firstChild) container.removeChild(container.firstChild);
  }

  /** 取元素 */
  function $(id) {
    return document.getElementById(id);
  }

  /* ------------------------------------------------------------------ *
   * 牌阵与牌库选择
   * ------------------------------------------------------------------ */

  /**
   * 渲染牌阵选择卡片。
   */
  /**
   * 渲染牌阵选择卡片。
   *
   * 张数由牌阵决定，所以每张卡片上标着「几张」就是这条信息本身，
   * 不再需要额外的「和你的张数对比」之类标注。
   *
   * @param {HTMLElement} container
   * @param {string} activeKey
   * @param {(key: string) => void} onPick
   */
  function renderSpreadList(container, activeKey, onPick) {
    clear(container);
    Tarot.Spreads.all.forEach(function (spread) {
      var count = spread.positions.length;
      var button = el('button', 'spread-card' + (spread.key === activeKey ? ' is-active' : ''));
      button.type = 'button';
      button.setAttribute('data-spread', spread.key);

      var top = el('div', 'sc-top');
      top.appendChild(el('span', 'sc-name', spread.name));
      top.appendChild(el('span', 'sc-count', count + ' 张'));
      button.appendChild(top);

      button.appendChild(el('span', 'sc-sub', spread.subtitle));
      button.appendChild(el('span', 'sc-blurb', spread.blurb));

      button.addEventListener('click', function () { onPick(spread.key); });
      container.appendChild(button);
    });
  }

  /**
   * 渲染牌库选择。
   */
  function renderDeckOptions(container, activeKey, onPick) {
    clear(container);
    Object.keys(Tarot.Engine.decks).forEach(function (key) {
      var deck = Tarot.Engine.decks[key];
      var chip = el('button', 'deck-chip' + (key === activeKey ? ' is-active' : ''), deck.label);
      chip.type = 'button';
      chip.title = deck.desc;
      chip.addEventListener('click', function () { onPick(key); });
      container.appendChild(chip);
    });
  }

  /* ------------------------------------------------------------------ *
   * 牌桌
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   * 牌桌的尺寸与定位
   *
   * 这一节全部使用**像素**，不用「百分比 × span」那种混合映射。
   *
   * 之前那套写法出过一个真实的错误：把比例映射（0-100 → span 像素）和
   * 像素留白（半张牌高 + 牌位名的高度）混在一个式子里算，两者量纲不同，
   * 于是「桌面要留多高」既受比例刻度影响、又受牌的像素尺寸影响，改一处就错。
   * 现在只保留一个单位：牌心的像素位置。牌位自带的比例坐标先折算成 px，
   * 追加牌那些大于 100 的坐标走同一套折算，任何值都能自然落进来。
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   * 尺寸系统
   *
   * 全部尺寸由**一个**函数算出来，再写进 CSS 变量供样式表使用。
   *
   * 为什么不各自维护：早先 JS 里写死 CARD_W=104、CSS 里写死 --card-w:104px，
   * 两处必须手工保持一致，为此还专门写了一条测试去比对。手机适配需要两套
   * 尺寸（桌面 / 窄屏），四处硬编码立刻就会走样——所以改成单一来源：
   * render.js 算，CSS 只消费。
   *
   * 卡片尺寸随可用宽度缩放，但不是简单地等比：纵向刻度（PX_PER_UNIT）固定，
   * 因为它决定牌阵的纵向跨度。实测 78 张量下来，桌面 2.2 是唯一能让所有牌阵
   * 都不重叠的值（关系牌阵需要 2.8、凯尔特十字需要 2.2、五张需要 1.6），
   * 所以它是硬约束，不能跟着屏幕缩。
   * ------------------------------------------------------------------ */

  var DESKTOP_CARD_W = 104;
  var DESKTOP_CARD_H = 166;
  var BASE_WIDTH_MAX = 900; // 牌桌基准宽的上限（桌面）
  /**
   * 从视口宽度推算基准宽时，要预留多少 px。
   *
   * 只在**量不到容器**时才会用到（见 estimateAvailableWidth）。逐项列清楚：
   *
   *   窄屏（≤640px）：页面 20 + 面板 26 + 牌区 12 = 58
   *   宽屏          ：页面 40 + 面板 44        = 84
   *
   * 这些值要和 styles.css 里各层的内边距对上：算小了牌桌会溢出、最右一列被裁；
   * 算大了牌桌铺不满容器，右侧多出空白（用户看到过「靠左、右边空白多」）。
   * 两端都出过问题，所以数字要贴着 CSS 取。
   */
  var SMALL_SIDE_LOSS = 58;
  var WIDE_SIDE_LOSS = 84;
  var MIN_BASE_WIDTH = 280; // 再窄就没有意义了
  /*
   * 牌阵纵向坐标的间距，单位数。
   *
   * 牌阵定义里的 y 坐标按它的倍数写（见 spreads.js：8 / 63 / 118 / 173，
   * 间隔 55）。它同时是自检阈值——判断两张牌够不够开。
   *
   * 它只是**坐标**尺度，不是像素尺度。行距实际有多少像素由 pxPerUnit 决定，
   * 两者相乘才是屏幕上看到的距离。
   */
  var COORD_ROW_UNITS = 55;

  /*
   * 行距的余量系数。
   *
   * 如果让行距**正好**等于「一张牌 + 牌下说明区」，上一行的说明区底边就会和
   * 下一行的牌面顶边相接、一点缝都没有——标签看起来像贴在下一行的牌上。
   *
   * 1.08 是实测出来的：手机上多出约 8px，桌面上约 16px，既不空也不挤。
   */
  var ROW_GAP_SLACK = 1.08;

  /*
   * 牌位名与朝向标签的度量，单位 px。
   *
   * 这几个值必须和 styles.css 里的 .slot-caption / .slot-orient 对齐——
   * computeMetrics 靠它们算「牌位名占多高」，进而决定纵向间距够不够。
   * 改了 CSS 忘了改这里，牌阵自检就会按错的数字判断。
   * verify-css.js 会核对它们与 CSS 是否一致。
   */
  var CAPTION_PAD_TOP = 10;
  var CAPTION_LINE_HEIGHT = 1.35;
  var ORIENT_LINE_HEIGHT = 1.4;
  var ORIENT_PAD_Y = 1;
  var ORIENT_MARGIN_TOP = 6;

  /** 当前视口宽度；在浏览器里由 applyMetrics 更新，Node 里由 setViewportWidth 指定 */
  var viewportWidth = 1024;
  /** 是否触摸设备。决定扇形每张要露出多少——手指比鼠标需要更大的目标 */
  var touchDevice = false;
  /** 实测到的牌桌可用宽度；0 表示量不到，退回按视口推算 */
  var measuredWidth = 0;

  /**
   * 量出牌桌真正能用的宽度。
   *
   * 这是主路径，因为「视口 → 可用宽度」之间的损耗全在 CSS 里（页面/面板/牌区
   * 的内边距、滚动条），JS 猜不准。实测一次比推算准确得多，也不用在改
   * 媒体查询时同步维护一个常量。
   *
   * 量不到就返回 0，由调用方退回推算——精简直的 DOM（比如测试替身）没有
   * 布局引擎，clientWidth 恒为 0，不能靠它。
   *
   * @returns {number}
   */
  /**
   * 从视口宽度推算牌区内容区宽度。
   *
   * 这是**回退路径**：量不到容器时才用。它把 CSS 里各层的内边距逐项减掉。
   *
   * 为什么要有这条路径：精简直的 DOM（测试替身）没有布局引擎，
   * clientWidth 恒为 0，量不出任何东西。真实浏览器里走的是实测那条。
   *
   * @param {number} view 视口宽度
   * @returns {number} 牌区内容区宽度
   */
  function estimateAvailableWidth(view) {
    var small = view <= 640;
    var loss = small
      ? SMALL_SIDE_LOSS     // 窄屏：页面 20 + 面板 26 + 牌区 12
      : WIDE_SIDE_LOSS;     // 桌面：页面 40 + 面板 44
    /*
     * 这里**不再**用 MIN_BASE_WIDTH 兜底。
     *
     * 兜底会把「可用宽度只有 222px」这种结果抬到 280，于是牌桌比容器还宽、
     * 右列被 overflow:hidden 裁掉。可用宽度是多少就返回多少——
     * 牌小一点总比内容被裁掉好。下限的裁决交给 computeMetrics（那里会判断
     * 可用宽度本来够不够）。
     */
    var w = view - loss;
    return w > 0 ? w : 0;
  }

  /**
   * 量出牌桌真正能用的宽度。
   *
   * 这是主路径，因为「视口 → 可用宽度」之间的损耗全在 CSS 里（页面/面板/牌区
   * 的内边距、滚动条），JS 猜不准。实测一次比推算准确得多。
   *
   * 量不到就返回 0，由调用方退回推算。
   *
   * @returns {number}
   */
  /**
   * 量一个容器元素的内容区宽度（减掉它自己的左右内边距）。
   *
   * 量不到（元素隐藏、没有布局引擎）返回 0。
   *
   * @param {HTMLElement} wrap
   * @returns {number}
   */
  function contentWidthOf(wrap) {
    if (!wrap) return 0;

    var cs = null;
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      cs = window.getComputedStyle(wrap);
    }
    var padL = cs ? (parseFloat(cs.paddingLeft) || 0) : 0;
    var padR = cs ? (parseFloat(cs.paddingRight) || 0) : 0;

    /*
     * clientWidth 是**含内边距**的宽度，而牌桌要放进的是内容区，
     * 所以要把左右内边距减掉。
     *
     * 这一条踩过坑：原来直接用 clientWidth，等于按「内容 + 12px」布局。
     * 窄屏下 .table-wrap 有 6px 的左右内边距，于是牌桌比内容区宽 12px，
     * 最右边那一列的牌被裁掉——用户看到的就是「右边的牌显示不全」。
     */
    var contentW = (Number(wrap.clientWidth) || 0) - padL - padR;
    if (contentW <= 80) return 0;

    /*
     * 再和父级面板的内容区取小值。
     *
     * 正常情况下两者一致，但窄屏媒体查询会给 .table-wrap 加上额外的左右内边距，
     * 那时它的 clientWidth 可能比面板内容区还大——取小值才不会让牌桌探出去。
     */
    var panel = wrap.parentNode;
    if (panel && typeof panel.clientWidth === 'number' && panel.clientWidth > 0) {
      var pcs = null;
      if (typeof window !== 'undefined' && window.getComputedStyle) {
        pcs = window.getComputedStyle(panel);
      }
      var pPadL = pcs ? (parseFloat(pcs.paddingLeft) || 0) : 0;
      var pPadR = pcs ? (parseFloat(pcs.paddingRight) || 0) : 0;
      var panelContentW = panel.clientWidth - pPadL - pPadR;
      if (panelContentW > 80 && panelContentW < contentW) contentW = panelContentW;
    }

    return contentW;
  }

  /**
   * 量出牌桌真正能用的宽度。
   *
   * 这是主路径，因为「视口 → 可用宽度」之间的损耗全在 CSS 里（页面/面板/牌区
   * 的内边距、滚动条），JS 猜不准。实测一次比推算准确得多。
   *
   * 量不到就返回 0，由调用方退回推算。
   *
   * **必须逐个试到「能量到」的那个为止**，不能只判断元素在不在。
   * 原来写的是 `querySelector('.table-wrap') || querySelector('.fan-wrap')`——
   * 那是「取第一个**存在**的元素」，而两个面板在初始状态下都带 hidden，
   * clientWidth 都是 0。于是：
   *   · 拿到隐藏的 .table-wrap，量出 0，直接返回 0
   *   · `||` 右边永远不会执行（元素是存在的，表达式为真）
   *   · 实测路径**在整个会话里几乎从不生效**，一直是推算值在兜底
   * 这跟「实测是主路径」的注释完全是两回事，也是排版反复出偏差的根源之一。
   *
   * @returns {number}
   */
  function measureAvailableWidth() {
    if (typeof document === 'undefined' || !document.querySelector) return 0;

    /*
     * 按「更可能已经显示出来」的顺序试。
     * 牌桌先于扇形出现（抽完牌才轮到牌桌），但两个都要试——
     * 挑牌阶段牌桌还是隐藏的，那时只有扇形量得到。
     */
    var selectors = ['.table-wrap', '.fan-wrap'];
    for (var i = 0; i < selectors.length; i++) {
      var w = contentWidthOf(document.querySelector(selectors[i]));
      if (w > 80) return w;
    }
    return 0;
  }

  /**
   * 按视口宽度算出这一套尺寸。
   *
   * @param {number} [vw] 视口宽度，默认用当前的
   * @param {boolean} [touch] 是否触摸设备，默认用当前的
   * @returns {Object} 所有尺寸
   */
  function computeMetrics(vw, touch) {
    /*
     * 视口宽度必须是有限正数。
     *
     * 不校验的后果是「静默崩塌」：NaN 一路传下去，baseWidth、cardW、pxPerUnit
     * 全变成 NaN，然后 setProperty 写进 CSS 变量的是 "NaNpx"——浏览器直接忽略，
     * 所有卡片退回 CSS 里的回退尺寸（84×134），页面看着像完全没适配。
     * 实测传 NaN 或 undefined 时会走到这一步，而且没有任何报错。
     *
     * 真到这一步说明调用方给了错的值（比如算宽度时除了零），
     * 退回当前已知的 viewportWidth 比让它崩掉好。
     */
    var given = Number(vw);
    var view = isFinite(given) && given > 0
      ? given
      : (isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1024);
    if (view < MIN_BASE_WIDTH) view = MIN_BASE_WIDTH;
    var isTouch = touch === undefined ? touchDevice : Boolean(touch);

    /*
     * 基准宽：优先用实测值。
     *
     * 两条路径的区别很关键，别把留白扣两次：
     *
     *   实测（measuredWidth > 0）——它是牌区的内容区宽度，各种内边距都已经
     *     体现过了，所以**直接用**，不能再减。
     *   推算（量不到时）——从视口宽度逐层减掉 CSS 里的内边距。
     *
     * 这里踩过一次：两条路径都减了一遍，于是实测 900 变成 860，
     * 牌桌平白窄了 40px，牌也跟着变小。
     */
    var available = measuredWidth > 0 ? measuredWidth : estimateAvailableWidth(view);
    var baseWidth = Math.min(BASE_WIDTH_MAX, available);

    /*
     * 兜底下限**不能把牌桌抬到比容器还宽**。
     *
     * 原来是 `if (baseWidth < MIN_BASE_WIDTH) baseWidth = MIN_BASE_WIDTH;`——
     * 无条件抬到 280。可可用宽度本来就比 280 窄时（视口 < 338px：老 iPhone SE
     * 的 320、Galaxy Fold 外屏的 280），这等于让牌桌探出容器，
     * 而 .table-wrap / .fan-wrap 都是 overflow: hidden——最右那一列直接被裁掉。
     *
     * 实测：320px 视口真实可用 262px，牌桌却按 280 布局，溢出 18px。
     *
     * 现在只在「可用宽度本来够」时才套用这个下限；本来就窄，就老实用可用宽度，
     * 让牌变小一点，而不是把内容推出屏幕。
     */
    if (baseWidth < MIN_BASE_WIDTH && available >= MIN_BASE_WIDTH) {
      baseWidth = MIN_BASE_WIDTH;
    }

    // 卡片占牌桌基准宽的比例来自桌面：104 / 900 ≈ 0.1156
    var cardW = Math.round(baseWidth * (DESKTOP_CARD_W / BASE_WIDTH_MAX));
    cardW = Math.max(56, Math.min(DESKTOP_CARD_W, cardW));

    // 高度保持桌面的比例（166 / 104），这样牌面构图不变
    var cardH = Math.round(cardW * (DESKTOP_CARD_H / DESKTOP_CARD_W));

    /*
     * 牌位名与朝向标签的尺寸。
     *
     * 这两个字号**必须和写进 CSS 变量的值一致**，否则 computeMetrics 里估算的
     * 「牌位名占多高」会和实际渲染出来的高度对不上——估算偏小就会让相邻两行
     * 压在一起，而牌阵自检是按估算值判的，它会放过这个压盖。
     *
     * 所以字号在这里算一次，返回值带出去，applyMetrics 直接用，
     * 不在两个地方各算一遍。
     */
    var captionFont = Math.max(9, Math.round(cardW * 0.106));
    var orientFont = Math.max(8, Math.round(cardW * 0.091));

    /*
     * 牌面内容的上下内边距。
     *
     * 按牌宽算，不写死。牌面上有五段文字要放，写死 7px 在手机上太薄——
     * 牌只有 89px 高，文字几乎贴着边框（用户反馈过「字快贴到牌的边框了」）。
     *
     * 下限 8px 是有意的：手机上 cardW 被 MIN_BASE_WIDTH 和字号下限托着，
     * 不再随屏幕缩，所以内边距也该停在一个不会太薄的量上。
     */
    var cardPadY = Math.max(8, Math.round(cardW * 0.085));
    var cardPadX = Math.max(6, Math.round(cardW * 0.058));

    /*
     * 牌面五段文字的字号，全部按牌宽算。
     *
     * 英文名和花色原来写死在 CSS 里（8.5px / 10px），是这里最大的坑：
     * 手机牌宽 56px、内容可用宽只有 44px，8.5px 的 "Knight of Pentacles"
     * 放不下一行就折成三行，把内容撑到 85px——而牌去掉内边距只剩 73px。
     * 实测 78 张牌里有 67 张溢出，表现就是文字叠在一起。
     *
     * 下限是有意的：屏宽继续变窄时牌宽被 MIN_BASE_WIDTH 托住，字号也不该
     * 无限缩下去，否则小到看不清。英文给到 6px 是还能辨认的极限。
     */
    var fontNum = Math.max(7, Math.round(cardW * 0.096));
    var fontGlyph = Math.max(16, Math.round(cardW * 0.25));
    var fontTitle = Math.max(9, Math.round(cardW * 0.125));
    var fontEn = Math.max(6, Math.round(cardW * 0.082 * 10) / 10);
    var fontSuit = Math.max(7, Math.round(cardW * 0.096));

    /*
     * 牌位名那一块的宽度。
     *
     * 这里必须加**上限**：牌位名不能宽于「最密的列间距」，否则同一行相邻的
     * 两个牌位名会重叠。
     *
     * 三张牌阵的列间距是牌桌宽的 28%（x = 22/50/78），是所有牌阵里最密的。
     * 极窄屏上会真的撞上：280px 视口真实可用 222px，而牌宽被下限托在 56px，
     * 按 1.15 倍算出的牌位名宽是 64px，比 62px 的列间距还宽——实测重叠 2px。
     *
     * 只在真的放不下时才缩（正常手机上 64px 远小于 84px 的间距，不受影响）。
     * 缩了之后文字会按 CSS 的 ellipsis 截断，但不会再压到隔壁。
     */
    var captionW = cardW * 1.15;
    var tightestGapPx = baseWidth * 0.28;
    if (captionW > tightestGapPx - 3) {
      captionW = Math.max(40, tightestGapPx - 3);
    }

    /*
     * 两个不同的高度，别混用：
     *   captionH      —— 牌位名这一块自己有多高（上内边距 + 一行文字）
     *   captionBlockH —— 牌下方整个说明区（牌位名 + 间距 + 朝向标签）
     *
     * 布局要的是后者（决定纵向够不够开），而 verify-layout.js 算矩形时
     * 用的是前者。曾经只有一个字段、两种含义轮着用，很容易算错。
     */
    var captionH = CAPTION_PAD_TOP + captionFont * CAPTION_LINE_HEIGHT;
    var orientH = orientFont * ORIENT_LINE_HEIGHT + 2 * ORIENT_PAD_Y + 2;
    var captionBlockH = captionH + ORIENT_MARGIN_TOP + orientH;

    var oneCardPx = cardH + captionBlockH;

    /*
     * 纵向刻度。
     *
     * 要分开两件事，它们看着像一回事，其实不是：
     *
     *   COORD_ROW_UNITS —— 牌阵定义里相邻两行**坐标**的间距（写死 55）。
     *       它是自检阈值 minDy：牌阵的 y 坐标按它写，自检按它判「够不够开」。
     *   pxPerUnit       —— 1 个单位等于多少像素。由它决定行距的**像素值**。
     *
     * 行距（像素）= COORD_ROW_UNITS × pxPerUnit。要让行距比「一张牌 + 说明区」
     * 略大一点（留出那道缝），就得让 pxPerUnit 略大——而**不能**去动
     * COORD_ROW_UNITS，否则坐标和阈值就脱钩了。
     *
     * 踩过的坑：曾经用一个常量同时当这两者，于是「行距」恒等于
     * `oneCardPx / 那个常量 × 那个常量` = oneCardPx，加多少余量都没用——
     * 实测出来上一行的说明区底边和下一行的牌面顶边正好相接、间隙 0px。
     */
    var pxPerUnit = oneCardPx / COORD_ROW_UNITS * ROW_GAP_SLACK;

    // 自检阈值就是坐标间距，不带余量——它判的是「坐标够不够开」
    var minDy = COORD_ROW_UNITS;
    var minDx = (cardW + 4) / baseWidth * 100;

    var padTop = Math.max(40, Math.round(cardH * 0.42));
    var bottomReserve = cardH / 2 + captionBlockH;

    /*
     * 待挑牌区的网格。
     *
     * 这里曾经是「弧形 + 重叠」的扇形，靠每张露出 22px 营造抹开的牌堆感。
     * 那个设计在手机上不成立：牌面只有几十像素宽，重叠后分不清哪张是哪张。
     * 现在改成网格——每张完整可见，一行放几张由屏宽决定，放不下就换行。
     *
     * 待挑的牌刻意比牌桌上的牌**小一号**（桌面 68 vs 104）。两个理由：
     *   1. 一行能放下的张数更多，78 张从 10 行降到 6 行
     *   2. 它本来就还没「上桌」，小一点更像从牌堆里摊开待挑
     * 手机上屏窄，一行只有 4~6 张，这个比例差异影响不大。
     */
    var FAN_CARD_RATIO = 0.65;
    /*
     * 下限 44px 是触控目标：再小手指就点不准了。
     * 上限 68px 是「比牌桌上的牌小一号」。
     * 手机屏窄，会被下限托住；桌面宽，会被上限接住。
     */
    var fanCardW = Math.round(cardW * FAN_CARD_RATIO);
    fanCardW = Math.max(isTouch ? 44 : 40, Math.min(68, fanCardW));
    var fanCardH = Math.round(fanCardW * (134 / 84));
    var fanGap = Math.max(5, Math.round(fanCardW * 0.12));
    var fanCell = fanCardW + fanGap;

    /*
     * 行距必须用**牌高**，不能用格子宽。
     *
     * 踩过一次：写成 fanCell（牌宽 + 间距 = 76px），而牌高是 108px，
     * 于是相邻两行纵向叠上了 32px——横向明明一格一张，纵向却压着。
     * 牌是竖的，行距天然要比列距大。
     */
    var fanRowGap = Math.max(8, Math.round(fanCardH * 0.14));
    var fanRowPitch = fanCardH + fanRowGap;

    /*
     * 待挑牌区的横向排布。
     *
     * 一行放几张由「一行真正能用的跨度 ÷ 最小间距」定，顺序不能颠倒——
     * 先定间距再算张数会自相矛盾：间距是均分出来的，均分后每张占的宽度又变了，
     * 张数也得跟着变，绕一圈回到原点。
     */
    var fanWidth = baseWidth;
    var fanPerRow = Math.max(2, Math.floor((baseWidth + fanGap) / fanCell));

    return {
      viewport: view,
      baseWidth: baseWidth,
      cardW: cardW,
      cardH: cardH,
      captionH: captionH,
      captionBlockH: captionBlockH,
      /*
       * 牌位名那一块的宽度。**唯一来源**——applyMetrics、bonusLayout、
       * 以及测试都从这里取，不再各自写一遍 cardW * 1.15。
       * 四处各算一遍的写法迟早会有一处忘了跟着改。
       */
      captionW: captionW,
      captionFont: captionFont,
      cardPadY: cardPadY,
      fontNum: fontNum,
      fontGlyph: fontGlyph,
      fontTitle: fontTitle,
      fontEn: fontEn,
      fontSuit: fontSuit,
      cardPadX: cardPadX,
      orientFont: orientFont,
      orientH: orientH,
      padTop: padTop,
      bottomReserve: bottomReserve,
      pxPerUnit: pxPerUnit,
      unit: pxPerUnit,
      minDy: minDy,
      minDx: minDx,
      /*
       * 待挑牌区。网格布局——每张完整可见，一行几张由屏宽决定。
       *
       * fanCell 是列距（牌宽 + 间距），fanRowPitch 是行距（牌高 + 行间缝）。
       * 两者必须分开：牌是竖的，行距天然比列距大。曾经共用一个值，
       * 结果相邻两行纵向叠上 32px。
       */
      fanCardW: fanCardW,
      fanCardH: fanCardH,
      fanGap: fanGap,
      fanCell: fanCell,
      fanRowPitch: fanRowPitch,
      fanRowGap: fanRowGap,
      fanWidth: fanWidth,
      fanPerRow: fanPerRow,
      isTouch: isTouch
    };
  }

  /**
   * 把算好的纵向阈值同步给牌阵模块。
   *
   * 牌阵自检（Spreads.validate）要用它判断「两张牌够不够开」。阈值取决于
   * 牌有多高，而牌高随屏幕变，所以不能在牌阵里写死——写死 98（按桌面算）
   * 会让手机上的牌阵被撑得过松，两张牌之间空出两百多像素。
   */
  function syncSpreadThreshold(m) {
    if (!Tarot.Spreads) return;
    /*
     * 横纵阈值都要同步过去。
     *
     * 两个都由当前尺寸决定，而不是固定值：
     *   纵向 minDy —— 牌高随屏幕变（桌面 166、手机 89）
     *   横向 minDx —— 牌位名宽约占牌宽 1.15 倍，换算成「占牌桌宽的百分点」
     *                 在窄屏反而更大（桌面约 13.3、手机约 21.2）
     *
     * 只同步纵向的话，横向就永远停在默认值上，窄屏的 validate() 会放行
     * 真实的压盖——那道自检在窄屏等于没有。
     */
    if (typeof Tarot.Spreads.setMinDy === 'function') {
      Tarot.Spreads.setMinDy(m.minDy);
    }
    if (typeof Tarot.Spreads.setMinDx === 'function') {
      Tarot.Spreads.setMinDx(m.minDx);
    }
  }

  /** 当前生效的尺寸 */
  var current = computeMetrics(viewportWidth, touchDevice);
  syncSpreadThreshold(current);

  function metrics() { return current; }

  /**
   * 换一个视口宽度，按推算路径重算尺寸。Node 测试用；浏览器里走 applyMetrics。
   *
   * 参数是**视口宽度**，不是容器宽度——容器由 estimateAvailableWidth 推出来。
   * 统一口径很重要：这个参数曾经被当成容器宽度用过，于是同一套断言在两种
   * 含义下各算一遍，栅格差个 20px 也说不清是谁错了。
   *
   * 会把 measuredWidth 清掉：实测值只对「量它的那一刻」有效（尺寸、屏幕方向、
   * 测试里注入的替身都可能变），留着会粘到后续的计算上。
   */
  function setViewportWidth(vw, touch) {
    viewportWidth = vw;
    if (touch !== undefined) touchDevice = Boolean(touch);
    measuredWidth = 0;
    current = computeMetrics(viewportWidth, touchDevice);
    syncSpreadThreshold(current);
    return current;
  }

  /**
   * 把尺寸写进 CSS 变量，并把当前视口宽度记下来。
   *
   * 在浏览器里由 app.js 在初始化和窗口尺寸变化时调用。
   */
  function applyMetrics(root) {
    var doc = root || (typeof document !== 'undefined' ? document : null);
    var win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);

    /*
     * 记下视口宽度，供「量不到容器」时的推算路径使用。
     *
     * 优先用 documentElement.clientWidth，**不要用 window.innerWidth**：
     * innerWidth 包含竖直滚动条（Windows 上 15~17px），而块级元素的布局宽度
     * 不含它。用 innerWidth 推算出的基准宽会比真实内容区宽一个滚动条，
     * 而 .table-wrap/.fan-wrap 都是 overflow: hidden——右边那一列就被裁掉了，
     * 正是「右边的牌显示不全」。
     *
     * clientWidth 已经排除了滚动条，和 CSS 布局用的是同一个口径。
     * 拿不到时（极老浏览器、精简直的 DOM）才退回 innerWidth。
     */
    if (win && win.document && win.document.documentElement &&
        win.document.documentElement.clientWidth > 0) {
      viewportWidth = win.document.documentElement.clientWidth;
    } else if (win && win.innerWidth) {
      viewportWidth = win.innerWidth;
    }

    // 先量容器，再算尺寸——量的结果直接决定基准宽
    measuredWidth = measureAvailableWidth();

    /*
     * 判断是不是触摸设备。
     *
     * 只用 (hover: none) 这一条不够：一些笔记本同时有触摸屏和鼠标，
     * 这时按「能用鼠标」处理更合适——鼠标的目标尺寸需求本来就小。
     * 所以条件是「不能悬停 且 指针很粗」，两者同时成立才当触摸设备。
     */
    if (win && typeof win.matchMedia === 'function') {
      var noHover = win.matchMedia('(hover: none)');
      var coarse = win.matchMedia('(pointer: coarse)');
      touchDevice = Boolean(noHover.matches && coarse.matches);
    }

    current = computeMetrics(viewportWidth, touchDevice);
    syncSpreadThreshold(current);

    if (!doc || !doc.documentElement) return current;

    var style = doc.documentElement.style;
    if (style && style.setProperty) {
      style.setProperty('--card-w', current.cardW + 'px');
      style.setProperty('--card-h', current.cardH + 'px');
      style.setProperty('--caption-w', Math.round(current.captionW) + 'px');
      /*
       * 牌面五段文字的字号。全部从 metrics 取，不在这里重算——
       * 两处各算一遍迟早会对不上（这里曾经就和 computeMetrics 各写了一份）。
       */
      style.setProperty('--card-title', current.fontTitle + 'px');
      style.setProperty('--card-glyph', current.fontGlyph + 'px');
      style.setProperty('--card-num', current.fontNum + 'px');
      style.setProperty('--card-en', current.fontEn + 'px');
      style.setProperty('--card-suit', current.fontSuit + 'px');
      style.setProperty('--card-pad-y', current.cardPadY + 'px');
      style.setProperty('--card-pad-x', current.cardPadX + 'px');

      /*
       * 牌位名与朝向标签的字号。
       *
       * 这两个原来写死 11px / 9.5px，都是按桌面定的。手机上牌位名只有 64px 宽，
       * 11px 的中文一行放不下四个字，牌位名会被省略号截掉。
       * 跟着牌宽缩之后，窄屏也放得下。
       */
      style.setProperty('--caption-font', Math.max(9, Math.round(current.cardW * 0.106)) + 'px');
      style.setProperty('--orient-font', Math.max(8, Math.round(current.cardW * 0.091)) + 'px');

      /*
       * 待挑牌区的卡片尺寸。
       *
       * 必须写出来。CSS 里虽然有 84×134 的默认值，但那只在 JS 没跑起来时兜底——
       * 手机上一张牌只有 45px 宽，如果 CSS 还按 84px 画，牌就会互相盖住，
       * 而绝对定位的坐标是按小尺寸算的，结果是所有牌堆成一团。
       */
      style.setProperty('--fan-card-w', current.fanCardW + 'px');
      style.setProperty('--fan-card-h', current.fanCardH + 'px');
    }
    return current;
  }

  /**
   * 把牌位坐标折算成桌面内的像素位置。
   *
   * @param {{x: number, y: number}} position
   * @returns {{left: number, top: number}}
   */
  function positionToPixels(position) {
    var m = metrics();

    /*
     * 坐标必须是有限数。
     *
     * 传进 NaN 时不校验的话，算出来的 left/top 也是 NaN，牌被定位到
     * 「NaN px」上——浏览器当成无效值丢弃，那张牌就飞到容器外看不见了，
     * 而控制台没有任何提示。牌阵坐标是手写常量，写错一个小数点就可能走到这里，
     * 所以宁可在这里明确抛错，让它当场暴露。
     */
    if (!position || !isFinite(position.x) || !isFinite(position.y)) {
      throw new Error('牌位坐标必须是有限数，收到：' +
        (position ? 'x=' + position.x + ', y=' + position.y : String(position)));
    }

    return {
      left: (position.x / 100) * m.baseWidth,
      top: m.padTop + position.y * m.pxPerUnit
    };
  }

  /**
   * 计算牌桌尺寸。
   *
   * 高度直接由内容算出：「最低那张牌的中心 + 半张牌 + 牌位名」再加一点留白。
   * 不用任何写死的底线值——早先版本的 maxY 初始值是 100，而牌阵里最低的
   * 牌位只到 y=93（凯尔特十字），于是底部平白多出上百像素空白。
   *
   * @param {Object} result
   * @returns {{width: number, height: number, padTop: number, unit: number}}
   */
  function tableSize(result) {
    var m = metrics();
    var lowestCenter = m.padTop;

    result.cards.forEach(function (item) {
      var spot = positionToPixels(item.position);
      if (spot.top > lowestCenter) lowestCenter = spot.top;
    });

    /*
     * 宽度**就是基准宽**，不再按内容另算。
     *
     * 这一点很要紧，它保证「牌桌坐标系」和「牌桌元素宽度」是同一个数。
     * 早先这里写的是 max(基准宽, 最右侧牌的右边缘 + 14)——只有内容比基准宽时
     * 才撑开。结果牌桌宽 302px 而容器内容区 314px，块级元素左对齐，
     * 右侧平白多出 12px 空白，看着就是「整块靠左」。
     *
     * 基准宽已经是「容器可用宽度」（桌面封顶 900），所以取满它正好铺满容器，
     * 而 x 坐标是相对基准宽的百分比，内容自然居中。
     *
     * 坐标的合法性由牌阵自检和 verify-layout 的越界检查保证（x 都在 6~94
     * 之间，最宽的牌也不会探出去），这里不需要再兜底撑宽。
     */
    var width = m.baseWidth;

    // 高度：最低那张牌的中心 + 它下半部分 + 牌位名 + 一点留白
    var height = Math.round(lowestCenter + m.bottomReserve + 16);

    /*
     * 只返回 width / height。
     *
     * 曾经还返回 padTop 和 unit，但运行时没有一处读它们（renderTable 只用
     * width/height，坐标换算走 positionToPixels）。留着容易误导——比如让人
     * 以为可以拿 size.unit 去算坐标，而那和 positionToPixels 的口径未必一致。
     * 要坐标就用 positionToPixels，它是唯一的那条路径。
     */
    return { width: width, height: height };
  }

  /**
   * 给追加的牌排位置。
   *
   * 追加的牌不属于任何牌位，所以没有预设坐标，需要在这里现排：
   * 排在**牌阵最低那张牌的下方**，每行最多 7 张，末行居中。
   *
   * 这是纯函数：给定张数与原牌阵就返回确定的坐标，便于单独测试。
   *
   * @param {number} count 追加张数
   * @param {Array} baseCards 原牌阵的牌（用来找下方起点）
   * @returns {Array<{x: number, y: number, row: number, col: number}>}
   */
  function bonusLayout(count, baseCards) {
    var m = metrics();

    /*
     * 一行的横向排布。
     *
     * 顺序是固定的，不能颠倒：
     *   1. 由可用跨度与「最小间距」定出一行放几张
     *   2. 再由张数把跨度均分，得到实际间距
     *
     * 反过来（先定间距再算张数）会自相矛盾：间距是均分出来的，均分后每张占的
     * 宽度又变了，张数也得跟着变——绕一圈回到原点。
     *
     * 踩过的坑：原来算的是 floor(牌桌宽 / 牌位名宽)，手机上是 5 张；但一行其实
     * 只用 SPAN_X - START_X = 79 个百分点（293px 桌上约 231px），5 张需要
     * 5×64 + 4×8 = 352px——远超可用宽度，最右边那张被牌桌边缘裁掉一半。
     * 同时那版还有个 MAX_GAP 上限在压缩间距，越压越挤。
     */
    var START_X = 8;
    var SPAN_X = 87;    // 一行排满时占的横向宽度（百分点）
    var spanPx = (SPAN_X - START_X) / 100 * m.baseWidth;

    // 两个约束取较大者：牌位名要并排放下，而且牌本身不能叠上
    // 牌位名宽从 metrics 取，不在这里另算一遍（那会和 CSS 变量脱钩）
    var captionW = m.captionW;
    var minStepPx = Math.max(captionW + 8, m.cardW + 6);
    var PER_ROW = Math.max(2, Math.floor(spanPx / minStepPx));

    // 由张数均分跨度，得到实际间距（百分点）
    var MIN_GAP = (captionW + 8) / m.baseWidth * 100;
    var fitGap = PER_ROW > 1 ? (SPAN_X - START_X) / (PER_ROW - 1) : SPAN_X - START_X;

    // 与原牌阵最低一行之间空出的纵向单位。和 ROW_GAP 同理：必须让出整个说明区。
    /*
     * 追加行之间的纵向间距。
     *
     * 直接取 m.minDy，也就是牌阵用的那个坐标间距（COORD_ROW_UNITS）。
     *
     * 必须这样取，不能自己用 (cardH + captionBlockH) / pxPerUnit 现算。
     * 那个除法和 pxPerUnit 的定义正好抵消——pxPerUnit 里含的行距余量
     * （ROW_GAP_SLACK）会被除回去，算出来的间距又变成「刚好一格」，
     * 上一行的说明区底边和下一行的牌面顶边只剩 0.2px。实测过。
     *
     * 用同一个数还带来一个好处：补充牌的行距和牌阵的行距完全一致，
     * 视觉上是一套网格，不会一块松一块紧。
     */
    var ROW_GAP = m.minDy;
    // 与原牌阵最低一行之间空出的距离，同理用同一个口径
    var APPROACH = m.minDy;

    /*
     * 每行的水平间距。
     *
     * 张数少时用「铺满一行」的间距（不要让两张牌孤零零贴在中间），
     * 张数多时用 fitGap——那是「可用跨度除以间隔数」，保证一行一定放得下。
     * 不再设上限去压缩它，否则又会挤到裁切。
     */
    function gapFor(n) {
      if (n <= 1) return 0;
      var spread = (SPAN_X - START_X) / (n - 1);
      return Math.max(MIN_GAP, Math.min(spread, fitGap));
    }

    function rowX(n) {
      var gap = gapFor(n);
      var first = 50 - gap * (n - 1) / 2;
      var out = [];
      for (var i = 0; i < n; i++) out.push(first + gap * i);
      return out;
    }

    // 从牌阵**最低**（y 最大）的那张牌下方开始排。
    // 这里必须取最大值——取最小值会把追加牌排进牌阵中间去。
    var lowestY = 0;
    (baseCards || []).forEach(function (item) {
      if (item.position.y > lowestY) lowestY = item.position.y;
    });

    var top = lowestY + APPROACH;

    /*
     * 每行放几张：把总数**均摊**到各行，而不是「前面的排满、余数丢给最后一行」。
     *
     * 原来用的是后者（Math.ceil 定行数，余数单独一行），于是 10 张排成
     * 3/3/3/1——最后一行孤零零一张，整块看着是歪的。用户反馈过。
     *
     * 现在的规则，按优先级：
     *   1. 行数尽量少（块不要拉太长）
     *   2. 每行都 ≥2 张——**绝不出现只剩一张的尾巴**
     *   3. 每行 ≤ PER_ROW（放得下）
     *   4. 各行张数尽量相等
     *
     * 做法是从「放得下所需的最少行数」起逐行增加，取第一个满足 2、3 的方案。
     *
     * 为什么不能只靠「余数是否为 1」判断：余数是 2 时也会掉进同一个坑——
     * 5 张排成 2/2/1、7 张排成 2/2/2/1，尾巴还是一张。这里踩过一次。
     */
    function rowCounts(total) {
      if (total <= 0) return [];

      // 一张牌只有一行，没有「尾巴」可言
      if (total === 1) return [1];

      var minRows = Math.ceil(total / PER_ROW);

      for (var rows = minRows; rows <= total; rows++) {
        var base = Math.floor(total / rows);
        var extra = total % rows;   // 前 extra 行各多放一张

        // extra 为 0 时各行都是 base，否则最小的是 base
        var smallest = extra === 0 ? base : base;
        if (base < 2) break;              // 行数已经多到有行只剩一张，再试也没用
        if (base + (extra > 0 ? 1 : 0) > PER_ROW) continue;   // 这行放不下

        var out = [];
        for (var i = 0; i < rows; i++) out.push(base + (i < extra ? 1 : 0));
        return out;
      }

      // 兜底：每行一张（理论上到不了这里）
      var fallback = [];
      for (var k = 0; k < total; k++) fallback.push(1);
      return fallback;
    }

    var perRowList = rowCounts(count);
    var rows = perRowList.length;
    var positions = [];

    for (var r = 0; r < rows; r++) {
      var inRow = perRowList[r];
      var xs = rowX(inRow);
      for (var c = 0; c < inRow; c++) {
        positions.push({ x: xs[c], y: top + r * ROW_GAP, row: r, col: c });
      }
    }

    return positions;
  }

  /**
   * 把追加的牌合进一次抽牌结果，得到「用于显示与解读」的完整视图。
   *
   * 刻意不改动原 result（它是纯粹的一次随机抽牌记录），而是返回一个新的
   * 合并副本：原牌位在前，追加牌在后，各自带上排好的坐标。
   * 给每张追加牌写的 asks 会明确告诉模型「这是用户主动补抽的」，
   * 否则模型会把它当成牌阵里的一个正式牌位去解读。
   *
   * @param {Object} result draw() 的结果
   * @param {Array} bonus extraCards() 返回的追加牌
   * @returns {Object} 合并后的副本
   */
  function mergeBonus(result, bonus) {
    if (!bonus || !bonus.length) return result;

    var layout = bonusLayout(bonus.length, result.cards);

    var extras = bonus.map(function (item, i) {
      var spot = layout[i] || { x: 50, y: 110 };
      return {
        index: result.cards.length + i,
        cardId: item.cardId,
        card: item.card,
        reversed: item.reversed,
        orientation: item.orientation,
        position: {
          title: '补充牌 ' + (i + 1),
          asks: '用户在看完整套牌之后，主动要求再补一张。请把它读成对整体解读的补充、' +
            '强调或修正：它印证了哪一部分？又补充了什么前面没提到的角度？' +
            '不要把它当成牌阵里的一个独立牌位。',
          x: spot.x,
          y: spot.y
        },
        meaning: item.meaning,
        isBonus: true
      };
    });

    var merged = {};
    Object.keys(result).forEach(function (key) { merged[key] = result[key]; });
    merged.cards = result.cards.concat(extras);
    merged.bonusCount = extras.length;
    return merged;
  }

  /* ------------------------------------------------------------------ *
   * 待挑牌区（自己抽牌）
   *
   * 整副牌背面朝上、按网格排开，每张完整可见、互不压盖。
   *
   * 这里曾经是「弧形 + 重叠」的扇形，靠每张只露 22px 营造抹开的牌堆感，
   * 好处是 78 张能塞进两行。手机上那个设计不成立——牌面本来就小，一重叠
   * 就分不清哪张是哪张，点起来全靠猜。改成网格之后边界清楚，代价是要滚。
   *
   * 一行放几张由「一行真正能用的跨度 ÷ 最小间距」定，间距再把跨度均分。
   * 顺序不能颠倒，否则间距和张数会互相依赖、绕回原点。
   * ------------------------------------------------------------------ */

  /**
   * 算待挑牌区的版面。
   *
   * 纯函数：给张数就返回确定的坐标，方便单独测。
   *
   * 位置**不携带任何牌面信息**——第 i 个位置和牌序无关，用户点哪儿都不会
   * 泄露「这是哪张牌」。这是「自己选」成立的前提。
   *
   * @param {number} count 扇形里的张数
   * @returns {{positions: Array, width: number, height: number, rows: number}}
   */
  function fanLayout(count) {
    var m = metrics();

    if (!count || count < 1) {
      return { positions: [], width: m.fanWidth, height: 0, rows: 0 };
    }

    var rows = Math.ceil(count / m.fanPerRow);
    var positions = [];

    for (var r = 0; r < rows; r++) {
      var start = r * m.fanPerRow;
      var inRow = Math.min(m.fanPerRow, count - start);
      if (inRow < 1) break;

      /*
       * 每行各自居中。
       *
       * 最后一行往往不满（78 张、一行 5 张时最后一行只有 3 张），
       * 如果统一按放满的宽度左对齐，它会歪在左边，看着像排版坏了。
       */
      var rowWidth = inRow * m.fanCardW + (inRow - 1) * m.fanGap;
      var leftBase = Math.round((m.fanWidth - rowWidth) / 2);
      var rowTop = r * m.fanRowPitch;

      for (var c = 0; c < inRow; c++) {
        positions.push({
          index: start + c,
          row: r,
          col: c,
          left: leftBase + c * m.fanCell,
          top: rowTop,
          // 网格布局不旋转。旋转会让卡片超出格子、和邻牌挨上，
          // 而这一版的目标就是「每张边界清楚」
          rotate: 0
        });
      }
    }

    return {
      positions: positions,
      width: m.fanWidth,
      height: rows * m.fanRowPitch + 8,
      rows: rows
    };
  }

  /**
   * 渲染扇形。
   *
   * @param {HTMLElement} container
   * @param {Array} fanOrder 扇形里各位置上的牌 id（只用于计数，不渲染内容）
   * @param {Object} handlers {onPick}
   */
  function renderFan(container, fanOrder, handlers) {
    clear(container);

    var layout = fanLayout(fanOrder.length);
    container.style.width = layout.width + 'px';
    container.style.height = layout.height + 'px';

    layout.positions.forEach(function (spot) {
      var node = el('button', 'fan-card');
      node.type = 'button';
      node.style.left = spot.left + 'px';
      node.style.top = spot.top + 'px';
      node.style.zIndex = String(spot.index + 1);
      node.setAttribute('data-fan-index', String(spot.index));
      // 只报「第几张」，绝不透露是什么牌——否则用户就不是在随机挑了
      node.setAttribute('aria-label', '第 ' + (spot.index + 1) + ' 张，点击挑走');

      var back = el('div', 'fan-back');
      back.appendChild(el('span', 'fan-glyph', '✦'));
      node.appendChild(back);

      node.addEventListener('click', function () { handlers.onPick(spot.index); });

      container.appendChild(node);
    });
  }

  /**
   * 待挑牌区上方的提示：还要挑几张、还剩几张。
   *
   * @param {Object} info {needed, picked, remaining}
   * @returns {string}
   */
  function fanPrompt(info) {
    var left = info.needed - info.picked;
    if (left <= 0) return '已经挑够了 ' + info.needed + ' 张。';
    // 一共几张由面板右上角的「3 / 10」负责说，这里只讲这一下挑第几张、
    // 牌区还剩多少——同一个数字写两遍，读者反而要去找它们的差别。
    return '请挑第 ' + (info.picked + 1) + ' 张，牌区里还剩 ' + info.remaining + ' 张。';
  }

  /* ------------------------------------------------------------------ *
   * 牌阵与牌库选择
   * ------------------------------------------------------------------ */

  /**
   * 渲染牌桌。抽牌动画的错峰延迟在这里按牌数分配：
   * 张数多时缩短间隔，保证整套动画在 1 秒左右结束，不会让人干等。
   *
   * @param {HTMLElement} surface
   * @param {Object} result
   * @param {Object} handlers {onCardClick}
   */
  function renderTable(surface, result, handlers) {
    clear(surface);

    var size = tableSize(result);
    surface.style.width = size.width + 'px';
    surface.style.height = size.height + 'px';

    /*
     * 牌面入场的错峰延迟：总时长压在 520ms 内，单张间隔 25-70ms。
     *
     * 这些数配的是 CSS 里 card-in 那 340ms 的动画。原来是按 750ms 的翻转
     * 动画定的，翻转换成上浮淡入之后就显得拖——10 张牌要等一秒多才出齐。
     */
    var count = result.cards.length;
    var step = Math.max(25, Math.min(70, Math.round(520 / Math.max(1, count))));

    result.cards.forEach(function (item, i) {
      var slot = el('div', 'slot' + (item.reversed ? ' is-reversed' : '') +
        (item.isBonus ? ' is-bonus' : ''));
      var spot = positionToPixels(item.position);
      slot.style.left = item.position.x + '%';
      slot.style.top = spot.top + 'px';
      slot.style.setProperty('--delay', (i * step) + 'ms');
      slot.tabIndex = 0;
      slot.setAttribute('role', 'button');
      slot.setAttribute('aria-label',
        item.position.title + '：' + item.card.name + ' ' + item.orientation + '，点击查看牌义');

      var inner = el('div', 'slot-inner');
      var flip = el('div', 'card-flip');

      var back = el('div', 'card-face card-back');

      var front = el('div', 'card-face card-front');
      /*
       * 牌面内容套一层。逆位时转的是这一层——整块转过去才会连元素顺序一起翻，
       * 逐个文字元素转的话，每个字虽然头朝下，排列顺序却还是正的。
       */
      var cfInner = el('div', 'cf-inner');
      cfInner.appendChild(el('span', 'cf-num', item.card.roman));
      cfInner.appendChild(el('span', 'cf-glyph', item.card.glyph));
      cfInner.appendChild(el('span', 'cf-name', item.card.name));
      cfInner.appendChild(el('span', 'cf-en', item.card.en));
      cfInner.appendChild(el('span', 'cf-suit',
        item.card.suitShort + ' · ' + item.card.element));
      front.appendChild(cfInner);

      flip.appendChild(back);
      flip.appendChild(front);
      inner.appendChild(flip);
      slot.appendChild(inner);

      var caption = el('div', 'slot-caption');
      var pos = el('span', 'slot-pos', item.position.title);
      if (item.isBonus) pos.appendChild(el('span', 'bonus-tag', '补充'));
      caption.appendChild(pos);
      caption.appendChild(el('span', 'slot-orient' + (item.reversed ? ' is-rev' : ''), item.orientation));
      slot.appendChild(caption);

      function open() { handlers.onCardClick(item); }
      slot.addEventListener('click', open);
      slot.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });

      surface.appendChild(slot);
    });
  }

  /**
   * 牌桌下方的说明文字。
   */
  function renderTableFoot(node, result) {
    clear(node);
    var parts = [];
    parts.push('牌阵：' + result.spreadName + '（' + result.cards.length + ' 张）');
    parts.push('牌库：' + result.deckLabel);
    parts.push('编号 ' + result.id);
    node.appendChild(document.createTextNode(parts.join('　|　')));

    /*
     * 随机源这一行原来还把「本次消耗 N 个 32 位随机数、拒绝 N 个、
     * 熵流偏移 N、首字 xxxx…」全都摊在正文里，两行宽。那些数字的用处是
     * 核对「这一抽确实来自系统熵」，值得留着，但没必要占正文位置——
     * 正文只说来源，逐项数字放进 title，想核的人悬停就能看到。
     */
    node.appendChild(document.createElement('br'));
    var rngLine = document.createElement('span');
    rngLine.textContent = '随机源：系统加密随机 + 拒绝采样';
    rngLine.title = result.rng + '。' + result.audit;
    node.appendChild(rngLine);
    node.appendChild(document.createTextNode('，点任意一张牌可以看完整牌义。'));

    if (result.bonusCount) {
      node.appendChild(document.createElement('br'));
      node.appendChild(document.createTextNode(
        '其中 ' + result.bonusCount + ' 张是你主动追加的补充牌（金色边框、标着「补充」）。'));
    }
  }

  /* ------------------------------------------------------------------ *
   * AI 解读
   * ------------------------------------------------------------------ */

  /**
   * 渲染「还没生成解读」的占位区。
   */
  function renderReadingPlaceholder(container, result, options) {
    clear(container);

    var box = el('div', 'reading-placeholder');
    box.appendChild(el('span', 'rp-title', '牌已经抽好了，接下来让模型来读。'));

    var configured = options && options.configured;
    box.appendChild(document.createTextNode(
      configured
        ? '点下面的按钮，' + result.cards.length + ' 张牌和你的问题会发给你配置的模型，由它给出解读。'
        : '还没有配置模型接口。先点右上角「⚙ 接口设置」填好地址和 Key，再回来生成解读。'
    ));

    var actions = el('div', 'rp-actions');
    var btn = el('button', 'btn btn-primary', configured ? '生成 AI 解读' : '去配置接口');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      if (configured) options.onGenerate();
      else options.onOpenSettings();
    });
    actions.appendChild(btn);
    box.appendChild(actions);

    container.appendChild(box);
  }

  /**
   * 渲染等待中的状态。解读通常要 10-40 秒，这里把模型正在做的事列出来，
   * 避免用户面对一个静止的转圈不知道要等多久。
   */
  function renderReadingLoading(container, result) {
    clear(container);

    var box = el('div', 'reading-loading');
    var line = el('div', 'rl-line');
    line.appendChild(el('span', 'spinner'));
    line.appendChild(document.createTextNode('模型正在解读这 ' + result.cards.length + ' 张牌…'));
    box.appendChild(line);

    var steps = el('ul', 'rl-steps');
    [
      '逐个牌位读取牌义原文，核对正逆位',
      '把你的问题和每张牌对应起来',
      '检查牌位之间是否互相矛盾',
      '给出可执行的行动建议'
    ].forEach(function (text) { steps.appendChild(el('li', null, text)); });
    box.appendChild(steps);

    var hint = el('p', 'field-hint', '第一次调用通常较慢。牌阵越大耗时越长，请不要关闭页面。');
    box.appendChild(hint);

    container.appendChild(box);
  }

  /**
   * 渲染错误。
   */
  function renderReadingError(container, message, onRetry, onSettings) {
    clear(container);

    var box = el('div', 'reading-error');
    box.appendChild(el('strong', null, '解读失败：'));
    box.appendChild(document.createTextNode(' ' + message));

    var actions = el('div', 're-actions');
    if (onRetry) {
      var retry = el('button', 'btn btn-ghost', '重试');
      retry.type = 'button';
      retry.addEventListener('click', onRetry);
      actions.appendChild(retry);
    }
    if (onSettings) {
      var settings = el('button', 'btn btn-ghost', '检查接口设置');
      settings.type = 'button';
      settings.addEventListener('click', onSettings);
      actions.appendChild(settings);
    }
    box.appendChild(actions);

    container.appendChild(box);
  }

  /**
   * 渲染完整的解读结果。
   *
   * @param {HTMLElement} container
   * @param {Object} payload {result, reading, quoteStats, issues, usage}
   * @param {Object} handlers {onExport, onRegenerate}
   */
  function renderReading(container, payload, handlers) {
    clear(container);

    var reading = payload.reading;
    var result = payload.result;

    /*
     * 顺序是刻意的：结论 → 每张牌 → 行动。
     *
     * 早先的顺序是「核对条 → 贴合度 → 模型的理解 → 总览 → 十张牌 → 串起来 →
     * 行动 → 不确定之处」，把元信息和铺垫全放在最前面，把「到底怎么办」
     * 埋到两千多字之后。用户对那一版的评价是「看着好累好复杂，而且没什么
     * 参考价值」：累是因为重点被淹没，没价值是因为读完不知道具体该做什么。
     *
     * 后来改成「结论 → 行动 → 每张牌」，用户又指出顺序不对：
     * 「倾向说完了之后应该接每张牌是代表什么，是什么意思」。
     * 这个意见是对的——行动是从牌面推出来的结论，先摆行动、
     * 再让用户自己去牌里找依据，等于把推理链倒过来讲。
     *
     * 现在是：先给答案，再用牌面支撑它，最后才是照着做的事。
     */

    // 1. 结论。很多人只会读这一段，所以它必须排第一，且不加任何前缀说明。
    if (reading.verdict) {
      var verdictBox = el('div', 'reading-verdict');
      verdictBox.appendChild(el('p', null, reading.verdict));
      container.appendChild(verdictBox);
    }

    // 2. 逐张牌。数量多时默认折叠，只留一行摘要。
    var looseIndexes = {};
    if (payload.specificity && payload.specificity.loose) {
      payload.specificity.loose.forEach(function (item) { looseIndexes[item.index] = true; });
    }

    /*
     * 少于四张时默认展开。
     *
     * 单张牌阵或三张牌阵本来就短，全部折叠反而多一次点击；
     * 凯尔特十字十张牌全展开就是当初那个「好累」的来源。
     */
    var expandByDefault = reading.cards.length <= 3;

    var list = el('div', 'card-readings');
    list.appendChild(el('h3', 'card-readings-title',
      expandByDefault ? '每张牌说了什么' : '每张牌说了什么（点开看细节）'));
    reading.cards.forEach(function (item) {
      list.appendChild(buildCardReading(item, looseIndexes[item.index], expandByDefault));
    });
    container.appendChild(list);

    // 3. 行动。放在牌面之后——它是从上面这些牌里推出来的。
    if (reading.actions && reading.actions.length) {
      var act = el('div', 'reading-actions-block');
      act.appendChild(el('h3', null, '可以去做的事'));
      var ul = el('ul', 'actions-list');
      reading.actions.forEach(function (text) { ul.appendChild(el('li', null, text)); });
      act.appendChild(ul);
      container.appendChild(act);
    }

    // 4. 元信息。核对与贴合度是「这份解读可不可信」，属于事后核对，
    //    放在最后，不跟结论抢注意力。
    var meta = el('div', 'reading-meta');
    if (payload.specificity && payload.specificity.level !== 'skip') {
      meta.appendChild(buildFitBanner(payload.specificity, handlers));
    }
    meta.appendChild(buildVerifyBar(payload));
    container.appendChild(meta);

    // 5. 校验发现的问题
    if (payload.issues && payload.issues.length) {
      var issues = el('div', 'issues-box');
      issues.appendChild(el('strong', null, '校验时发现 ' + payload.issues.length + ' 处问题：'));
      var issueList = el('ul');
      payload.issues.forEach(function (text) { issueList.appendChild(el('li', null, text)); });
      issues.appendChild(issueList);
      container.appendChild(issues);
    }

    // 6. 底部操作
    var actions = el('div', 'reading-actions');
    if (handlers && handlers.onExport) {
      var exportBtn = el('button', 'btn btn-ghost', '导出为文本');
      exportBtn.type = 'button';
      exportBtn.addEventListener('click', handlers.onExport);
      actions.appendChild(exportBtn);
    }
    if (handlers && handlers.onRegenerate) {
      var again = el('button', 'btn btn-ghost', '重新解读一次');
      again.type = 'button';
      again.addEventListener('click', handlers.onRegenerate);
      actions.appendChild(again);
    }
    container.appendChild(actions);
  }

  /**
   * 顶部的核对条：引文核对结果 + 模型用量。
   */
  function buildVerifyBar(payload) {
    var stats = payload.quoteStats || { ok: 0, total: 0 };
    var bar = el('div', 'verify-bar');

    /*
     * 引文核对结果。
     *
     * 这里要区分两种完全不同的情况，文案不能混：
     *   checked = 0  —— 模型一个牌位都没给引文。页面上**没有任何标红**
     *                   （牌面只在 item.quote 存在时才渲染引文块）。
     *   ok < checked —— 给了引文但对不上原文。这时才有标红。
     *
     * 原来只看 ok/total，于是「一条引文都没给」也算成 ratio 0 / 'bad'，
     * 并显示「标红的牌位说明模型引用的原文对不上」——让用户去找根本不存在的
     * 标红，把「模型偷懒没给引用」误报成「模型编造引用」。后者是更严重的
     * 指控，不能这样含糊过去。
     *
     * checked 字段是 llm.js 记的「真正给了引文的牌位数」。老数据可能没有，
     * 那就退回 total（等价于旧行为，不会更糟）。
     */
    var total = stats.total || 0;
    var ok = stats.ok || 0;
    var checked = typeof stats.checked === 'number' ? stats.checked : total;
    var noneGiven = total > 0 && checked === 0;

    var ratio = checked ? ok / checked : 0;
    var level = noneGiven ? 'warn' : (ratio === 1 ? 'ok' : (ratio >= 0.5 ? 'warn' : 'bad'));

    var quoteNode = el('span', 'vq ' + level, noneGiven
      ? '引文核对：模型没有给出引文'
      : '引文核对 ' + ok + '/' + checked + (checked < total ? '（' + (total - checked) + ' 个牌位未给引文）' : ''));
    bar.appendChild(quoteNode);

    bar.appendChild(el('span', null, noneGiven
      ? '模型这次没有引用牌义原文，所以无法核对它读得准不准，那几条解释要打个折扣'
      : (ratio === 1
        ? '每个给了引文的牌位都能和牌义原文对上'
        : '标红的牌位说明模型引用的原文对不上，那一段的解释要打折扣')));

    bar.appendChild(el('span', 'vspacer'));

    if (payload.usage) {
      var tokens = (payload.usage.total_tokens || 0);
      bar.appendChild(el('span', null, '本次用量 ' + tokens + ' tokens'));
      bar.appendChild(el('span', 'vsep', '·'));
    }
    bar.appendChild(el('span', null, payload.result.cards.length + ' 个牌位'));

    return bar;
  }

  /**
   * 问题贴合度的横幅。
   *
   * 这个工具最容易被诟病的一点就是「解读跟我的问题关系不大」。与其让用户自己
   * 察觉，不如把它量化出来直接摆在最前面：有几条解读完全没提到问题里的具体词。
   *
   * 开放问题走的是另一套说法。它本来就没有具体词可以对，硬算一个覆盖率只会
   * 显示一个吓人的低分、把一次正常的解读说成失败。对开放问题该说的是
   * 「有没有把牌读成事件预告」——那才是它真正会犯的错。
   */
  function buildFitBanner(spec, handlers) {
    // 开放问题：不显示分数，改为说明读法与预告式写法
    if (spec.level === 'open') {
      var openLevel = spec.openLevel || 'good';
      var openBox = el('div', 'fit-banner is-open' +
        (openLevel === 'good' ? '' : ' is-' + openLevel));

      var openHead = el('div', 'fit-head');
      openHead.appendChild(el('span', 'fit-label', '开放问题的读法'));
      var openLabel = openLevel === 'good'
        ? '解读把牌读成了此刻的处境，没有预告具体事件'
        : (openLevel === 'fair'
          ? '大部分读得对，但有几条滑向了事件预告'
          : '解读更像在预告会发生什么，而不是指出该留意什么');
      openHead.appendChild(el('span', 'fit-detail', '· ' + openLabel));
      openBox.appendChild(openHead);

      openBox.appendChild(document.createTextNode(
        '你问的是开放问题，所以这里不按「问题里的词有没有被提到」来打分——' +
        '这类问题本来就没有具体词可以对照。'));
      openBox.appendChild(document.createElement('br'));
      openBox.appendChild(document.createTextNode(
        '开放问题看的是另一件事：牌有没有被读成对当下处境的映照。' +
        '塔罗能给的是「什么值得留意」，不是「会发生什么」。'));

      if (spec.predictLike && spec.predictLike.length) {
        openBox.appendChild(document.createElement('br'));
        var names = spec.predictLike.map(function (item) {
          return item.position + '（' + item.cardName + '）';
        }).join('、');
        openBox.appendChild(document.createTextNode(
          '下面这 ' + spec.predictLike.length + ' 条写得像预告：' + names +
          '。这类句子听起来像解读，但没法证伪——把它当成提醒而不是预言来读。'));
      }

      var openActions = el('div', 'fit-actions');
      if (handlers && handlers.onRegenerate) {
        var againOpen = el('button', 'btn btn-ghost', '再解读一次');
        againOpen.type = 'button';
        againOpen.addEventListener('click', handlers.onRegenerate);
        openActions.appendChild(againOpen);
      }
      openBox.appendChild(openActions);

      return openBox;
    }

    var box = el('div', 'fit-banner is-' + spec.level);

    var head = el('div', 'fit-head');
    head.appendChild(el('span', 'fit-score', spec.score));
    head.appendChild(el('span', 'fit-label', '问题贴合度'));

    var label = spec.level === 'good' ? '解读与你的问题对得上'
      : (spec.level === 'fair' ? '有部分内容比较泛' : '解读跟你的问题关系不大');
    head.appendChild(el('span', 'fit-detail', '· ' + label));
    box.appendChild(head);

    if (spec.level === 'good') {
      box.appendChild(document.createTextNode(
        '每一条解读都落到了你问题里的具体事情上，没有可以套到任何问题上的空话。'));
    } else {
      if (spec.loose.length) {
        box.appendChild(document.createTextNode(
          '下面标了「与问题关系不大」的 ' + spec.loose.length + ' 条，' +
          '内容换个问题也成立：'));
        var names = spec.loose.map(function (item) {
          return item.position + '（' + item.cardName + '）';
        }).join('、');
        box.appendChild(document.createTextNode(' ' + names + '。'));
      }
      if (spec.termTotal && spec.termsUsed.length < spec.termTotal) {
        var unused = [];
        box.appendChild(document.createElement('br'));
        box.appendChild(document.createTextNode(
          '你问题里提到、但解读没有回应的方面共 ' +
          (spec.termTotal - spec.termsUsed.length) + ' 个。'));
      }
      if (spec.generic.length) {
        box.appendChild(document.createElement('br'));
        box.appendChild(document.createTextNode(
          '另有 ' + spec.generic.length + ' 条出现了「多沟通」「相信自己」这类套话。'));
      }

      var actions = el('div', 'fit-actions');
      if (handlers && handlers.onRegenerate) {
        var again = el('button', 'btn btn-ghost', '换个说法再解读一次');
        again.type = 'button';
        again.addEventListener('click', handlers.onRegenerate);
        actions.appendChild(again);
      }
      if (handlers && handlers.onSharpen) {
        var sharpen = el('button', 'btn btn-ghost', '回去把问题写具体');
        sharpen.type = 'button';
        sharpen.addEventListener('click', handlers.onSharpen);
        actions.appendChild(sharpen);
      }
      if (actions.children.length) box.appendChild(actions);
    }

    return box;
  }

  /**
   * 单个牌位的解读块。
   *
   * @param {Object} item
   * @param {boolean} [isLoose] 这条解读完全没提到问题里的具体词
   */
  /**
   * 单张牌的解读块。用 <details> 做成可折叠：摘要行常显，细节点开才有。
   *
   * 用原生 <details>/<summary> 而不是自己写展开逻辑——键盘（回车/空格）、
   * 读屏、浏览器查找（Ctrl+F 能展开命中处）都是免费的，
   * 而这些自己实现起来都得逐个补。
   *
   * @param {Object} item 单张牌的解读记录
   * @param {boolean} isLoose 是否被判为「与问题关系不大」
   * @param {boolean} expandByDefault 是否默认展开（牌少时为 true）
   */
  function buildCardReading(item, isLoose, expandByDefault) {
    var box = el('details', 'card-reading' +
      (isLoose ? ' is-loose' : '') +
      (expandByDefault ? ' is-open' : ''));
    if (expandByDefault) box.setAttribute('open', 'open');

    /*
     * 摘要行：序号 + 牌位名 + 牌名 + 朝向 + 一句话。
     *
     * gist 是 prompt 直接要求的「不超过 30 字」的摘要。旧数据没有这个字段，
     * normalizeReading 会从 reading 里截第一句补上，所以这里总能拿到东西。
     */
    var head = el('summary', 'cr-head');
    head.appendChild(el('span', 'cr-index', item.index));
    head.appendChild(el('span', 'cr-pos', item.position));
    head.appendChild(el('span', 'cr-card', item.cardName));
    head.appendChild(el('span', 'cr-orient' + (item.orientation === '逆位' ? ' is-rev' : ''), item.orientation));
    if (item.isBonus) head.appendChild(el('span', 'bonus-tag', '补充'));
    if (isLoose) head.appendChild(el('span', 'loose-tag', '与问题关系不大'));

    if (item.gist) {
      head.appendChild(el('span', 'cr-gist', item.gist));
    } else if (!item.reading) {
      head.appendChild(el('span', 'cr-gist cr-gist-missing', '模型没有给出这个牌位的解读'));
    }
    box.appendChild(head);

    var body = el('div', 'cr-body');

    /*
     * 先讲「这张牌本身是什么意思」，再讲「它对你这个问题说明什么」。
     *
     * 用户的原话：「每张牌是代表什么，是什么意思」「正位就解释正位的意思，
     * 逆位就解释逆位的意思」。
     *
     * 这个顺序有道理：解读是从牌义推出来的，先摆结论、再让用户自己去猜
     * 依据是什么，等于把推理链倒过来讲。而且用户要判断这段解读靠不靠谱，
     * 前提是他知道这张牌原本是什么意思。
     *
     * meaning.text 是按当前朝向取的（正位取 up、逆位取 rev），
     * 所以这里显示的一定是对应朝向的牌义，不用再判断一次。
     */
    if (item.meaning && item.meaning.text) {
      var meaning = el('div', 'cr-meaning');

      var meaningHead = el('div', 'cr-meaning-head');
      meaningHead.appendChild(el('span', 'cr-meaning-tag',
        '这张牌的意思（' + (item.orientation || '正位') + '）'));
      if (item.meaning.core) {
        meaningHead.appendChild(el('span', 'cr-meaning-core', item.meaning.core));
      }
      meaning.appendChild(meaningHead);

      if (item.meaning.keywords && item.meaning.keywords.length) {
        var kw = el('div', 'cr-keywords');
        item.meaning.keywords.forEach(function (word) {
          kw.appendChild(el('span', 'cr-keyword', word));
        });
        meaning.appendChild(kw);
      }

      meaning.appendChild(el('p', 'cr-meaning-text', item.meaning.text));

      if (item.meaning.advice) {
        var advice = el('div', 'cr-meaning-advice');
        advice.appendChild(el('span', 'cr-advice-tag', '牌面本身的建议：'));
        advice.appendChild(document.createTextNode(' ' + item.meaning.advice));
        meaning.appendChild(advice);
      }

      body.appendChild(meaning);
    }

    if (item.reading || item.gist) {
      var own = el('div', 'cr-own');
      own.appendChild(el('div', 'cr-own-tag', '针对你的问题'));

      /*
       * reading 和 gist 是同一张牌的两层：gist 一句话，reading 补充细节。
       * 展开状态下 gist 已在摘要行显示过（收起时），这里只渲染 reading；
       * reading 缺失时退回到 gist，免得这一块空着。
       */
      var text = item.reading || item.gist;

      /*
       * 如果模型按 prompt 写了「与结论一致，没有额外提示」，就弱化显示——
       * 那是一句诚实的留白，不该看起来像一段正经解读。
       */
      var isNoExtra = /没有额外提示|与结论一致/.test(text) && text.length < 30;
      own.appendChild(el('p', 'cr-text' + (isNoExtra ? ' is-no-extra' : ''), text));
      body.appendChild(own);
    } else {
      body.appendChild(el('p', 'cr-missing', '模型没有给出这个牌位的解读。'));
    }

    if (item.quote) {
      var quote = el('div', 'cr-quote' + (item.quoteOk ? '' : ' is-bad'));
      quote.appendChild(document.createTextNode('「' + item.quote + '」'));
      /*
       * 未通过核对有两种情况，说法要分开。
       *
       * 「引的是建议不是牌义」和「把牌记串了」是两件事：前者引文一字不差，
       * 只是摘错了段落（prompt 里牌义和建议是并排给的）；后者才是真的编造。
       * 一律说成「模型可能记串了牌」会冤枉诚实的引用，也让用户误判该不该
       * 相信这段解读。
       */
      var why;
      if (item.quoteOk) {
        why = '↑ 已核对：这句确实出自该牌牌义原文';
      } else if (item.quoteFromAdvice) {
        why = '↑ 未通过核对：这句出自该牌的「传统建议」而不是牌义原文——' +
          '引文本身没错，但它不能用来证明这张牌的牌义';
      } else {
        why = '↑ 未通过核对：这句话在该牌的正逆位牌义里都找不到，模型可能记串了牌';
      }
      quote.appendChild(el('span', 'q-tag', why));
      body.appendChild(quote);
    }

    // 旧结构每张牌还带一句 action，新 prompt 已经去掉了。
    // 老记录里还有，继续渲染，免得历史记录少一块。
    if (item.action) {
      var action = el('div', 'cr-action');
      action.appendChild(el('span', 'ca-tag', '可以做的事：'));
      action.appendChild(document.createTextNode(' ' + item.action));
      body.appendChild(action);
    }

    box.appendChild(body);
    return box;
  }

  /* ------------------------------------------------------------------ *
   * 牌义弹窗
   * ------------------------------------------------------------------ */

  /**
   * 渲染单张牌的完整牌义（正位与逆位都列出来，当前朝向高亮）。
   */
  function renderCardDetail(container, item) {
    clear(container);
    var card = item.card;

    container.appendChild(el('div', 'cm-card-name', card.name + '（' + item.orientation + '）'));
    container.appendChild(el('div', 'cm-card-en',
      card.en + '　·　' + card.suitLabel + '　·　' + card.element + '　·　' + card.roman));

    var kw = el('div', 'cm-row');
    kw.appendChild(el('span', 'cm-label', '关键词'));
    var kwBox = el('div', 'cm-kw');
    card.keywords.forEach(function (word) { kwBox.appendChild(el('span', null, word)); });
    kw.appendChild(kwBox);
    container.appendChild(kw);

    var core = el('div', 'cm-row');
    core.appendChild(el('span', 'cm-label', '这张牌在讲什么'));
    core.appendChild(el('p', 'cm-text', card.core));
    container.appendChild(core);

    // 当前朝向
    var current = el('div', 'cm-row');
    current.appendChild(el('span', 'cm-label', '当前朝向 · ' + item.orientation));
    current.appendChild(el('p', 'cm-text', item.reversed ? card.rev : card.up));
    container.appendChild(current);

    var advice = el('div', 'cm-row');
    advice.appendChild(el('span', 'cm-label', '传统建议'));
    advice.appendChild(el('p', 'cm-text', card.advice));
    container.appendChild(advice);

    // 另一朝向，淡显
    var both = el('div', 'cm-both cm-inactive');
    both.appendChild(el('span', 'cm-label', '另一种朝向 · ' + (item.reversed ? '正位' : '逆位')));
    both.appendChild(el('p', 'cm-text', item.reversed ? card.up : card.rev));
    container.appendChild(both);

    var posRow = el('div', 'cm-row');
    posRow.appendChild(el('span', 'cm-label', '在这个牌阵里，它回答的是'));
    posRow.appendChild(el('p', 'cm-text', item.position.title + '：' + item.position.asks));
    container.appendChild(posRow);
  }

  /* ------------------------------------------------------------------ *
   * 历史记录
   * ------------------------------------------------------------------ */

  /**
   * @param {HTMLElement} container
   * @param {Array} records
   * @param {Object} handlers {onRestore, onExport, onDelete}
   */
  function renderHistory(container, records, handlers) {
    clear(container);

    if (!records.length) {
      container.appendChild(el('div', 'history-empty', '还没有记录。抽一次牌就会出现在这里。'));
      return;
    }

    records.forEach(function (record) {
      var item = el('div', 'history-item');

      var top = el('div', 'hi-top');
      top.appendChild(el('span', 'hi-q', record.question || '（没有写问题）'));
      top.appendChild(el('span', 'hi-time', formatTime(record.at)));
      item.appendChild(top);

      /*
       * 标出这一条存没存解读正文。
       *
       * 存了的话，点「重新载入这次牌面」会连解读一起恢复，不用再花一次
       * token；没存（老记录、或生成失败）就只能重新解读。用户需要在下手
       * 之前知道是哪一种。
       */
      var hasReading = Boolean(record.reading && record.reading.reading);
      var metaParts = [
        record.spreadName,
        record.cards.length + ' 张',
        record.deckLabel
      ];
      if (hasReading) metaParts.push('含解读');
      item.appendChild(el('div', 'hi-meta', metaParts.join('　·　')));

      var cardsText = record.cards.map(function (c) {
        return c.positionTitle + ' ' + c.cardName + c.orientation;
      }).join('　|　');
      item.appendChild(el('div', 'hi-cards', cardsText));

      var actions = el('div', 'hi-actions');

      var restore = el('button', 'btn btn-ghost', '重新载入这次牌面');
      restore.type = 'button';
      restore.addEventListener('click', function () { handlers.onRestore(record); });
      actions.appendChild(restore);

      var exportBtn = el('button', 'btn btn-ghost', '导出');
      exportBtn.type = 'button';
      exportBtn.addEventListener('click', function () { handlers.onExport(record); });
      actions.appendChild(exportBtn);

      var del = el('button', 'btn btn-danger-ghost', '删除');
      del.type = 'button';
      del.addEventListener('click', function () { handlers.onDelete(record.id); });
      actions.appendChild(del);

      item.appendChild(actions);
      container.appendChild(item);
    });
  }

  /**
   * 时间格式化：今天只显示时分，其他显示日期。
   * @param {string} iso
   * @returns {string}
   */
  function formatTime(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    var now = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    var hm = pad(date.getHours()) + ':' + pad(date.getMinutes());
    if (date.toDateString() === now.toDateString()) return '今天 ' + hm;
    return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + hm;
  }

  /* ------------------------------------------------------------------ *
   * 示例问题
   * ------------------------------------------------------------------ */

  var EXAMPLES = [
    '我该不该换工作？',
    '我和他现在的状态，下一步该怎么走？',
    '这件事我一直拖着，卡在哪里？',
    '我现在最需要知道的是什么？',
    '这个决定我该听理性还是听直觉？',
    '我要怎么和家里人说这件事？'
  ];

  function renderExamples(container, onPick) {
    clear(container);
    EXAMPLES.forEach(function (text) {
      var chip = el('button', 'example-chip', text);
      chip.type = 'button';
      chip.addEventListener('click', function () { onPick(text); });
      container.appendChild(chip);
    });
  }

  Tarot.Render = {
    el: el,
    clear: clear,
    $: $,
    /*
     * 尺寸系统。metrics() 是所有尺寸的唯一来源，CSS 只消费它写出的变量。
     * setViewportWidth 供 Node 测试指定屏幕宽度；浏览器里走 applyMetrics。
     */
    metrics: metrics,
    setViewportWidth: setViewportWidth,
    computeMetrics: computeMetrics,
    applyMetrics: applyMetrics,
    renderSpreadList: renderSpreadList,
    renderDeckOptions: renderDeckOptions,
    renderTable: renderTable,
    renderTableFoot: renderTableFoot,
    tableSize: tableSize,
    positionToPixels: positionToPixels,
    bonusLayout: bonusLayout,
    mergeBonus: mergeBonus,
    fanLayout: fanLayout,
    renderFan: renderFan,
    fanPrompt: fanPrompt,
    renderReadingPlaceholder: renderReadingPlaceholder,
    renderReadingLoading: renderReadingLoading,
    renderReadingError: renderReadingError,
    renderReading: renderReading,
    renderCardDetail: renderCardDetail,
    renderHistory: renderHistory,
    renderExamples: renderExamples,
    formatTime: formatTime,
    examples: EXAMPLES
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Tarot.Render;
})(typeof globalThis !== 'undefined' ? globalThis : this);
