/*
 * verify-layout.js —— 像素级排版验证
 *
 *     node verify-layout.js
 *
 * 这个文件的存在，是因为一个真实发生过、而且用户一眼就能看出来的 bug：
 * **牌位名被下面那张牌压住了**。
 *
 * 成因很朴素：纵向间距是按「牌高 166px」算的，但牌下方还画着牌位名（约 40px），
 * 而且牌位名比牌面还宽（120px vs 104px）。于是同列上下两张牌，只要纵向差不够
 * 205px，上面那张的牌位名就会落进下面那张的牌面里。
 *
 * 为什么已有的测试没抓到：
 *   verify.js        查的是坐标之间的「距离够不够」，不是真实像素；
 *   verify-browser.js 查的是 DOM 状态（类名、子节点数、style.top），不涉及尺寸；
 *   verify-css.js    查的是 CSS 规则本身有没有冲突。
 * 三者都不把「坐标 × 尺寸」还原成矩形。这个文件补的就是这一步。
 *
 * 它检查两件事：
 *   1. 所有牌阵（含追加补充牌之后）的牌面与牌位名两两不重叠
 *   2. 所有内容都在牌桌范围内，不会被裁掉
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var domino = require(path.join(__dirname, '.domtest', 'package', 'lib', 'index.js'));

var ROOT = __dirname;
var passed = 0;
var failures = [];

function section(name) {
  console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(0, 48 - name.length)));
}

function check(label, ok, detail) {
  if (ok) { passed += 1; return true; }
  failures.push(label + (detail ? '  → ' + detail : ''));
  console.log('  ✗ ' + label + (detail ? '  → ' + detail : ''));
  return false;
}

/* ================================================================== *
 * 尺寸：从渲染层拿，不从 CSS 里猜
 *
 * 早先这里是从 styles.css 里正则抠 --card-w / --card-h，因为那时尺寸有
 * 两个来源（JS 常量 + CSS 变量），必须比对它们是否一致。
 * 现在 render.js 是唯一来源、CSS 只是消费它写出的变量，所以这里直接问它——
 * 抠 CSS 反而会拿到一份可能过期的静态数字。
 *
 * 尺寸本身在后面（拿到 w 之后）才算，这里先留占位。
 * ================================================================== */

var CARD_W = 0;
var CARD_H = 0;
var CAPTION_W = 0;
var CAPTION_H = 0;

/* ================================================================== *
 * 搭建页面
 * ================================================================== */

var w = domino.createWindow(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
w.crypto = require('crypto').webcrypto;
w.requestAnimationFrame = function (cb) { return setTimeout(function () { cb(1); }, 0); };
w.AbortController = AbortController;
w.fetch = globalThis.fetch;
w.localStorage = null;

var ctx = vm.createContext(w);
['random.js', 'cards-major.js', 'cards-minor.js', 'cards.js', 'spreads.js', 'engine.js',
  'llm.js', 'render.js', 'app.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx, { filename: f });
  });

var d = w.document;
var ev = d.createEvent('Event');
ev.initEvent('DOMContentLoaded', true, true);
d.dispatchEvent(ev);

var T = w.Tarot;

/*
 * 尺寸从渲染层取。render.js 是唯一来源，CSS 只消费它写出的 CSS 变量，
 * 所以这里问它就好——不从 CSS 里抠，免得拿到一份过期的静态数字。
 *
 * 牌位名的宽和高也一并从 metrics 取（applyMetrics 就是用它写 CSS 变量的）。
 * 曾经这里是 `CARD_W * 1.15` 和 `CARD_H * 0.235`，而 render.js 里另算一遍——
 * 后来 computeMetrics 给 captionW 加了上限，测试这边没跟上，
 * 于是极窄屏上报出「重叠」，而实际渲染并不重叠：两套尺寸，说不清谁对。
 */
var M = T.Render.metrics();
CARD_W = M.cardW;
CARD_H = M.cardH;
CAPTION_W = Math.round(M.captionW);
CAPTION_H = Math.round(M.captionBlockH);

/* ================================================================== *
 * 牌面文字的行高与间距：**从 styles.css 读**，不在测试里重写一遍
 *
 * 「牌面五段文字放得下」这条断言要算内容高度，用到各段的行高和 margin。
 * 这些值写在样式表里，而 render.js 只提供字号（通过 CSS 变量）。
 *
 * 如果测试这边也写一份（原来是 1.2 / 1.1 / 1.25 / 3 / 2），CSS 改一行
 * 断言照样通过——而真机上文字可能已经顶到边框了。那正是这条断言要防的事。
 * ================================================================== */

