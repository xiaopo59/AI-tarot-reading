/*
 * verify-css.js —— 样式层静态检查
 *
 *     node verify-css.js
 *
 * 这个文件的存在，是因为一个真实发生过的、让整个页面不可用的 bug：
 *
 *   CSS 里写了 .modal { display: grid; }，而浏览器自带的 [hidden] { display: none }
 *   是属性选择器，特异性压不过作者样式表里的类选择器。于是三个弹窗在页面加载时
 *   就全部显示出来，position: fixed; inset: 0 铺满视口叠在一起，把整页按钮都挡住——
 *   用户看到的现象是「点什么都没反应」。
 *
 * 为什么另外三套测试都没抓到它：它们检查的是 DOM**状态**（hidden 属性、类名、
 * 子节点），而这是**样式计算**的问题。DOM 引擎不做 CSS 级联，所以只能靠静态
 * 分析 CSS，或者靠人眼看。
 *
 * 这个文件就是那次教训的产物：把所有「带 hidden 属性的元素」和「CSS 里给它们
 * 设 display 的规则」对一遍，任何可能让 [hidden] 失效的写法都会在这里失败。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = __dirname;
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

var passed = 0;
var failures = [];

function section(name) {
  console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(0, 50 - name.length)));
}

function check(label, ok, detail) {
  if (ok) { passed += 1; return true; }
  failures.push(label + (detail ? '  → ' + detail : ''));
  console.log('  ✗ ' + label + (detail ? '  → ' + detail : ''));
  return false;
}

/* ================================================================== *
 * 1. 全局 [hidden] 兜底
 * ================================================================== */

section('[hidden] 兜底规则');

check('styles.css 里有 [hidden] { display: none !important; }',
  /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/.test(css),
  '缺少这条规则时，任何给元素设 display 的类都会让 hidden 属性失效');

/* ================================================================== *
 * 2. 逐个检查带 hidden 属性的元素
 * ================================================================== */

section('带 hidden 属性的元素');

/** 从 HTML 里抠出所有带 hidden 属性的元素 */
function hiddenElements(source) {
  var out = [];
  var re = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*\bhidden\b[^>]*)>/g;
  var m;
  while ((m = re.exec(source)) !== null) {
    var attrs = m[2];
    var idMatch = attrs.match(/id="([^"]+)"/);
    var classMatch = attrs.match(/class="([^"]+)"/);
    // hidden 作为独立属性出现（排除 hidden="until-found" 这种带值的写法另说）
    out.push({
      tag: m[1],
      id: idMatch ? idMatch[1] : null,
      classes: classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : []
    });
  }
  return out;
}

var hiddenInHtml = hiddenElements(html);
check('HTML 里确实有带 hidden 的元素（说明解析生效）', hiddenInHtml.length > 0,
  '找到 ' + hiddenInHtml.length + ' 个');

console.log('  找到 ' + hiddenInHtml.length + ' 个：' +
  hiddenInHtml.map(function (e) { return e.id || e.tag; }).join(', '));

/**
 * 在 CSS 里找出所有给某个类设置 display 的规则，返回选择器文本。
 * 只做粗粒度解析（够用即可）：按 } 切块，看每块的选择器和声明。
 */
function rulesSettingDisplayFor(className) {
  var hits = [];
  var blocks = css.split('}');
  blocks.forEach(function (block) {
    var brace = block.indexOf('{');
    if (brace < 0) return;
    var selector = block.slice(0, brace).trim();
    var body = block.slice(brace + 1);
    if (!/display\s*:/.test(body)) return;
    // 选择器里是否引用了这个类（.foo 形式，避免 .foo-bar 误命中）
    var re = new RegExp('\\.' + className.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '(?![\\w-])');
    if (re.test(selector)) {
      var displayValue = (body.match(/display\s*:\s*([^;!]+)/) || [])[1];
      hits.push(selector + ' { display: ' + String(displayValue).trim() + ' }');
    }
  });
  return hits;
}

/*
 * 这一节原来有三条断言，写法都是 `xxx || hasGlobalGuard`——只要全局兜底规则
 * 在（49 行已经单独验过），它们就恒为真，**永远不会失败**。
 * 也就是说：本文件「存在的理由」那两条其实没有判别力。
 *
 * 换成真会红的判据。兜底规则 `[hidden]{display:none !important}` 之所以能压住
 * `.modal{display:grid}`，靠的是 `!important`——两者特异性相同（都是 0,1,0），
 * 没有 !important 的话后出现的那条赢，弹窗就会永远显示。
 * 所以真正要守的是这两件事：
 *   1. 兜底规则必须带 !important
 *   2. 给这些元素设 display 的类规则**不能**也带 !important
 *      （带了就反压兜底，同样会让 hidden 失效）
 */