var CF_LINE_HEIGHT = (function () {
  var css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  function num(selector, prop, fallback) {
    var block = css.match(new RegExp(selector.replace('.', '\\.') + '\\s*\\{([^}]*)\\}'));
    if (!block) return fallback;
    var m = block[1].match(new RegExp(prop + '\\s*:\\s*([\\d.]+)'));
    return m ? Number(m[1]) : fallback;
  }

  return {
    num: num('.cf-num', 'line-height', 1.2),
    glyph: num('.cf-glyph', 'line-height', 1.1),
    name: num('.cf-name', 'line-height', 1.25),
    en: num('.cf-en', 'line-height', 1.2),
    suit: num('.cf-suit', 'line-height', 1.2)
  };
})();

/** 各段的 margin 也一并从 CSS 读（glyph 用上下、en 用上） */
var CF_MARGIN = (function () {
  var css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  /** 读简写的 margin，返回 {top, bottom} */
  function margins(selector) {
    var block = css.match(new RegExp(selector.replace('.', '\\.') + '\\s*\\{([^}]*)\\}'));
    if (!block) return { top: 0, bottom: 0 };
    var m = block[1].match(/margin\s*:\s*([^;]+)/);
    var top = block[1].match(/margin-top\s*:\s*([\d.]+)px/);
    if (!m) return { top: top ? Number(top[1]) : 0, bottom: 0 };
    var parts = m[1].trim().split(/\s+/).map(function (v) { return parseFloat(v) || 0; });
    return {
      top: parts[0],
      bottom: parts.length >= 2 ? parts[2] !== undefined ? parts[2] : parts[0] : parts[0]
    };
  }

  var g = margins('.cf-glyph');
  var e = margins('.cf-en');
  return { glyphTop: g.top, glyphBottom: g.bottom, enTop: e.top };
})();

check('能从 styles.css 读到牌面各段的行高',
  CF_LINE_HEIGHT.num > 0 && CF_LINE_HEIGHT.glyph > 0 && CF_LINE_HEIGHT.name > 0 &&
  CF_LINE_HEIGHT.en > 0 && CF_LINE_HEIGHT.suit > 0,
  JSON.stringify(CF_LINE_HEIGHT));

check('能从 styles.css 读到牌面各段的 margin',
  CF_MARGIN.glyphTop >= 0 && CF_MARGIN.enTop >= 0,
  JSON.stringify(CF_MARGIN));

/*
 * 问题输入框的 placeholder 与 rows —— 从 index.html 读。
 *
 * 用来验「placeholder 在 rows 行之内能显示完整」。详见 runForViewport 里的说明。
 */
var QUESTION_FIELD = (function () {
  var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  var tag = html.match(/<textarea[^>]*id="question"[^>]*>/);
  if (!tag) return null;
  var ph = tag[0].match(/placeholder="([^"]*)"/);
  var rows = tag[0].match(/rows="(\d+)"/);
  return {
    placeholder: ph ? ph[1].replace(/&#10;/g, '\n') : '',
    rows: rows ? Number(rows[1]) : 3
  };
})();

check('能从 index.html 读到问题输入框的 placeholder 与 rows',
  Boolean(QUESTION_FIELD) && QUESTION_FIELD.placeholder.length > 0,
  QUESTION_FIELD ? ('placeholder ' + QUESTION_FIELD.placeholder.length +
    ' 字，rows=' + QUESTION_FIELD.rows) : '没找到 #question 的 textarea');

/* ================================================================== *
 * 几何工具
 *
 * 尺寸是「当前正在验证的那个视口」的，不是固定值——所以放在模块级的
 * CUR 里，由 runForViewport 在每轮开始时更新。
 * ================================================================== */

var CUR = { cardW: 0, cardH: 0, captionW: 0, captionH: 0 };

/**
 * 把一个牌位还原成两块真实矩形。
 *
 * 必须分两块：用一个大矩形会把牌面与牌位名之间的空白也算成内容，
 * 从而报出并不存在的重叠——这个坑我踩过。
 *
 * style.left 是百分比字符串，要按牌桌宽度换算；style.top 是 px。
 * 两者都是牌的中心点（.slot 用了 translate(-50%,-50%)）。
 */