check('全局兜底规则用了 !important（否则压不住 .modal{display:grid}）',
  /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css),
  '兜底规则缺 !important，特异性与 .modal 相同，后出现的会赢');

/** 找出所有「给某类设 display」的规则，返回带 !important 的那些 */
function displayRulesWithImportant(className) {
  var out = [];
  var re = new RegExp('\\.' + className + '\\s*\\{([^}]*)\\}', 'g');
  var m;
  while ((m = re.exec(css))) {
    var d = m[1].match(/display:\s*[^;]+/);
    if (d && /!important/.test(d[0])) out.push(d[0].trim());
  }
  return out;
}

var importantConflicts = [];
hiddenInHtml.forEach(function (element) {
  element.classes.forEach(function (className) {
    var bad = displayRulesWithImportant(className);
    if (bad.length) {
      importantConflicts.push((element.id || element.tag) + ' 的 .' + className +
        '：' + bad.join('；'));
    }
  });
});

check('没有「用 !important 反压兜底规则」的类（那会让 hidden 失效）',
  importantConflicts.length === 0,
  importantConflicts.join(' | '));

// 具体点名面板：这三个是动态切换 hidden 的，必须能真的隐藏
['panelTable', 'panelReading'].forEach(function (id) {
  var present = html.indexOf('id="' + id + '"') >= 0;
  check('页面上存在 #' + id, present);
  if (!present) return;
  var tagMatch = html.match(new RegExp('<[^>]*id="' + id + '"[^>]*>'));
  var classMatch = tagMatch ? tagMatch[0].match(/class="([^"]+)"/) : null;
  var classes = classMatch ? classMatch[1].split(/\s+/) : ['panel'];
  var conflicts = [];
  classes.forEach(function (c) {
    var bad = displayRulesWithImportant(c);
    if (bad.length) conflicts.push('.' + c + '：' + bad.join('；'));
  });
  check('#' + id + ' 的类不会用 !important 让 hidden 失效', conflicts.length === 0,
    conflicts.join(' | '));
});

/* ================================================================== *
 * 3. 弹窗必须默认不可见
 * ================================================================== */

section('弹窗默认状态');

['settingsModal', 'historyModal', 'cardModal'].forEach(function (id) {
  var re = new RegExp('<[^>]*id="' + id + '"[^>]*>');
  var match = html.match(re);
  check('#' + id + ' 在 HTML 里带 hidden 属性', Boolean(match) && / hidden[\s>]/.test(match[0]),
    match ? match[0].slice(0, 90) : '找不到这个元素');
});

/*
 * .modal 是最危险的一个：它设了 display: grid 且 position: fixed; inset: 0，
 * 一旦可见就挡住整页。
 *
 * 原来这条是 `modalRules.length === 0 || hasGlobalGuard`——只要兜底规则在就恒真。
 * 换成会红的判据：.modal 的 display 规则本身**不能带 !important**
 * （带了就反压兜底，弹窗永远关不掉），而且兜底规则必须能覆盖它
 * （靠 !important，两者的特异性都是 0,1,0）。
 */
var modalRules = rulesSettingDisplayFor('modal');
var modalImportant = displayRulesWithImportant('modal');

check('.modal 设了 display（这是需要兜底的原因）', modalRules.length > 0,
  '找不到 .modal 的 display 规则');
check('.modal 的 display 没有用 !important（用了会反压兜底，弹窗关不掉）',
  modalImportant.length === 0,
  modalImportant.join('；'));

// 确认 .modal 是铺满视口的——所以它一旦可见就会挡住整页，必须能隐藏
var modalBlock = css.match(/\.modal\s*\{[^}]*\}/);
check('.modal 确实是 fixed + inset: 0（因此必须能隐藏）',
  Boolean(modalBlock) && /position:\s*fixed/.test(modalBlock[0]) && /inset:\s*0/.test(modalBlock[0]),
  modalBlock ? modalBlock[0].slice(0, 100) : '找不到 .modal 规则');