function slotRects(node, baseWidth) {
  var rawLeft = String(node.style.left || '0');
  var cx = parseFloat(rawLeft) || 0;
  if (rawLeft.indexOf('%') >= 0) cx = (cx / 100) * baseWidth;
  var cy = parseFloat(node.style.top) || 0;
  var half = CUR.cardH / 2;

  return {
    face: {
      left: cx - CUR.cardW / 2, right: cx + CUR.cardW / 2,
      top: cy - half, bottom: cy + half
    },
    caption: {
      left: cx - CUR.captionW / 2, right: cx + CUR.captionW / 2,
      top: cy + half, bottom: cy + half + CUR.captionH
    }
  };
}

function intersect(a, b) {
  var ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  var oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (ox <= 0.5 || oy <= 0.5) return null;
  return { x: ox, y: oy, area: ox * oy };
}

/** 检查所有牌位之间的真实碰撞，返回最严重的一处 */
function collisionsIn(surface, baseWidth) {
  var rects = [];
  for (var i = 0; i < surface.children.length; i++) {
    rects.push(slotRects(surface.children[i], baseWidth));
  }

  var pairs = 0;
  var worst = null;
  for (var a = 0; a < rects.length; a++) {
    for (var b = a + 1; b < rects.length; b++) {
      var combos = [
        [rects[a].face, rects[b].face],
        [rects[a].face, rects[b].caption],
        [rects[a].caption, rects[b].face],
        [rects[a].caption, rects[b].caption]
      ];
      for (var c = 0; c < combos.length; c++) {
        var hit = intersect(combos[c][0], combos[c][1]);
        if (!hit) continue;
        pairs += 1;
        if (!worst || hit.area > worst.area) {
          worst = { a: a, b: b, x: hit.x, y: hit.y, area: hit.area };
        }
      }
    }
  }
  return { pairs: pairs, worst: worst };
}

function buildResult(spreadKey) {
  var session = T.Engine.prepareFan({ spreadKey: spreadKey, question: '排版验证' });
  for (var i = 0; i < session.needed; i++) T.Engine.takeFromFan(session, 0);
  return T.Engine.finalizeDraw(session);
}

function renderInto(result) {
  var surface = d.getElementById('tableSurface');
  T.Render.renderTable(surface, result, { onCardClick: function () {} });
  return surface;
}

/* ================================================================== *
 * 测试主体：对每一种视口各跑一遍
 *
 * 这是这个文件最重要的结构决定。
 *
 * 手机适配出问题的地方，恰恰是桌面尺寸下测不出来的：320px 宽的牌桌装 56px
 * 的牌、扇形每行放 9 张、凯尔特十字纵向要滚两屏——这些在 900px 的基准宽下
 * 全都正常。只测一种尺寸的排版测试，对响应式改造几乎没有价值。
 * ================================================================== */

/**
 * 参与验证的视口。触摸与否也会改变扇形参数，所以一起列出。
 *
 * 320 和 280 这两个极窄档是**特意加进来**的：原来最小只到 360，
 * 而「牌桌被 MIN_BASE_WIDTH 抬到比容器还宽」这个 bug 只在视口 < 338px 时出现
 * （320px 的真实可用是 262px，牌桌却按 280 布局，右列被 overflow:hidden 裁掉）。
 * 列表里没有更窄的档，这个问题就一直藏着。
 *
 * 320 对应老 iPhone SE / 小屏安卓；280 对应 Galaxy Fold 的外屏。
 */
var VIEWPORTS = [
  { name: '极窄 280', vw: 280, touch: true },
  { name: '极窄 320', vw: 320, touch: true },
  { name: '手机 360', vw: 360, touch: true },
  { name: '手机 390', vw: 390, touch: true },
  { name: '手机 430', vw: 430, touch: true },
  { name: '平板 768', vw: 768, touch: true },
  { name: '桌面 1280', vw: 1280, touch: false },
  { name: '桌面 1440', vw: 1440, touch: false }
];

function runForViewport(vp) {
  var m = T.Render.setViewportWidth(vp.vw, vp.touch);

  /*
   * 几何工具（slotRects / collisionsIn）读这个，所以每轮开头必须先更新。
   *
   * 牌位名的宽和高都**从 metrics 取**，不在这里另算一遍。
   *
   * 原来写的是 `Math.round(m.cardW * 1.15)` 和 `Math.round(m.cardH * 0.235)`——
   * 和 render.js 各算一遍。而 computeMetrics 后来给 captionW 加了「不能宽于
   * 最密列间距」的上限，测试这边没跟着改，于是极窄屏上测试仍按旧值算矩形、
   * 报出「牌位名重叠」，而实际渲染已经不重叠了。**测试和实现两套尺寸，
   * 谁对谁错都说不清**。现在只有一个来源。
   */
  CUR.cardW = m.cardW;
  CUR.cardH = m.cardH;
  CUR.captionW = Math.round(m.captionW);
  CUR.captionH = Math.round(m.captionBlockH);

  section(vp.name + '（牌 ' + m.cardW + '×' + m.cardH +
    '，牌桌 ' + m.baseWidth + '，扇形一行 ' + m.fanPerRow + ' 张）');

  var cardW = CUR.cardW;
  var cardH = CUR.cardH;
  var captionW = CUR.captionW;
  var captionH = CUR.captionH;

  /* ---- 尺寸自洽 ---- */

  check(vp.name + '：牌位名不比牌面窄太多', captionW >= cardW,
    captionW + ' vs ' + cardW);

  var pxPerUnit = m.pxPerUnit;

  /*
   * 纵向间距与实测尺寸的关系。
   *
   * 这三条要一起成立，缺一条排版就会出问题：
   *
   *   1. 阈值 ≥ 实测需要 —— 否则牌阵自检会放过真实的压盖
   *   2. 行距留出可见的缝 —— 只满足第 1 条还不够。「刚好接上」看着像标签
   *      贴在下一行的牌上（间隙 0 的版本用户反馈过）
   *   3. 行距不能大得离谱 —— 否则牌阵被撑得很空
   *
   * 注意 minDy 是**坐标间距**，和像素刻度是两件事：pxPerUnit 里带了行距余量
   * （ROW_GAP_SLACK），所以「实测需要多少单位」会略小于 minDy——这是对的，
   * 差值就是那道缝。
   */
  var needUnits = (cardH + m.captionBlockH) / pxPerUnit;
  var rowGapPx = T.Spreads.minDy * pxPerUnit;
  var slackPx = rowGapPx - (cardH + m.captionBlockH);

  console.log('  纵向：阈值 ' + T.Spreads.minDy + ' 单位，实测需要 ' +
    needUnits.toFixed(1) + ' 单位，行距 ' + rowGapPx.toFixed(1) +
    'px（余量 ' + slackPx.toFixed(1) + 'px）');

  check(vp.name + '：自检阈值不小于实测需要（否则会放过压盖）',
    T.Spreads.minDy >= needUnits - 0.5,
    'minDy=' + T.Spreads.minDy + '，需要 ' + needUnits.toFixed(1));

  check(vp.name + '：行距留出可见的缝（4px 以上）',
    slackPx >= 4,
    '只留了 ' + slackPx.toFixed(1) + 'px，标签会贴到下一行的牌上');

  check(vp.name + '：行距没有空得离谱（不超过一格的 25%）',
    slackPx <= (cardH + m.captionBlockH) * 0.25,
    '留了 ' + slackPx.toFixed(1) + 'px');

  /*
   * 牌面上的五段文字必须放得进牌的高度，而且要留出余量。
   *
   * 这一条直接对应「字快贴到牌的边框上了」：五段文字加上下内边距如果刚好占满
   * 牌高，文字就会顶到边框。余量少于 4px 就说明挤了。
   *
   * **字号和行高都不能在这里重新写死**：
   *   字号 —— 由 render.js 算好写进 CSS 变量，从 metrics 取（fontNum 等）。
   *           原来这里写的是 `Math.max(7, Math.round(m.cardW * 0.096))`，
   *           而 .cf-en / .cf-suit 干脆写死 8.5 / 10——那两个后来改成了
   *           CSS 变量（--card-en / --card-suit），字号随牌宽缩，
   *           测试这边没跟着改，于是「放得下」这条算的是过期的尺寸。
   *   行高 —— 写在 styles.css 里，从样式表读。
   *
   * 两边各写一份的话，CSS 改一行（比如把 .cf-num 的行高从 1.2 改成 3），
   * 这条断言依旧通过，而真机上文字顶到边框——正是它声称要防的事。
   */
  var lh = CF_LINE_HEIGHT;
  var mg = CF_MARGIN;

  var frontContentH =
    m.fontNum * lh.num +                                  // .cf-num
    m.fontGlyph * lh.glyph + mg.glyphTop + mg.glyphBottom +   // .cf-glyph
    m.fontTitle * lh.name +                               // .cf-name
    m.fontEn * lh.en + mg.enTop +                         // .cf-en
    m.fontSuit * lh.suit;                                 // .cf-suit
  var frontAvailH = cardH - m.cardPadY * 2;
  var frontSlack = frontAvailH - frontContentH;

  check(vp.name + '：牌面五段文字放得下且有余量（4px 以上）',
    frontSlack >= 4,
    '内容 ' + frontContentH.toFixed(0) + 'px（字号 数字' + m.fontNum +
    '/符号' + m.fontGlyph + '/牌名' + m.fontTitle + '/英文' + m.fontEn +
    '/花色' + m.fontSuit + '），可用 ' + frontAvailH.toFixed(0) +
    'px，只剩 ' + frontSlack.toFixed(1) + 'px');

  check(vp.name + '：牌面内边距不薄于 8px',
    m.cardPadY >= 8, '内边距 ' + m.cardPadY + 'px');

  /*
   * 输入框的 placeholder 必须在 rows 行之内显示完整。
   *
   * 这是用户实际报过的问题：placeholder 里塞了三行文字，而 textarea 是 rows=3，
   * 显示时第三行被边框截掉一半，用户看不全那句话。
   *
   * placeholder 不是放说明的地方——说明该放到它下面的 field-hint 里，
   * 那段文字是普通元素，会自己撑高，不会被输入框裁掉。
   *
   * 这里按最窄的情况算：触摸设备上输入框字号是 16px（为了防 iOS 自动缩放），
   * 比桌面大，所以每行装的字更少。
   */
  var phInfo = QUESTION_FIELD;
  if (phInfo) {
    // 输入框是 width:100%，内容宽 = 牌区内容宽 − 自身 padding(12×2) − 边框(1×2)
    var taW = m.baseWidth - 26;
    var fontPx = m.isTouch ? 16 : 14;
    // 中文按全角（=字号）算，英文数字按 0.55 倍
    var phWidth = 0;
    for (var pi = 0; pi < phInfo.placeholder.length; pi++) {
      var ch = phInfo.placeholder.charAt(pi);
      phWidth += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch)
        ? fontPx : fontPx * 0.55;
    }
    var phLines = Math.max(1, Math.ceil(phWidth / taW));

    check(vp.name + '：输入框 placeholder 在 rows 行内显示得下',
      phLines <= phInfo.rows,
      'placeholder ' + phInfo.placeholder.length + ' 字，需 ' + phLines +
      ' 行，而 rows=' + phInfo.rows + '（输入框内容宽约 ' + taW + 'px）');
  }

  /*
   * 基准宽与「视口 − 各层内边距」的关系。
   *
   * 这一条同时抓两种病，两个方向都出过：
   *   算大了 → 牌桌超出容器，最右一列的牌被裁掉（「右边的牌显示不全」）
   *   算小了 → 牌桌铺不满容器，右侧多出空白，整块看着靠左
   *
   * **期望值必须从 styles.css 里读**，不能写死。原来写的是 `(10+13+6)*2 = 58`，
   * 而 render.js 的 SMALL_SIDE_LOSS 也正好是 58——两边同时写死同一个数，
   * 断言就退化成 `|vw-58-(vw-58)| <= 0.5`，恒真；注释还声称「数值来自
   * styles.css 的媒体查询」，实际一步都没读 CSS。它想抓的脱钩正是它抓不到的。
   *
   * 现在从样式表里解析出各层的左右内边距求和，CSS 一改这里就会跟着变，
   * 而 render.js 的常量不会——脱钩立刻显形。
   */
  var narrow = vp.vw <= 640;

  /** 从 CSS 里取某个选择器第一条规则的左右 padding 之和 */
  function paddingLR(selector, source) {
    var m = source.match(new RegExp(selector.replace('.', '\\.') + '\\s*\\{([^}]*)\\}'));
    if (!m) return null;
    var p = m[1].match(/padding:\s*([^;]+)/);
    if (!p) return null;
    var parts = p[1].trim().split(/\s+/).map(function (v) { return parseFloat(v) || 0; });
    var l = parts.length === 1 ? parts[0] : parts[1];
    var r = parts.length === 1 ? parts[0]
      : (parts.length >= 4 ? parts[3] : parts[1]);
    return l + r;
  }

  var cssPlain = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  var narrowBlock = cssPlain.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/);
  var narrowCss = narrowBlock ? narrowBlock[1] : '';

  var layoutPad = paddingLR('.layout', narrow ? narrowCss : cssPlain);
  var panelPad = paddingLR('.panel', narrow ? narrowCss : cssPlain);
  var wrapPad = narrow ? (paddingLR('.table-wrap', narrowCss) || 0) : 0;

  var cssChrome = (layoutPad === null || panelPad === null)
    ? null : layoutPad + panelPad + wrapPad;
  var exactW = cssChrome === null ? null : vp.vw - cssChrome;

  check(vp.name + '：能从 styles.css 读出各层内边距',
    cssChrome !== null,
    'layout=' + layoutPad + ' panel=' + panelPad + ' wrap=' + wrapPad);

  if (cssChrome !== null) {
    check(vp.name + '：基准宽不超过可用宽度', m.baseWidth <= exactW + 0.5,
      '基准宽 ' + m.baseWidth + '，可用 ' + exactW +
      '（CSS 内边距合计 ' + cssChrome + '）');

    if (narrow) {
      check(vp.name + '：窄屏基准宽正好铺满可用宽度',
        Math.abs(m.baseWidth - exactW) <= 0.5,
        '基准宽 ' + m.baseWidth + '，应为 ' + exactW +
        '（算小了右侧会多出空白，整块看着靠左）');
    }
  }

  /*
   * 待挑牌区：每一行都要放得进容器。
   *
   * 这个区域以前没被逐视口检查过——只验了「同一行不重叠」，那管不住
   * 「整行超出右边缘被裁掉」。牌区宽度是按基准宽算的，而一行几张是它自己
   * 推的，两者一旦不匹配，最右边那张就会被 overflow:hidden 裁掉一截。
   */
  [78, 22, 5, 1].forEach(function (cardCount) {
    var layout = T.Render.fanLayout(cardCount);
    var rowGroups = {};
    layout.positions.forEach(function (p) {
      var key = String(p.top);
      if (!rowGroups[key]) rowGroups[key] = [];
      rowGroups[key].push(p);
    });

    var worstRight = -Infinity;
    var worstLeft = Infinity;
    Object.keys(rowGroups).forEach(function (key) {
      rowGroups[key].forEach(function (p) {
        if (p.left + m.fanCardW > worstRight) worstRight = p.left + m.fanCardW;
        if (p.left < worstLeft) worstLeft = p.left;
      });
    });

    check(vp.name + '：待挑牌 ' + cardCount + ' 张时右边缘不出界',
      worstRight <= layout.width + 0.5,
      '最右 ' + worstRight.toFixed(1) + '，区域宽 ' + layout.width);
    check(vp.name + '：待挑牌 ' + cardCount + ' 张时左边缘不出界',
      worstLeft >= -0.5,
      '最左 ' + worstLeft.toFixed(1));
  });

  // 触摸设备的待挑牌不能小于 44px，否则手指点不准
  if (m.isTouch) {
    check(vp.name + '：待挑牌不小于 44px（触摸目标）',
      m.fanCardW >= 44, '实际 ' + m.fanCardW + 'px');
  }

  /* ---- 每个牌阵 ---- */

  T.Spreads.all.forEach(function (spread) {
    var result = buildResult(spread.key);
    var surface = renderInto(result);
    var size = T.Render.tableSize(result);

    var found = collisionsIn(surface, size.width);
    check(vp.name + ' ' + spread.name + '：互不压盖', found.pairs === 0,
      found.pairs + ' 处重叠' + (found.worst
        ? '，最严重 ' + Math.round(found.worst.x) + '×' + Math.round(found.worst.y) + 'px'
        : ''));

    var outside = [];
    for (var i = 0; i < surface.children.length; i++) {
      var box = slotRects(surface.children[i], size.width);
      if (box.face.left < -1 || box.face.right > size.width + 1) {
        outside.push(spread.positions[i].title + ' 横向越界');
      }
      if (box.face.top < -1) outside.push(spread.positions[i].title + ' 顶部越界');
      if (box.caption.bottom > size.height + 1) {
        outside.push(spread.positions[i].title + ' 牌位名被裁');
      }
    }
    check(vp.name + ' ' + spread.name + '：内容都在牌桌内', outside.length === 0,
      outside.join('，'));
  });

  /* ---- 补充牌 ---- */

  T.Spreads.all.forEach(function (spread) {
    var base = buildResult(spread.key);
    var merged = T.Render.mergeBonus(base, T.Engine.extraCards(base, 3));
    var surface = renderInto(merged);
    var size = T.Render.tableSize(merged);

    var found = collisionsIn(surface, size.width);
    check(vp.name + ' ' + spread.name + ' + 3 张补充：互不压盖', found.pairs === 0,
      found.pairs + ' 处重叠');
  });

  var manyBase = buildResult('single');
  var manyMerged = T.Render.mergeBonus(manyBase, T.Engine.extraCards(manyBase, 15));
  var manySurface = renderInto(manyMerged);
  var manySize = T.Render.tableSize(manyMerged);
  var manyFound = collisionsIn(manySurface, manySize.width);
  check(vp.name + ' 补 15 张：互不压盖', manyFound.pairs === 0, manyFound.pairs + ' 处重叠');

  /* ---- 扇形 ---- */

  [78, 40, 22, 10, 3, 1].forEach(function (n) {
    var layout = T.Render.fanLayout(n);
    check(vp.name + ' 扇形 ' + n + ' 张：位置数一致', layout.positions.length === n);

    var step = layout.positions.length > 1
      ? layout.positions[1].left - layout.positions[0].left
      : m.fanCardW;

    /*
     * 可点性。这是手机适配的核心指标——桌面原本每张只露 22px，
     * 鼠标点得准，手指点不准。
     */
    var minStep = vp.touch ? 30 : 20;
    check(vp.name + ' 扇形 ' + n + ' 张：每张露出 ≥' + minStep + 'px',
      Math.min(step, m.fanCardW) >= minStep - 0.5,
      '露出 ' + step.toFixed(1) + 'px');

    // 扇形里的牌不能越界
    var over = layout.positions.filter(function (p) {
      return p.left < -1 || p.left + m.fanCardW > layout.width + 1 || p.top < -1;
    });
    check(vp.name + ' 扇形 ' + n + ' 张：都在区域内', over.length === 0,
      over.length + ' 张越界');
  });

  /*
   * 78 张牌区的规模要合理。
   *
   * 原来只有一条 `big.height < vp.vw * 4`——拿视口宽当高度上限，这两个量本来
   * 没关系。加进极窄档之后它开始误报：280px 下 78 张要排 23 行、高 1608px，
   * 而阈值是 1120。可「屏窄所以行多」是必然的，不是 bug。
   *
   * 换成两条直接表达意图的：
   *   横向没浪费 —— 一行至少放得下 3 张
   *   没有多排   —— 行数正好等于「总数 ÷ 每行容量」向上取整
   */
  var big = T.Render.fanLayout(78);

  check(vp.name + '：一行至少放得下 3 张', m.fanPerRow >= 3,
    '实际一行 ' + m.fanPerRow + ' 张（牌区宽 ' + m.baseWidth +
    '，每格 ' + m.fanCell + '）');

  check(vp.name + '：78 张的行数没有多排',
    big.rows === Math.ceil(78 / m.fanPerRow),
    big.rows + ' 行，理论最少 ' + Math.ceil(78 / m.fanPerRow) + ' 行');

  check(vp.name + '：78 张的位置数正确', big.positions.length, 78);

  console.log('');
}