/* ================================================================== *
 * 4. 反向检查：确认兜底规则不会误伤
 * ================================================================== */

section('兜底规则的影响范围');

// [hidden] 的兜底规则会作用于所有带该属性的元素，所以这里要把它们列全：
// 结果面板、扇形面板（都是动态显示）、三个弹窗、以及提示条 #toast。
// 漏一个都意味着某处可能「该隐藏却显示」。
var hiddenIds = hiddenInHtml.map(function (e) { return e.id; }).filter(Boolean);
eq('带 hidden 的元素都是预期的', hiddenIds.sort().join(','),
  ['btnFanDone', 'cardModal', 'historyModal', 'panelFan', 'panelReading', 'panelTable',
    'questionQuality', 'settingsModal', 'toast'].sort().join(','));

function eq(label, actual, expected) {
  return check(label, actual === expected, '期望 ' + expected + '，实际 ' + actual);
}

/* ================================================================== *
 * 5. 其他容易踩的样式坑
 * ================================================================== */

section('其他静态样式检查');

// @keyframes 必须配平（少一个括号会让后面所有规则失效）
var openBraces = (css.match(/\{/g) || []).length;
var closeBraces = (css.match(/\}/g) || []).length;
check('CSS 花括号配平', openBraces === closeBraces,
  '{ ' + openBraces + ' 个，} ' + closeBraces + ' 个');

// 卡片尺寸变量必须定义。它们是 render.js 写 CSS 变量的落点，
// 同时也是「JS 没跑起来」时的兜底值。
check('定义了 --card-w 与 --card-h',
  /--card-w:/.test(css) && /--card-h:/.test(css));

/*
 * 尺寸的单一来源。
 *
 * 早先这里比对「render.js 里的 CARD_W 常量」和「CSS 里的 --card-w 变量」是否
 * 相等——因为那时尺寸有两个来源，必须手工保持一致。手机适配需要两套尺寸，
 * 四处硬编码立刻就会走样，所以改成了：render.js 算，CSS 只消费它写出的变量。
 *
 * 于是这里要验的东西也变了——不再是「两个数字相等」，而是：
 *   1. 那几个变量确实由 render.js 写入（单一来源成立）
 *   2. CSS 里没有把会随屏幕变的尺寸写死（写死了就失去了响应式）
 */
var renderJs = fs.readFileSync(path.join(ROOT, 'js', 'render.js'), 'utf8');