VIEWPORTS.forEach(runForViewport);

// 收尾：把尺寸恢复成桌面，免得影响别的断言
T.Render.setViewportWidth(1024, false);

/* ================================================================== *
 * 量容器宽度这条主路径
 *
 * 浏览器里尺寸的基准宽来自**实测** .table-wrap 的 clientWidth，而不是从视口
 * 减去一个估算的内边距损耗。原因是那些损耗全在 CSS 里（页面/面板/牌区的
 * 内边距、滚动条宽度），JS 猜不准——改一次媒体查询就得同步改常量，迟早对不上。
 *
 * 这条路径必须单独验：它依赖 clientWidth，而精简直的 DOM 里那个属性恒为 0。
 * 如果它悄悄失效，浏览器会退回「按视口推算」，多减或少减几个像素——
 * 表现为牌桌两侧要么挤出横向滚动条，要么白白空一条。这种偏差肉眼不容易发现。
 * ================================================================== */

section('容器宽度实测');

var wrapEl = d.querySelector('.table-wrap');
check('页面上找得到 .table-wrap（实测的取样点）', Boolean(wrapEl));

/** 注入一个假的 clientWidth。（domino 没有布局引擎，得替它回答） */
function stubClientWidth(node, value) {
  Object.defineProperty(node, 'clientWidth', {
    get: function () { return value; },
    configurable: true
  });
}

if (wrapEl) {
  // 1. 合理的实测值必须被采用
  stubClientWidth(wrapEl, 330);
  var measured = T.Render.applyMetrics();
  check('采用实测到的容器宽度', measured.baseWidth === 330,
    'baseWidth=' + measured.baseWidth);

  // 2. 过小的值要拒绝——否则会算出荒谬的小牌
  stubClientWidth(wrapEl, 12);
  var rejected = T.Render.applyMetrics();
  /*
   * 期望值要精确到「推算路径会算出什么」。
   *
   * 原来写的是 `rejected.baseWidth > 200`——201 到无穷全都过，
   * 区分不了「正确退回推算」和「随便返回一个 250」。而这条恰恰是
   * 「量到的值不可信时就别信它」这个逻辑的守门人。
   *
   * 12px 的容器显然无效（比一张牌还窄）。此时应该整个退回推算路径；
   * 桌面默认视口（1024）下推算结果是 BASE_WIDTH_MAX = 900。
   */
  check('拒绝过小的实测值（退回推算路径，得到 900）',
    Math.abs(rejected.baseWidth - 900) < 0.5,
    'baseWidth=' + rejected.baseWidth);

  // 3. 0 要安全退回，不能崩
  stubClientWidth(wrapEl, 0);
  var zeroed;
  try {
    zeroed = T.Render.applyMetrics();
    check('实测值为 0 时安全退回（同样得到 900）',
      Math.abs(zeroed.baseWidth - 900) < 0.5,
      'baseWidth=' + zeroed.baseWidth);
  } catch (e) {
    check('实测值为 0 时安全退回', false, '抛错了：' + e.message);
  }

  // 4. 上限仍然生效：容器再宽，牌桌也不超过桌面基准宽
  stubClientWidth(wrapEl, 2000);
  var capped = T.Render.applyMetrics();
  check('容器很宽时基准宽仍受上限约束', capped.baseWidth === 900,
    'baseWidth=' + capped.baseWidth);

  // 5. 窄屏实测值要真的变小（这是手机适配的根据）
  stubClientWidth(wrapEl, 293);
  var narrow = T.Render.applyMetrics();
  check('窄容器得到窄基准宽', narrow.baseWidth === 293,
    'baseWidth=' + narrow.baseWidth);
  /*
   * 牌宽要精确对上公式，不能只验「< 108」。
   *
   * 原来写的是 `narrow.cardW < 901 * 0.12`（=108.12），而实测是 56——
   * 任何小于 108 的值都能过，包括明显错误的 100。判别力接近零。
   *
   * 期望值按 computeMetrics 的公式算：max(56, round(293 * 104/900)) = 56。
   */
  var expectCardW = Math.max(56, Math.min(104, Math.round(293 * 104 / 900)));
  check('窄容器下牌宽正好按公式缩小', narrow.cardW === expectCardW,
    '牌宽 ' + narrow.cardW + '，应为 ' + expectCardW);
  check('窄容器的牌确实比桌面的小', narrow.cardW < 104,
    '牌宽 ' + narrow.cardW);

  // 收尾：把这个替身撤掉，别影响后续
  delete wrapEl.clientWidth;
  T.Render.setViewportWidth(1024, false);
}