check('render.js 会写 --card-w 变量',
  /setProperty\(\s*'--card-w'/.test(renderJs));
check('render.js 会写 --card-h 变量',
  /setProperty\(\s*'--card-h'/.test(renderJs));
check('render.js 会写 --caption-w 变量',
  /setProperty\(\s*'--caption-w'/.test(renderJs));

// 尺寸由 computeMetrics 算出，applyMetrics 写进 DOM——两个函数都要在
check('render.js 有 computeMetrics（尺寸的唯一来源）',
  /function computeMetrics\s*\(/.test(renderJs));
check('render.js 有 applyMetrics（把尺寸写进 CSS 变量）',
  /function applyMetrics\s*\(/.test(renderJs));

/*
 * 会随屏幕变的东西不能在 CSS 里写死。
 * 这一条抓的是真实的类别错误：.slot-caption 的宽度曾经写死 120px，
 * 而手机上牌只有 56px 宽——牌位名比牌还宽，相邻两张就互相压住。
 */
var captionBlock = css.match(/\.slot-caption\s*\{[^}]*\}/);
check('牌位名宽度用变量而不是写死像素',
  Boolean(captionBlock) && /width:\s*var\(--caption-w\)/.test(captionBlock[0]),
  captionBlock ? (captionBlock[0].match(/width:[^;]*/) || ['(没有 width)'])[0] : '找不到 .slot-caption');

// 卡片字号同样要跟着牌的大小走
['--card-title', '--card-glyph', '--card-num'].forEach(function (name) {
  check('卡片字号 ' + name + ' 用变量',
    new RegExp('font-size:\\s*var\\(\\s*' + name + '\\s*\\)').test(css));
});

/*
 * BOTTOM_RESERVE 由 metrics() 算（半张牌 + 牌下整个说明区），
 * 所以这里验的是「它确实把说明区的高度算进去了」，不再抠字面公式。
 */
check('render.js 的底部留白把牌下说明区算进去了',
  /bottomReserve\s*[:=][^;]*cardH\s*\/\s*2\s*\+[^;]*captionBlockH/.test(renderJs),
  '应形如 cardH / 2 + captionBlockH');

/*
 * 牌位名与朝向标签的度量，render.js 和 styles.css 必须一致。
 *
 * computeMetrics 用 JS 里的那几个常量算「牌下说明区占多高」，进而决定纵向
 * 间距够不够；CSS 则用同样的数值去排版。两边对不上，牌阵自检就会按错的
 * 数字判断——估算偏小就会放过真实的压盖。
 *
 * **行高也必须绑住**，而且它比内边距更要紧：CAPTION_LINE_HEIGHT 和
 * ORIENT_LINE_HEIGHT 直接进入 captionBlockH → pxPerUnit → 行距和牌阵自检阈值，
 * 是「牌位名占多高」的主要成分。只有内边距被绑住、行高没绑的话，
 * 把 CSS 里的 line-height 从 1.35 改成 3，五套测试会全绿，
 * 而真机上文字顶到边框——那正是这套测试声称要防的事。
 */
var measureChecks = [
  { name: '牌位名上内边距', js: /CAPTION_PAD_TOP\s*=\s*([\d.]+)/,
    css: /\.slot-caption\s*\{[^}]*padding-top:\s*([\d.]+)px/ },
  { name: '朝向标签上边距', js: /ORIENT_MARGIN_TOP\s*=\s*([\d.]+)/,
    css: /\.slot-orient\s*\{[^}]*margin-top:\s*([\d.]+)px/ },
  { name: '朝向标签纵向内边距', js: /ORIENT_PAD_Y\s*=\s*([\d.]+)/,
    css: /\.slot-orient\s*\{[^}]*padding:\s*([\d.]+)px/ },
  // 行高：直接决定 captionBlockH，进而决定行距和牌阵自检阈值
  { name: '牌位名行高', js: /CAPTION_LINE_HEIGHT\s*=\s*([\d.]+)/,
    css: /\.slot-pos\s*\{[^}]*line-height:\s*([\d.]+)/ },
  { name: '朝向标签行高', js: /ORIENT_LINE_HEIGHT\s*=\s*([\d.]+)/,
    css: /\.slot-orient\s*\{[^}]*line-height:\s*([\d.]+)/ }
];

measureChecks.forEach(function (item) {
  var jsMatch = renderJs.match(item.js);
  var cssMatch = css.replace(/\/\*[\s\S]*?\*\//g, '').match(item.css);
  check('度量「' + item.name + '」在 JS 与 CSS 里都能读到',
    Boolean(jsMatch) && Boolean(cssMatch),
    'JS=' + (jsMatch ? jsMatch[1] : '缺') + ' CSS=' + (cssMatch ? cssMatch[1] : '缺'));
  if (jsMatch && cssMatch) {
    eq('度量「' + item.name + '」两边一致', Number(jsMatch[1]), Number(cssMatch[1]));
  }
});

// 牌位靠绝对定位摆放，容器必须有 position: relative，否则会相对整个页面定位
var surfaceBlock = css.match(/\.table-surface\s*\{[^}]*\}/);
check('.table-surface 有 position: relative（牌位绝对定位的基准）',
  Boolean(surfaceBlock) && /position:\s*relative/.test(surfaceBlock[0]),
  surfaceBlock ? surfaceBlock[0] : '找不到 .table-surface 规则');

var slotBlock = css.match(/\.slot\s*\{[^}]*\}/);
check('.slot 是 absolute 定位',
  Boolean(slotBlock) && /position:\s*absolute/.test(slotBlock[0]),
  slotBlock ? slotBlock[0] : '找不到 .slot 规则');

/* ================================================================== *
 * 6. 关键间距
 *
 * 起因是一个很显眼但前三套测试都看不见的问题：牌库按钮和「洗牌」主按钮贴在一起，
 * 连一条缝都没有，看起来像同一组控件。
 *
 * 这类问题不需要一个完整的 CSS 级联模拟器——真正会犯的错就那么几处，
 * 直接把「这两块之间必须有间距」写成断言更可靠。
 * ================================================================== */

section('关键间距');

/*
 * 顶栏不能悬浮。
 *
 * 它原来是 position: sticky，一直浮在内容上方。手机上占 70 多像素，而待挑牌区
 * 要滚十几行——牌从它下面滑过去就被盖住。试过「向下滚时收起」，但快速滑动时
 * 折叠动画追不上滚动位置，牌还是露到顶栏上面去。
 *
 * 最后改成 relative：它就是普通内容，往下滚就跟着滚走，绝不会盖住东西。
 * DOM 层面的测试看不见 position 的值，所以必须在这里做静态检查。
 */
var topbarBlock = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/\.topbar\s*\{[^}]*\}/);
check('页面上有 .topbar 规则', Boolean(topbarBlock));
if (topbarBlock) {
  check('顶栏不是 sticky（否则会盖住滚动的内容）',
    !/position:\s*sticky/.test(topbarBlock[0]),
    (topbarBlock[0].match(/position:[^;]*/) || ['(没有 position)'])[0]);
  check('顶栏不是 fixed', !/position:\s*fixed/.test(topbarBlock[0]));
}

// 折叠状态是上一版方案留下的，不该再有
check('CSS 里没有残留的顶栏折叠规则',
  !/\.topbar\.is-collapsed/.test(css));

// 下面几条要剥掉注释再匹配——注释里也提到了这些选择器（那正是说明文字）
var cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

/*
 * 逆位只能有一层旋转。
 *
 * 这一条守的是一个很隐蔽的 bug：曾经有两条 rotate(180deg) 叠在同一张牌上
 *    .is-reversed .card-flip   { transform: rotate(180deg); }
 *    .slot.is-reversed .cf-inner { transform: rotate(180deg); }
 * 180 + 180 = 360——等于没转。表现是标着「逆位」的牌显示成正常的样子。
 *
 * 光检查「.cf-inner 有没有转」是不够的，必须同时确认**别处没有第二层旋转**。
 */
var reversedRotations = cssNoComments.match(/rotate\(180deg\)/g) || [];
eq('整个样式表里只有一处 rotate(180deg)', reversedRotations.length, 1);

check('那一处是 .slot.is-reversed .cf-inner',
  /\.slot\.is-reversed\s+\.cf-inner\s*\{[^}]*transform:\s*rotate\(180deg\)/.test(cssNoComments));

check('没有残留的「逐个文字元素旋转」写法',
  !/\.slot\.is-reversed\s+\.cf-num/.test(cssNoComments),
  '逐个转会导致顺序不翻转');

check('牌面翻转（.card-flip）不再参与逆位旋转',
  !/\.is-reversed\s+\.card-flip/.test(cssNoComments),
  '它会覆盖抽牌动画的最终状态，而且和 .cf-inner 叠加成 360°');

check('页面上定义了 .cf-inner 的排版',
  /\.cf-inner\s*\{[^}]*display:\s*flex/.test(cssNoComments));

/*
 * 入场动画要是纯 2D 的。
 *
 * 原来是一个 3D 翻转（rotateY 90° → 0°，配 perspective 和 preserve-3d），
 * 手机上看着别扭——透视依赖容器尺寸和视口，牌又小，翻起来的形变很怪。
 * 换成上浮淡入之后，这几个 3D 属性都该消失，否则会留下互相干扰的变换上下文。
 */
check('牌面入场不用 3D 变换',
  !/preserve-3d/.test(cssNoComments), '还有 transform-style: preserve-3d');
check('不再需要透视',
  !/perspective\s*:\s*\d/.test(cssNoComments), '还有 perspective');
check('不再需要 backface-visibility',
  !/backface-visibility/.test(cssNoComments));

// 牌的容器不该带 transform——入场动画挂在 .card-front 上
check('.card-flip 不再承担变换',
  !/\.card-flip\s*\{[^}]*transform:/.test(cssNoComments),
  '它上面的 transform 会和逆位的 rotate 打架');

// 动画挂在牌面上
check('入场动画挂在 .card-front 上',
  /\.card-front\s*\{[^}]*animation:\s*card-in/.test(cssNoComments));

/*
 * 牌面上的五段文字都必须有明确的 line-height。
 *
 * 不写的话会继承 body 的 1.65——那是给正文段落定的，套在牌面小字上会让
 * 文字框比实际高度大出一倍多，把内容往两头挤。表现就是「字快贴到牌的边框上」。
 *
 * 这一条抓的是「漏写」而不是「写错」，所以要逐段检查，不能只看整体。
 */
['cf-num', 'cf-glyph', 'cf-name', 'cf-en', 'cf-suit'].forEach(function (cls) {
  var body = cssNoComments.match(new RegExp('\\.' + cls + '\\s*\\{([^}]*)\\}'));
  check('.' + cls + ' 有明确的 line-height',
    Boolean(body) && /line-height:/.test(body[1]),
    body ? body[1].replace(/\s+/g, ' ').slice(0, 50) : '找不到规则');
});

/*
 * 牌面内边距要按牌宽算，不能写死。
 *
 * 写死 7px 在手机上太薄（牌只有 89px 高，文字几乎贴着边框）。
 * render.js 算出 --card-pad-y / --card-pad-x 并写入，CSS 只消费。
 */
var cfInnerBody = cssNoComments.match(/\.cf-inner\s*\{([^}]*)\}/);
check('.cf-inner 的内边距用变量而非写死像素',
  Boolean(cfInnerBody) && /padding:\s*var\(--card-pad-y/.test(cfInnerBody[1]),
  cfInnerBody ? (cfInnerBody[1].match(/padding:[^;]*/) || ['(没有 padding)'])[0] : '找不到规则');

var renderForPad = fs.readFileSync(path.join(ROOT, 'js', 'render.js'), 'utf8');
check('render.js 会写 --card-pad-y 变量',
  /setProperty\(\s*'--card-pad-y'/.test(renderForPad));
check('render.js 会写 --card-pad-x 变量',
  /setProperty\(\s*'--card-pad-x'/.test(renderForPad));

/*
 * 量容器宽度时必须减掉容器自己的左右内边距。
 *
 * clientWidth 是**含内边距**的，而牌桌要放进内容区。不减的话等于按
 * 「内容 + 12px」布局——窄屏下 .table-wrap 有 6px 左右内边距，
 * 最右边那一列的牌就被裁掉一截。用户反馈的「右边的牌显示不全」正是这个。
 *
 * 这条只能在代码层面验：测试环境里 getComputedStyle 拿不到样式表算出的
 * padding，构造不出这个场景。所以退而求其次——确认那句减法还在。
 */
check('量容器宽度时减掉了左右内边距',
  /clientWidth[\s\S]{0,200}?-\s*padL\s*-\s*padR/.test(renderForPad),
  'measureAvailableWidth 里的 padding 减法不见了');

check('量容器宽度时会读 paddingLeft / paddingRight',
  /paddingLeft/.test(renderForPad) && /paddingRight/.test(renderForPad));

/*
 * 减少动效模式下，牌背必须显式藏掉。
 *
 * 牌背平时靠 back-gone 这个动画淡出；动画一关就永远盖在牌面上，
 * 牌会变成一片背面——整个牌桌都看不见牌面了。
 */
var reducedBlock = cssNoComments.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}\s*$/);
check('有 prefers-reduced-motion 规则', Boolean(reducedBlock));
if (reducedBlock) {
  check('减少动效时牌背被藏掉（否则牌面全被盖住）',
    /\.card-back\s*\{[^}]*display:\s*none/.test(reducedBlock[1]));
}

/*
 * 牌区不能横向滚动。
 *
 * 那两条 overflow-x: auto 是为原来「一条超出屏宽的扇形」准备的；改成网格后
 * 宽度由 render.js 按容器算好、保证放得下，留着只会让牌区能被左右拖动。
 */
['.fan-wrap', '.table-wrap'].forEach(function (sel) {
  var m = css.replace(/\/\*[\s\S]*?\*\//g, '')
    .match(new RegExp(sel.replace('.', '\\.') + '\\s*\\{([^}]*)\\}'));
  check(sel + ' 不横向滚动', Boolean(m) && !/overflow-x:\s*auto/.test(m[1]),
    m ? (m[1].match(/overflow[^;]*/g) || ['(没有 overflow)']).join(' / ') : '找不到规则');
});

/*
 * 解析前先把注释剥掉。
 *
 * 必须这么做：注释会让「前一条声明」的结尾变成注释结束符而不是分号，
 * 于是 (^|;)margin-bottom 这类正则就匹配不到紧跟在注释后面的声明。
 * 实际踩过一次：`.spread-list` 的 margin-bottom 因此取成了 null。
 * （这段注释本身也不能写出注释结束符的字面量，否则会提前把自己闭合掉。）
 */
var cssForParsing = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 抠出某个选择器的规则体（只取第一条匹配） */
function blockOf(selector) {
  var re = new RegExp('(?:^|\\})\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm');
  var m = cssForParsing.match(re);
  return m ? m[1] : '';
}

/** 取一个长度值：支持 margin/padding 简写 */
function lengthOf(selector, prop) {
  var body = blockOf(selector);
  if (!body) return null;

  var short = prop.replace(/^(margin|padding)-.*$/, '$1');
  var side = /-top$/.test(prop) ? 'top' : (/-(bottom|left|right)$/.test(prop)
    ? prop.replace(/^.*-/, '') : null);

  var shorthand = body.match(new RegExp('(?:^|;)\\s*' + short + '\\s*:\\s*([^;]+)'));
  if (shorthand) {
    var parts = shorthand[1].trim().split(/\s+/);
    var value;
    if (!side) value = parts[0];
    else if (side === 'top' || side === 'left') value = parts[0];
    else if (parts.length === 1) value = parts[0];
    else if (parts.length === 2) value = parts[0];
    else value = parts[2];
    var num = parseFloat(value);
    return isNaN(num) ? null : num;
  }

  // 注意边界：声明可能是块里的最后一条，后面直接跟 }，所以前面用 (^|;) 锚定，
  // 不能要求它后面也有分号。
  var exact = body.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*(-?[0-9.]+)px\\s*(?:;|$)'));
  return exact ? Number(exact[1]) : null;
}

// 「牌库」那排按钮（.deck-row）与「洗牌」主按钮（.draw-row）之间必须有间距。
var drawRowMarginTop = lengthOf('.draw-row', 'margin-top');
check('.draw-row 有上边距（否则会与牌库按钮贴在一起）',
  drawRowMarginTop !== null && drawRowMarginTop >= 12,
  '实际 margin-top = ' + drawRowMarginTop);

// 牌阵说明文字与牌阵卡片之间同样要有间距。
var spreadListMarginBottom = lengthOf('.spread-list', 'margin-bottom');
check('.spread-list 有下边距（否则会与上面的说明文字贴在一起）',
  spreadListMarginBottom !== null && spreadListMarginBottom >= 12,
  '实际 margin-bottom = ' + spreadListMarginBottom);

// 面板内的头部与内容之间
var panelHeadMarginBottom = lengthOf('.panel-head', 'margin-bottom');
check('.panel-head 有下边距（标题与内容要有间距）',
  panelHeadMarginBottom !== null && panelHeadMarginBottom >= 8,
  '实际 margin-bottom = ' + panelHeadMarginBottom);

// 牌桌上的脚注与牌桌之间
var tableFootMarginTop = lengthOf('.table-foot', 'margin-top');
check('.table-foot 有上边距', tableFootMarginTop !== null && tableFootMarginTop >= 8,
  '实际 margin-top = ' + tableFootMarginTop);

// 每个 .panel 都要有内边距，否则内容会顶到圆角边框上
var panelPad = blockOf('.panel');
check('.panel 设置了内边距', /padding\s*:/.test(panelPad),
  panelPad ? panelPad.slice(0, 60) : '找不到 .panel 规则');

/* ================================================================== *
 * 汇总
 *
 * 断言数基线。
 *
 * 这个文件里有多处 `if (xxx) { ...若干条断言... }` 的守卫块——条件不成立时
 * 整块被跳过，而套件仍然打印「全部通过」，只是断言数悄悄变少。
 * 本项目已经踩过一次这个坑：verify-browser.js 里 8 条断言静默失效，
 * 是靠「测试数怎么没变」才发现的。
 *
 * 所以最后核对一次总数。**加了新断言就把这个数改大**；
 * 它变小，就说明有东西被跳过了。
 * ================================================================== */

var MIN_EXPECTED_ASSERTIONS = 72;

if (passed < MIN_EXPECTED_ASSERTIONS) {
  failures.push('断言数不足：只跑了 ' + passed + ' 项，基线是 ' +
    MIN_EXPECTED_ASSERTIONS + ' 项。多半是某个 if 守卫没成立、整块断言被跳过了。');
}

console.log('\n' + '='.repeat(60));
if (failures.length === 0) {
  console.log('全部通过：' + passed + ' 项断言（CSS 静态检查）');
  console.log('='.repeat(60));
  process.exit(0);
}
console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项：');
failures.forEach(function (f) { console.log('  ✗ ' + f); });
console.log('='.repeat(60));
process.exit(1);