/* ================================================================== *
 * 汇总
 *
 * 断言数基线。
 *
 * 这个文件里有多处 `if (xxx) { ...若干条断言... }` 的守卫块（例如
 * 「量容器宽度这条主路径」那一节的 wrapEl 取不到时，整节 7 条会被跳过），
 * 条件不成立时套件仍然打印「全部通过」，只是断言数悄悄变少。
 * 本项目已经踩过一次这个坑：8 条断言静默失效，靠「测试数怎么没变」才发现。
 *
 * 所以最后核对一次总数。**加了新断言或新视口就把这个数改大**；
 * 它变小，就说明有东西被跳过了。
 * ================================================================== */

var MIN_EXPECTED_ASSERTIONS = 478;

if (passed < MIN_EXPECTED_ASSERTIONS) {
  failures.push('断言数不足：只跑了 ' + passed + ' 项，基线是 ' +
    MIN_EXPECTED_ASSERTIONS + ' 项。多半是某个 if 守卫没成立、整块断言被跳过了。');
}

console.log('\n' + '='.repeat(60));
if (failures.length === 0) {
  console.log('全部通过：' + passed + ' 项断言（像素级排版）');
  console.log('='.repeat(60));
  process.exit(0);
}
console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项：');
failures.forEach(function (f) { console.log('  ✗ ' + f); });
console.log('='.repeat(60));
process.exit(1);
