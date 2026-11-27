/*
 * verify-browser.js —— 用真实 DOM 引擎跑页面（不是手写替身）
 *
 *     node verify-browser.js
 *
 * 和 verify-ui.js 的区别很重要：
 *
 *   verify-ui.js     用手写的极简 DOM 替身。它能测逻辑，但替身是我自己写的，
 *                    我写错的地方它也照错——比如我以为某个属性叫 className，
 *                    替身就会跟着我一起错。
 *   verify-browser.js 用 domino（一个零依赖的完整 DOM 实现，带真正的 HTML
 *                    解析器和事件系统），真的去读 index.html、真的按顺序执行
 *                    <script src>、真的派发事件。
 *
 * 所以这个文件能抓到 verify-ui.js 抓不到的一类问题：真实的 DOM API 用法错误。
 * 它做不到的是 CSS 布局和视觉呈现——那部分只能靠人眼。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var domino = require(path.join(__dirname, '.domtest', 'package', 'lib', 'index.js'));

var ROOT = __dirname;
var passed = 0;
var failures = [];
var group = '';

function section(name) {
  group = name;
  console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(0, 52 - name.length)));
}

function check(label, condition, detail) {
  if (condition) { passed += 1; return true; }
  failures.push({ group: group, label: label, detail: detail });
  console.log('  ✗ ' + label + (detail ? '  → ' + detail : ''));
  return false;
}

function eq(label, actual, expected) {
  return check(label, actual === expected,
    '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

/**
 * 测试用的抽牌助手：走完整的「洗牌 → 挑牌 → 收尾」流程。
 * 真实用户自己点扇形选位置；测试里固定挑「第 0 个位置」以保证可复现，
 * 随机性仍全部来自 crypto。
 *
 * 注意用的是页面里的 window.Tarot（脚本是在 vm 上下文里执行的），
 * 不是 Node 这边的 globalThis。
 */
function makeDraw(options) {
  var engine = window.Tarot.Engine;
  var session = engine.prepareFan(options);
  for (var i = 0; i < session.needed; i++) {
    engine.takeFromFan(session, 0);
  }
  return engine.finalizeDraw(session);
}

/* ================================================================== *
 * 搭建：解析真实的 index.html，按顺序执行真实脚本
 * ================================================================== */

var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var window = domino.createWindow(html, { url: 'file://' + ROOT.replace(/\\/g, '/') + '/index.html' });
var document = window.document;

// Node 里给页面补上 WebCrypto（真实浏览器原生就有）
if (!window.crypto || !window.crypto.getRandomValues) {
  window.crypto = require('crypto').webcrypto;
}
if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = function (cb) { return setTimeout(function () { cb(Date.now()); }, 0); };
}
if (!window.AbortController) window.AbortController = AbortController;
if (!window.fetch && globalThis.fetch) window.fetch = globalThis.fetch;
window.localStorage = null; // 走内存回退，避免 domino 没有 localStorage 时报错

// 捕获页面脚本里的运行时错误——这是这个文件存在的主要理由
var pageErrors = [];
window.addEventListener('error', function (event) {
  pageErrors.push('window.onerror: ' + (event.message || event.error));
});
window.onerror = function (message, source, line, col) {
  pageErrors.push('onerror: ' + message + ' @' + line + ':' + col);
};

// 收集 <script src="...">。
// src 可能带查询串（用于破除 file:// 缓存，例如 js/app.js?v=2），
// 读文件前要把 ? 之后的部分去掉——真实浏览器请求时也会忽略它。
var scriptSrcs = [];
var scriptNodes = document.querySelectorAll('script');
for (var i = 0; i < scriptNodes.length; i++) {
  var src = scriptNodes[i].getAttribute('src');
  if (src) scriptSrcs.push(src);
}

/** 把 "js/app.js?v=2" 还原成磁盘路径 "js/app.js" */
function fileOf(src) {
  return src.split('?')[0].split('#')[0];
}

section('加载页面');

eq('index.html 里有 9 个脚本', scriptSrcs.length, 9);
eq('第一个脚本是 random.js', fileOf(scriptSrcs[0]), 'js/random.js');
eq('最后一个脚本是 app.js', fileOf(scriptSrcs[scriptSrcs.length - 1]), 'js/app.js');

var missing = scriptSrcs.filter(function (src) {
  return !fs.existsSync(path.join(ROOT, fileOf(src)));
});
eq('所有脚本文件都存在', missing.length, 0, missing.join('、'));

// 带版本号是为了破除 file:// 下的缓存；确认这一层没被漏掉
check('脚本引用了带版本号的路径（破除 file:// 缓存）',
  scriptSrcs.every(function (src) { return src.indexOf('?v=') > 0; }),
  scriptSrcs.join(' '));

// 真的执行它们，顺序和浏览器一致。
// domino 的 window 没有 eval 方法，所以用 Node 的 vm 模块把 window 当作
// 全局对象建一个上下文——这样脚本里的 globalThis、window、document
// 三者指向同一套东西，和真实浏览器一致。
var context = vm.createContext(window);
scriptSrcs.forEach(function (src) {
  var code = fs.readFileSync(path.join(ROOT, fileOf(src)), 'utf8');
  try {
    vm.runInContext(code, context, { filename: fileOf(src) });
  } catch (error) {
    pageErrors.push('执行 ' + fileOf(src) + ' 抛错：' +
      (error && error.stack ? error.stack.split('\n').slice(0, 3).join(' / ') : error));
  }
});

eq('所有脚本执行无异常', pageErrors.length, 0, pageErrors.join(' | '));

// 真实浏览器会在文档解析完成后派发 DOMContentLoaded，app.js 正是靠它初始化。
// 这里补上这一步——不补的话页面不会渲染，而那是测试脚手架的问题，不是页面的。
// domino 的 readyState 会一直停在 'loading'，所以要显式派发。
var domReady = document.createEvent('Event');
domReady.initEvent('DOMContentLoaded', true, true);
document.dispatchEvent(domReady);

// 等到一个事件循环之后再断言：app.js 的初始化和兜底逻辑可能排在微任务/宏任务里
setTimeout(function () { runAssertions(); }, 20);

function runAssertions() {

var Tarot = window.Tarot;
check('Tarot 命名空间已建立', Boolean(Tarot));
check('Tarot.App 可用（说明 app.js 跑到了最后）', Boolean(Tarot && Tarot.App));

/*
 * 页脚的版本标记必须真的被填上。
 *
 * 它的存在是为了解决一个反复出现的浪费：代码改好了、测试全绿，
 * 用户那边却还在跑缓存里的旧 JS，于是一个早就修掉的 bug 看起来还在。
 * 有了这行标记，截图就能证明「跑的是哪一版」。
 *
 * 这里在真实 DOM 上验证它读到了 index.html 里的 ?v=NN——
 * 如果哪天资源地址上的版本号被去掉，这条会红，提醒那行标记会退化成
 * 「界面版本未知」，也就失去了作用。
 *
 * （用 document.getElementById 而不是下面的 byId：byId 是 var 赋值，
 *   在这一行还没轮到它初始化。）
 */
var stamp = document.getElementById('buildStamp');
check('页脚有版本标记节点', Boolean(stamp));
check('版本标记被填上了应用版本和资源版本',
  Boolean(stamp) && /版本 \d+\.\d+/.test(stamp.textContent) && /资源 v\d+/.test(stamp.textContent),
  stamp ? stamp.textContent : '(没有这个节点)');

/*
 * 版本号必须锚定到 js/ 下的脚本，不能是样式表。
 *
 * 这条比「显示的版本号对不对」更要紧。之前页脚用的是
 * `script[src*="?v="], link[href*="?v="]`——取文档序第一个带 ?v= 的节点，
 * 而 <link styles.css> 在 <head>、脚本在 <body> 尾，于是**读的是样式表的版本号**。
 * 一旦有人只改样式表的 ?v=，页脚就显示新版本、实际跑的是旧 JS，
 * 恰好毁掉这行标记存在的意义。
 *
 * 注意：**不能靠「页脚显示的版本 == 文档里第一个 ?v=」来判断**——
 * 正常情况下两者本来就同步（版本号总是一起改），那种断言对上面这个 bug
 * 完全无感。要直接验证「选中的是哪个节点」。
 */
var pickedForStamp = document.querySelector('script[src*="js/"][src*="?v="]');
check('版本标记锚定到 js 脚本，而不是样式表',
  Boolean(pickedForStamp) && /js\//.test(pickedForStamp.getAttribute('src')),
  pickedForStamp ? pickedForStamp.getAttribute('src') : '(没选中任何节点)');
check('锚定到的脚本确实是页面在执行的那个',
  Boolean(pickedForStamp) &&
  scriptSrcs.some(function (s) { return s === pickedForStamp.getAttribute('src'); }),
  '选中的是 ' + (pickedForStamp ? pickedForStamp.getAttribute('src') : '?') +
  '，页面执行的脚本有 ' + scriptSrcs.length + ' 个');

if (!Tarot || !Tarot.App) {
  report();
  return;
}

/* ================================================================== *
 * 初始化后的页面状态
 * ================================================================== */

section('初始化后的页面');

var byId = function (id) { return document.getElementById(id); };

check('随机源徽标有内容', byId('rngBadge').textContent.length > 0, byId('rngBadge').textContent);
eq('随机源徽标是成功态', byId('rngBadge').className, 'rng-badge is-ok');
eq('牌阵卡片渲染出 6 个',
  document.querySelectorAll('#spreadList .spread-card').length, 6);
eq('牌库按钮渲染出 2 个',
  document.querySelectorAll('#deckOptions .deck-chip').length, 2);
eq('示例问题渲染出 ' + Tarot.Render.examples.length + ' 个',
  document.querySelectorAll('#exampleList .example-chip').length, Tarot.Render.examples.length);

check('牌阵摘要非空', byId('spreadCount').textContent.indexOf('单张牌') >= 0,
  byId('spreadCount').textContent);
check('牌桌初始隐藏', byId('panelTable').hidden === true);
check('解读区初始隐藏', byId('panelReading').hidden === true);
check('抽牌按钮可用', byId('btnDraw').disabled === false);
/*
 * 原来这里断言「重新抽牌初始禁用」，但那个按钮已经删掉了：
 * 「洗牌」和「重新洗牌」绑的是同一个 startShuffle('main')，
 * 用户直接说「这两个按钮功能重复了」。现在只有一个按钮，
 * 文案跟着状态变，所以改断言文案。
 */
check('未抽牌时按钮文案是「洗牌」',
  byId('btnDrawText').textContent === '洗牌',
  byId('btnDrawText').textContent);
check('默认选中第一个牌阵',
  document.querySelectorAll('#spreadList .spread-card')[0].className.indexOf('is-active') >= 0);

/* ================================================================== *
 * 交互：用真实事件派发
 * ================================================================== */

section('交互 · 提问与抽牌');

function click(node) {
  var event = document.createEvent('MouseEvents');
  event.initEvent('click', true, true);
  node.dispatchEvent(event);
}

function typeInto(node, text) {
  node.value = text;
  var event = document.createEvent('HTMLEvents');
  event.initEvent('input', true, true);
  node.dispatchEvent(event);
}

typeInto(byId('question'), '我要不要接受这个 offer？');
eq('问题写进状态', Tarot.App.state.question, '我要不要接受这个 offer？');

/* ---- 洗牌 → 扇形 → 挑牌：这是新的抽牌路径 ---- */

click(byId('btnDraw'));

check('洗牌后有了待挑的会话', Tarot.App.state.session !== null);
check('洗牌后还没有结果', Tarot.App.state.result === null);
eq('扇形里是整副牌', Tarot.App.state.session.fanOrder.length, 78);
check('扇形面板显示出来', byId('panelFan').hidden === false);
check('牌桌在挑满之前保持隐藏', byId('panelTable').hidden === true);
eq('扇形渲染出 78 张牌', document.querySelectorAll('#fanSurface .fan-card').length, 78);

// 扇形里的牌必须是背面朝上的按钮，且不泄露任何牌面信息
var fanCard = document.querySelector('#fanSurface .fan-card');
check('扇形里的牌是 button 元素', fanCard.tagName === 'BUTTON', fanCard.tagName);
check('扇形里的牌带位置标记', fanCard.getAttribute('data-fan-index') === '0');
var fanTextAll = byId('fanSurface').textContent;
check('扇形里没有出现任何牌名',
  !Tarot.Cards.deck.some(function (card) { return fanTextAll.indexOf(card.name) >= 0; }),
  fanTextAll.slice(0, 60));
check('扇形提示写明要挑第几张',
  byId('fanPrompt').textContent.indexOf('请挑第 1 张') >= 0,
  byId('fanPrompt').textContent);
check('扇形副标题显示进度 0 / 1', byId('fanSub').textContent.indexOf('0 / 1') >= 0,
  byId('fanSub').textContent);

/*
 * 尺寸必须真的写到 DOM 上。
 *
 * 这一条守的是「算了却没生效」那类问题：render.js 把尺寸算对了、也调了
 * setProperty，但如果变量名写错、或者写到了别的元素上，CSS 就会用回退值
 * （.fan-card 的 84×134），于是牌画得比算出来的大，所有牌叠成一团。
 *
 * 只测计算结果的测试看不见这种错——计算是对的。必须在 DOM 上核对。
 */
var rootStyle = document.documentElement.style;
var cssVarChecks = ['--card-w', '--card-h', '--fan-card-w', '--fan-card-h',
  '--caption-w', '--caption-font'];
cssVarChecks.forEach(function (name) {
  var value = rootStyle.getPropertyValue ? rootStyle.getPropertyValue(name) : '';
  check('CSS 变量 ' + name + ' 写到了 :root 上',
    Boolean(value) && /px$/.test(String(value).trim()), name + '=' + value);
});

// 待挑牌的实际尺寸必须等于算出来的值（而不是 CSS 里的回退值）
var expectedFanW = Tarot.Render.metrics().fanCardW;
var actualFanW = parseInt(rootStyle.getPropertyValue('--fan-card-w'), 10);
eq('待挑牌宽度取自计算结果而非 CSS 回退值', actualFanW, expectedFanW);

// 网格排布：同一行的相邻牌不能叠上（左边缘间距 ≥ 牌宽）
check('待挑牌在同一行内不重叠', (function () {
  var cards = document.querySelectorAll('#fanSurface .fan-card');
  var byTop = {};
  for (var i = 0; i < cards.length; i++) {
    var top = cards[i].style.top;
    if (!byTop[top]) byTop[top] = [];
    byTop[top].push(parseFloat(cards[i].style.left));
  }
  return Object.keys(byTop).every(function (top) {
    var xs = byTop[top].sort(function (a, b) { return a - b; });
    for (var k = 1; k < xs.length; k++) {
      if (xs[k] - xs[k - 1] < expectedFanW - 0.5) return false;
    }
    return true;
  });
})(), '牌宽 ' + expectedFanW);

// 挑走那一张
var fanPick = Tarot.App.state.session.fanOrder[0];
click(fanCard);

check('挑满后生成了结果', Tarot.App.state.result !== null);
eq('挑到的正是扇形首位那张', Tarot.App.state.result.cards[0].cardId, fanPick);
check('挑完后扇形收起', byId('panelFan').hidden === true);
eq('抽到 1 张牌', Tarot.App.state.result.cards.length, 1);
check('牌桌显示出来', byId('panelTable').hidden === false);
check('解读区显示出来', byId('panelReading').hidden === false);
eq('牌桌上渲染出 1 个牌位', document.querySelectorAll('#tableSurface .slot').length, 1);

// 关键：牌面内容是不是真的渲染出了牌名
var slot = document.querySelector('#tableSurface .slot');
check('牌位渲染出牌名',
  slot.textContent.indexOf(Tarot.App.state.result.cards[0].card.name) >= 0,
  slot.textContent.slice(0, 100));
check('牌位渲染出朝向', slot.textContent.indexOf(Tarot.App.state.result.cards[0].orientation) >= 0);
check('牌位渲染出牌位名', slot.textContent.indexOf('此刻的核心') >= 0);
check('牌桌脚注含抽牌编号',
  byId('tableFoot').textContent.indexOf(Tarot.App.state.result.id) >= 0);
check('解读区是「待生成」占位',
  byId('readingBody').textContent.indexOf('让模型来读') >= 0,
  byId('readingBody').textContent.slice(0, 80));

section('交互 · 切换牌阵与牌库');

var celticCard = document.querySelector('#spreadList .spread-card[data-spread="celtic-cross"]');
check('找得到凯尔特十字按钮', Boolean(celticCard));
click(celticCard);
eq('状态已切换', Tarot.App.state.spreadKey, 'celtic-cross');
check('切换后高亮跟随',
  document.querySelector('#spreadList .spread-card[data-spread="celtic-cross"]')
    .className.indexOf('is-active') >= 0);

// 凯尔特十字：点重新洗牌，然后从扇形里挑满 10 张
click(byId('btnDraw'));
eq('重新洗牌后需要挑 10 张', Tarot.App.state.session.needed, 10);
eq('扇形里仍是整副牌', document.querySelectorAll('#fanSurface .fan-card').length, 78);

// 挑 4 张，看看中途状态
var midPicked = 0;
while (midPicked < 4) {
  click(document.querySelector('#fanSurface .fan-card'));
  midPicked += 1;
}
eq('扇形里少了 4 张', document.querySelectorAll('#fanSurface .fan-card').length, 74);
eq('会话记录了 4 张', Tarot.App.state.session.picks.length, 4);
check('进度显示 4 / 10', byId('fanSub').textContent.indexOf('4 / 10') >= 0,
  byId('fanSub').textContent);
check('已挑列表列出 4 个', document.querySelectorAll('#fanPicked .picked-chip').length === 4);
check('还没挑满时牌桌保持隐藏', byId('panelTable').hidden === true);

/*
 * 挑牌挑到一半去切换牌阵，会话必须一并取消。
 *
 * 会话在 prepareFan 那一刻就把 spreadKey / deckKey / needed 捕获下来了，
 * 之后改 state 上那两个字段对它毫无影响。不取消就会出现自相矛盾的画面：
 * 界面上写着新牌阵，扇形里还是旧牌阵的进度，继续挑下去收尾出来的**仍是
 * 旧牌阵的牌**——用户的选择被静默忽略。
 *
 * 这条以前完全没覆盖：其它章节都是在两次抽牌之间（session 已结束）才切牌阵的。
 */
var singleCard = document.querySelector('#spreadList .spread-card[data-spread="single"]');
check('找得到单张牌阵按钮', Boolean(singleCard));
click(singleCard);
eq('切换牌阵后 state 已更新', Tarot.App.state.spreadKey, 'single');
check('挑牌会话被取消（不再自相矛盾）', Tarot.App.state.session === null,
  'session 仍存在：' + (Tarot.App.state.session && Tarot.App.state.session.spreadKey));
check('切回主模式（不是停在补挑）', Tarot.App.state.fanMode === 'main',
  Tarot.App.state.fanMode);
check('扇形面板收起', byId('panelFan').hidden === true);

// 复位到凯尔特十字，继续后面的章节
click(celticCard);
eq('复位回凯尔特十字', Tarot.App.state.spreadKey, 'celtic-cross');
click(byId('btnDraw'));
eq('重新洗牌后又是 10 张', Tarot.App.state.session.needed, 10);
midPicked = 0;
while (midPicked < 4) {
  click(document.querySelector('#fanSurface .fan-card'));
  midPicked += 1;
}
eq('重新挑到 4 张', Tarot.App.state.session.picks.length, 4);

// 挑满剩下的
while (document.querySelectorAll('#fanSurface .fan-card').length > 0 &&
       Tarot.App.state.session && Tarot.App.state.session.picks.length < 10) {
  click(document.querySelector('#fanSurface .fan-card'));
}
eq('凯尔特十字挑到 10 张', Tarot.App.state.result.cards.length, 10);
eq('牌桌渲染 10 个牌位', document.querySelectorAll('#tableSurface .slot').length, 10);
check('挑满后扇形收起', byId('panelFan').hidden === true);

// 一次抽牌里不该出现重复牌
eq('一次抽牌不出现重复牌', Tarot.App.state.result.drawnIds.length,
  Tarot.App.state.result.drawnIds.filter(function (id, i) {
    return Tarot.App.state.result.drawnIds.indexOf(id) === i;
  }).length);

// 逆位牌应当带 is-reversed 类
var reversedCount = document.querySelectorAll('#tableSurface .slot.is-reversed').length;
var expectedReversed = Tarot.App.state.result.cards.filter(function (c) { return c.reversed; }).length;
eq('逆位牌数量与状态一致', reversedCount, expectedReversed);
console.log('  （本次 10 张里 ' + expectedReversed + ' 张逆位）');

var majorChip = document.querySelectorAll('#deckOptions .deck-chip')[1];
click(majorChip);
eq('牌库切到大阿卡纳', Tarot.App.state.deckKey, 'major');
click(byId('btnDraw'));
eq('大阿卡纳牌库扇形只有 22 张',
  document.querySelectorAll('#fanSurface .fan-card').length, 22);
while (Tarot.App.state.session && Tarot.App.state.session.picks.length < 10) {
  click(document.querySelector('#fanSurface .fan-card'));
}
check('大阿卡纳模式下全是大牌', Tarot.App.state.result.cards.every(function (item) {
  return item.card.suit === 'major';
}));

section('交互 · 选牌阵');

// 回到干净状态。特别注意 deckKey：前面的章节把它切成了大阿卡纳且没切回来，
// 不重置的话扇形里只有 22 张，后面所有「78 张」的断言都会莫名失败。
Tarot.App.state.result = null;
Tarot.App.state.bonus = [];
Tarot.App.state.session = null;
Tarot.App.state.payload = null;
Tarot.App.state.deckKey = 'full';
Tarot.App.state.spreadKey = 'three-time';
Tarot.App.render();

// 牌阵面板没有 id，用类选择器（它始终可见，不参与显隐切换）
check('牌阵面板存在于页面上',
  document.querySelectorAll('.panel-spread').length === 1);
eq('牌阵列表渲染出 6 项', document.querySelectorAll('#spreadList .spread-card').length, 6);

// 抽几张由牌阵决定，面板上要写明。
// 原来这里还查过 #spreadNote（「这套牌阵要抽 N 张…」），但它和下面的
// #spreadCount、以及每张牌阵卡片上的张数标签说的是同一件事，三处重复，
// 界面上已经删掉了 #spreadNote，所以这里的断言也一并去掉。
check('副标题显示当前牌阵与张数',
  byId('spreadCount').textContent.indexOf('三张牌') >= 0 &&
  byId('spreadCount').textContent.indexOf('3 张') >= 0,
  byId('spreadCount').textContent);

// 每张牌阵卡片都要标出张数
var spreadCounts = [];
var spreadCards = document.querySelectorAll('#spreadList .spread-card');
for (var sc = 0; sc < spreadCards.length; sc++) {
  var badge = spreadCards[sc].querySelectorAll('.sc-count');
  spreadCounts.push(badge.length ? badge[0].textContent : '?');
}
check('每张牌阵卡片都标了张数',
  spreadCounts.every(function (text) { return /张$/.test(text); }),
  spreadCounts.join(' / '));

// 切换牌阵：张数说明要跟着变
click(document.querySelector('#spreadList .spread-card[data-spread="celtic-cross"]'));
eq('切到凯尔特十字', Tarot.App.state.spreadKey, 'celtic-cross');
check('说明跟着变成 10 张',
  byId('spreadCount').textContent.indexOf('10 张') >= 0,
  byId('spreadCount').textContent);
check('高亮跟随',
  document.querySelector('#spreadList .spread-card[data-spread="celtic-cross"]')
    .className.indexOf('is-active') >= 0);

// 按牌阵的张数抽牌
click(byId('btnDraw'));
eq('凯尔特十字要挑 10 张', Tarot.App.state.session.needed, 10);
check('扇形里是整副牌', document.querySelectorAll('#fanSurface .fan-card').length === 78,
  '实际 ' + document.querySelectorAll('#fanSurface .fan-card').length +
  '，deckKey=' + Tarot.App.state.deckKey);
while (Tarot.App.state.session && Tarot.App.state.session.picks.length < 10) {
  click(document.querySelector('#fanSurface .fan-card'));
}
eq('抽到 10 张', Tarot.App.state.result.cards.length, 10);
eq('牌桌渲染 10 个牌位', document.querySelectorAll('#tableSurface .slot').length, 10);
check('牌位名用牌阵自己的定义',
  byId('tableSurface').textContent.indexOf('最终走向') >= 0,
  byId('tableSurface').textContent.slice(0, 120));

// 换成单张牌阵，张数说明也要跟着变
click(document.querySelector('#spreadList .spread-card[data-spread="single"]'));
check('换成单张牌阵后说明变成 1 张',
  byId('spreadCount').textContent.indexOf('1 张') >= 0,
  byId('spreadCount').textContent);

section('交互 · 追加补充牌');

// 先回到 1 张的牌阵，方便数数。张数由牌阵决定，所以切牌阵就够了。
// deckKey 也要重置——前面的章节切成了大阿卡纳。
Tarot.App.state.spreadKey = 'single';
Tarot.App.state.deckKey = 'full';
click(byId('btnDraw'));
click(document.querySelector('#fanSurface .fan-card'));
var baseCardCount = Tarot.App.state.result.cards.length;
eq('基础牌阵 1 张', baseCardCount, 1);
eq('初始没有补充牌', Tarot.App.state.bonus.length, 0);
eq('补充牌张数选择器初值为 1', Tarot.App.state.bonusStep, 1);
check('减号按钮在 1 时被禁用', byId('btnBonusMinus').disabled === true);
check('加号按钮可用', byId('btnBonusPlus').disabled === false);
check('抽补充牌按钮可用', byId('btnDrawBonus').disabled === false);
check('说明文字写明牌阵张数以外的剩余量', byId('bonusNote').textContent.indexOf('还剩') >= 0,
  byId('bonusNote').textContent.slice(0, 60));

/*
 * 「一张一张自己挑」这条路。
 *
 * 这一段守的是一个从写出来就坏掉、很久没被发现的 bug：
 * 「挑够了，收起来」按钮的可用条件是 `session.picks.length > 0`，
 * 而补挑的牌只进了 state.bonus，**从没记进 session.picks**——
 * 于是那个按钮永远是禁用的，点不动。
 *
 * 补挑这条路的取牌逻辑是手写的（没有走 Engine.takeFromFan），所以像
 * 「顺手维护 picks」这种附带状态很容易漏。只有真的走一遍点击流程才测得出来：
 * 单独测 takeBonusPick 的返回值是对的，测 state.bonus 也是对的。
 */
section('交互 · 一张一张补挑');

click(byId('btnBonusPick'));
eq('进入补挑模式', Tarot.App.state.fanMode, 'bonus');
check('补挑时扇形面板可见', byId('panelFan').hidden === false);
check('补挑时「挑够了」按钮出现', byId('btnFanDone').hidden === false);
check('还没挑过时「挑够了」是禁用的（没东西可收）',
  byId('btnFanDone').disabled === true);

var bonusBefore = Tarot.App.state.bonus.length;
var poolBefore = Tarot.App.state.session.fanOrder.length;
click(document.querySelector('#fanSurface .fan-card'));

eq('补挑一张后补充牌 +1', Tarot.App.state.bonus.length, bonusBefore + 1);
eq('牌池少一张', Tarot.App.state.session.fanOrder.length, poolBefore - 1);
// 这一条就是那个 bug 的判据
check('补挑后 session.picks 记下了这一张',
  Tarot.App.state.session.picks.length > 0,
  'picks=' + Tarot.App.state.session.picks.length);
check('挑过之后「挑够了」变为可用', byId('btnFanDone').disabled === false);

// 还能接着挑，且按钮保持可用
click(document.querySelector('#fanSurface .fan-card'));
eq('可以继续补挑', Tarot.App.state.bonus.length, bonusBefore + 2);
check('继续挑后按钮仍可用', byId('btnFanDone').disabled === false);

// 收起来
click(byId('btnFanDone'));
eq('「挑够了」之后回到主模式', Tarot.App.state.fanMode, 'main');
check('扇形面板收起', byId('panelFan').hidden === true);
eq('补充牌全部保留', Tarot.App.state.bonus.length, bonusBefore + 2);

// 收起来之后，为了不影响后面的章节，把补充牌清掉重来
Tarot.App.state.bonus = [];
Tarot.App.state.spreadKey = 'single';
click(byId('btnDraw'));
click(document.querySelector('#fanSurface .fan-card'));

// 步进器
click(byId('btnBonusPlus'));
click(byId('btnBonusPlus'));
eq('加两次后为 3', Tarot.App.state.bonusStep, 3);
eq('选择器显示同步', byId('bonusCount').textContent, '3');
click(byId('btnBonusMinus'));
eq('减一次后为 2', Tarot.App.state.bonusStep, 2);
eq('选择器显示同步', byId('bonusCount').textContent, '2');

// 抽补充牌
var beforeDrawn = Tarot.App.state.result.drawnIds.length;
click(byId('btnDrawBonus'));

eq('追加了 2 张', Tarot.App.state.bonus.length, 2);
eq('已抽集合相应增加', Tarot.App.state.result.drawnIds.length, beforeDrawn + 2);
eq('牌桌上现在是 3 张', document.querySelectorAll('#tableSurface .slot').length, 3);
eq('其中 2 张带补充标记',
  document.querySelectorAll('#tableSurface .slot.is-bonus').length, 2);
eq('补充牌有金色徽标', document.querySelectorAll('#tableSurface .slot.is-bonus .bonus-tag').length, 2);
eq('牌桌标题写明含补充', byId('tableSub').textContent.indexOf('含 2 张补充') >= 0, true);
eq('脚注说明了补充牌', byId('tableFoot').textContent.indexOf('主动追加的补充牌') >= 0, true);

// 补充牌不能和原有的重复
var allIds = Tarot.App.state.result.drawnIds;
eq('抽出的牌互不重复', allIds.length,
  allIds.filter(function (id, i) { return allIds.indexOf(id) === i; }).length);

// 从不同牌阵继续追加，仍然不重复。
// 张数由牌阵决定，所以点牌阵卡片就等于选定了张数。
var celticCard = document.querySelector('#spreadList .spread-card[data-spread="celtic-cross"]');
check('找得到凯尔特十字卡片', Boolean(celticCard));
click(celticCard);
eq('点牌阵后张数确定为凯尔特十字的 10 张',
  Tarot.Spreads.get(Tarot.App.state.spreadKey).positions.length, 10);
check('说明同步为 10 张',
  byId('spreadCount').textContent.indexOf('10 张') >= 0,
  byId('spreadCount').textContent);

click(byId('btnDraw'));
eq('要挑 10 张', Tarot.App.state.session.needed, 10);
while (Tarot.App.state.session && Tarot.App.state.session.picks.length < 10) {
  click(document.querySelector('#fanSurface .fan-card'));
}
var celticIds = Tarot.App.state.result.drawnIds.slice();
click(byId('btnDrawBonus'));
eq('凯尔特十字 + 2 张补充', document.querySelectorAll('#tableSurface .slot').length, 12);
eq('凯尔特十字的抽出集合互不重复', Tarot.App.state.result.drawnIds.length,
  Tarot.App.state.result.drawnIds.filter(function (id, i) {
    return Tarot.App.state.result.drawnIds.indexOf(id) === i;
  }).length);

// 补充牌的像素位置必须在牌阵下方，而且要留够一个牌位名的高度。
// 用渲染层的换算函数算期望值，不要写死像素——刻度（PX_PER_UNIT）改过两次了。
var celticLowest = 0;
Tarot.App.state.result.cards.forEach(function (c) {
  if (c.position.y > celticLowest) celticLowest = c.position.y;
});
var bonusSlots = document.querySelectorAll('#tableSurface .slot.is-bonus');
eq('找到 2 个补充牌位', bonusSlots.length, 2);

var lowestTop = Tarot.Render.positionToPixels({ x: 0, y: celticLowest }).top;
/*
 * 期望值用牌阵自检的纵向阈值（minDy）。它就是「一张牌 + 牌下说明区」占的
 * 单位数，而补充牌的 APPROACH 用的也是同一个口径——所以两者应当吻合。
 * 不写死数字：刻度是动态的，随牌高缩放。
 */
var bonusTop = Tarot.Render.positionToPixels({ x: 0, y: celticLowest + Tarot.Spreads.minDy }).top;
var captionRoom = bonusTop - lowestTop;
check('补充牌位的像素位置在牌阵下方（且留出了牌位名的高度）', (function () {
  for (var bi = 0; bi < bonusSlots.length; bi++) {
    var topPx = parseFloat(bonusSlots[bi].style.top);
    if (!(topPx >= lowestTop + captionRoom - 0.5)) return false;
  }
  return true;
})(), '最低牌心 ' + lowestTop.toFixed(0) + 'px，补充牌应在 ' +
  (lowestTop + captionRoom).toFixed(0) + 'px 之下');

// 抽补充牌会让已有解读作废
Tarot.App.state.result = makeDraw({ spreadKey: 'three-choice', question: '作废测试' });
Tarot.App.state.bonus = [];
Tarot.App.state.payload = {
  reading: { overview: 'x', cards: [], synthesis: 'y', actions: ['z'], watchOut: 'w' },
  quoteStats: { ok: 0, total: 0 }, issues: [], usage: null
};
Tarot.App.render();
check('此时有解读结果', Tarot.App.state.payload !== null);
click(byId('btnDrawBonus'));
check('抽补充牌后旧解读被作废', Tarot.App.state.payload === null);
check('回到待生成状态', byId('readingBody').textContent.indexOf('让模型来读') >= 0);

// 翻转补充牌：改的必须是源数组里的那一张，否则重新合并就丢了
var bonusSlot = document.querySelector('#tableSurface .slot.is-bonus');
check('找得到补充牌位', Boolean(bonusSlot));
var bonusIdBefore = Tarot.App.state.bonus[0].cardId;
var bonusRevBefore = Tarot.App.state.bonus[0].reversed;
click(bonusSlot);
click(byId('btnFlipCard'));
eq('翻转的是同一张牌', Tarot.App.state.bonus[0].cardId, bonusIdBefore);
check('源数组里的朝向被同步', Tarot.App.state.bonus[0].reversed !== bonusRevBefore);
check('重新渲染后朝向没有丢', (function () {
  var slots = document.querySelectorAll('#tableSurface .slot.is-bonus');
  var isRev = slots[0].className.indexOf('is-reversed') >= 0;
  return isRev === Tarot.App.state.bonus[0].reversed;
})());

// 抽完为止的边界
Tarot.App.state.result = makeDraw({ spreadKey: 'single' });
Tarot.App.state.bonus = [];
Tarot.Engine.extraCards(Tarot.App.state.result, 77);
Tarot.App.state.bonusStep = 1;
Tarot.App.render();
check('抽完后按钮被禁用', byId('btnDrawBonus').disabled === true);
check('抽完后说明文字提示没有可追加的牌',
  byId('bonusNote').textContent.indexOf('已经抽完') >= 0,
  byId('bonusNote').textContent);

// 切到凯尔特十字（10 张），这样能一次覆盖多张牌、正逆位都有
Tarot.App.state.spreadKey = 'celtic-cross';
/*
 * 抽一副「正逆位混合」的凯尔特十字。
 *
 * 为什么要重抽：10 张全是正位（或全是逆位）的概率是 2 × 2⁻¹⁰ ≈ 0.2%，
 * 也就是大约每 500 次运行碰上一次。如果直接断言「正逆位都要出现」，
 * 那 0.2% 里会随机报红，而失败文案会被读成渲染 bug。
 *
 * **会随机失败的测试比没有测试更糟**——它教人忽略红色。所以这里同向就重抽，
 * 最多 8 次（全部同向的概率 < 1e-24，实际不可能走到）。
 */
function drawMixedCeltic() {
  for (var attempt = 0; attempt < 8; attempt++) {
    click(byId('btnDraw'));
    while (Tarot.App.state.session) {
      click(document.querySelector('#fanSurface .fan-card'));
    }
    var cards = Tarot.App.state.result.cards;
    var rev = cards.filter(function (c) { return c.reversed; }).length;
    if (rev > 0 && rev < cards.length) return { cards: cards, reversed: rev, tries: attempt + 1 };
  }
  return null;
}

var mixed = drawMixedCeltic();
check('抽到一副正逆混合的凯尔特十字（重抽最多 8 次）',
  Boolean(mixed), '连续 8 次都抽到全同向，概率上不该发生');

/*
 * 每一张牌都要检查，不能只查 querySelector 找到的第一张。
 *
 * 这条是被一个真实教训逼出来的：之前只验了第一张牌的结构，而问题出在别的牌上
 * （逆位被两层 rotate(180deg) 叠成 360°，等于没转）。单一取样证明不了
 * 「所有牌都对」——它只能证明「第一张对」。
 */
var allSlots = document.querySelectorAll('#tableSurface .slot');
var allCards = Tarot.App.state.result.cards;
eq('凯尔特十字渲染出 10 个牌位', allSlots.length, 10);

var slotProblems = [];
for (var si = 0; si < allSlots.length; si++) {
  var sNode = allSlots[si];
  var sItem = allCards[si];

  // 1. 朝向的类名要和数据一致
  var hasRevClass = sNode.className.indexOf('is-reversed') >= 0;
  if (hasRevClass !== Boolean(sItem.reversed)) {
    slotProblems.push('第 ' + (si + 1) + ' 张的 is-reversed 类与数据不符');
  }

  // 2. 内容层必须在，且是唯一的直下子节点
  var sInner = sNode.querySelector('.cf-inner');
  var sFront = sNode.querySelector('.card-front');
  if (!sInner || !sFront) {
    slotProblems.push('第 ' + (si + 1) + ' 张缺 .cf-inner 或 .card-front');
    continue;
  }
  if (sFront.children.length !== 1) {
    slotProblems.push('第 ' + (si + 1) + ' 张的 .card-front 有多个直下子节点');
  }

  // 3. 五段文字的顺序不能乱（逆位靠整体旋转，不靠改 DOM 顺序）
  var sClasses = [];
  for (var sc = 0; sc < sInner.children.length; sc++) {
    sClasses.push(sInner.children[sc].className);
  }
  if (sClasses.join(',') !== 'cf-num,cf-glyph,cf-name,cf-en,cf-suit') {
    slotProblems.push('第 ' + (si + 1) + ' 张内容顺序异常：' + sClasses.join(','));
  }

  // 4. 牌名不能空——空白牌说明渲染出了问题
  var sName = sNode.querySelector('.cf-name');
  if (!sName || !sName.textContent) {
    slotProblems.push('第 ' + (si + 1) + ' 张没有牌名');
  }
}
check('全部 10 张牌的结构与朝向标记都正确', slotProblems.length === 0,
  slotProblems.join(' | '));

// 重抽保证了这一轮里正逆位都有，所以「逆位渲染」这条路径**一定**被验到了。
// （原来这里是「对随机结果断言正逆位都有」，0.2% 概率随机红。）
var reversedCount = allCards.filter(function (c) { return c.reversed; }).length;
check('这一轮里正逆位都有（重抽已保证，逆位路径确实被验到）',
  reversedCount > 0 && reversedCount < allCards.length,
  '逆位 ' + reversedCount + ' / ' + allCards.length);

// 逆位牌的类名必须和数据一致——上一节已逐张验过，这里再点名一句
check('逆位牌确实带了 is-reversed 类',
  document.querySelectorAll('#tableSurface .slot.is-reversed').length === reversedCount,
  'DOM 里 ' + document.querySelectorAll('#tableSurface .slot.is-reversed').length +
  ' 个，数据里 ' + reversedCount + ' 个');

// 收尾：切回单张牌阵，别影响后面的章节
Tarot.App.state.spreadKey = 'single';
click(byId('btnDraw'));
click(document.querySelector('#fanSurface .fan-card'));

section('交互 · 牌义弹窗与翻转');

// 这一段跑在补充牌测试之后，当前状态是「单张牌阵的牌已经抽完」。
// 用当前状态推导期望值，不要把牌阵和张数写死——写死的话，
// 以后在它前面插入任何改变牌阵的测试都会连带把它弄坏。
var viewBeforeFlip = Tarot.App.state.result.cards.length + Tarot.App.state.bonus.length;
eq('牌桌张数等于牌阵加补充牌',
  document.querySelectorAll('#tableSurface .slot').length, viewBeforeFlip);

/*
 * 牌面内容要套在 .cf-inner 里。
 *
 * 这一层是为了逆位——逆位时转的是**整块内容**，而不是逐个文字元素。
 * 逐个转的话，每个字自己转了 180°，但 flex 里的排列顺序没变，屏幕上就是
 * 「数字在上、花色在下、每个字却头朝下」这种四不像。转整块才会连顺序一起翻，
 * 那才是真正的逆位。
 *
 * 放在这里是因为此刻牌桌上已经有牌了；写在扇形那一段会取不到元素而整段跳过
 * （第一版就是那么写的，8 条断言静默失效，测试数没变才发现）。
 */
var frontNode = document.querySelector('#tableSurface .card-front');
check('牌桌上找得到 .card-front', Boolean(frontNode));
if (frontNode) {
  var cfInner = frontNode.querySelector('.cf-inner');
  check('牌面内容包在 .cf-inner 里', Boolean(cfInner));
  if (cfInner) {
    // 五段文字必须都在这一层里，顺序是「数字 → 符号 → 牌名 → 英文 → 花色」
    var expectedOrder = ['cf-num', 'cf-glyph', 'cf-name', 'cf-en', 'cf-suit'];
    var actualOrder = [];
    for (var ci = 0; ci < cfInner.children.length; ci++) {
      actualOrder.push(cfInner.children[ci].className);
    }
    eq('牌面内容是这五段且顺序正确', actualOrder.join(','), expectedOrder.join(','));
    check('牌面文字都在内容层里（不在 .card-front 直下）',
      frontNode.children.length === 1 &&
      frontNode.children[0].className === 'cf-inner',
      '直下子节点数 ' + frontNode.children.length);
    check('牌面文字没有丢', cfInner.textContent.length > 3, cfInner.textContent);
  }
}

click(document.querySelector('#tableSurface .slot'));
check('弹窗打开', byId('cardModal').hidden === false);
check('弹窗标题含牌位名',
  byId('cardModalTitle').textContent.indexOf(
    Tarot.App.state.result.cards[0].position.title) >= 0,
  byId('cardModalTitle').textContent);
check('弹窗含当前朝向牌义', byId('cardModalBody').textContent.indexOf('当前朝向') >= 0);
check('弹窗含另一朝向', byId('cardModalBody').textContent.indexOf('另一种朝向') >= 0);
check('弹窗含牌位在问什么',
  byId('cardModalBody').textContent.indexOf('在这个牌阵里') >= 0);

var beforeOrientation = Tarot.App.state.result.cards[0].orientation;
click(byId('btnFlipCard'));
check('朝向已翻转', Tarot.App.state.result.cards[0].orientation !== beforeOrientation);
check('翻转后弹窗关闭', byId('cardModal').hidden === true);
eq('翻转后牌桌重绘且张数不变',
  document.querySelectorAll('#tableSurface .slot').length, viewBeforeFlip);

section('交互 · 历史记录');

click(byId('btnHistory'));
check('历史弹窗打开', byId('historyModal').hidden === false);
var historyItems = document.querySelectorAll('#historyList .history-item').length;
check('历史列表有条目', historyItems >= 2, '实际 ' + historyItems + ' 条');

var restoreBtn = (function () {
  var buttons = document.querySelectorAll('#historyList button');
  for (var i = 0; i < buttons.length; i++) {
    if (buttons[i].textContent.indexOf('重新载入') >= 0) return buttons[i];
  }
  return null;
})();
check('找得到重新载入按钮', Boolean(restoreBtn));
if (restoreBtn) {
  click(restoreBtn);
  check('载入后关闭弹窗', byId('historyModal').hidden === true);
  // 载入的可能是带补充牌的那次，所以期望值是「牌阵 + 还原出来的补充牌」
  eq('载入后牌桌重绘',
    document.querySelectorAll('#tableSurface .slot').length,
    Tarot.App.state.result.cards.length + Tarot.App.state.bonus.length);
  check('载入后补充牌位数量与状态一致',
    document.querySelectorAll('#tableSurface .slot.is-bonus').length ===
      Tarot.App.state.bonus.length);
  // 载入后必须还能继续追加：牌池由「完整牌库 - 已抽的牌」重建，
  // remaining 的长度就是真实剩余量，所以它天然不会为负。
  check('载入后剩余张数不为负', Tarot.App.state.result.remaining.length >= 0,
    '剩余 ' + Tarot.App.state.result.remaining.length);
  check('载入后剩余张数与按钮状态一致', (function () {
    var remaining = Tarot.App.state.result.remaining.length;
    var disabled = byId('btnDrawBonus').disabled;
    return disabled === (remaining === 0);
  })(), '剩余 ' + Tarot.App.state.result.remaining.length +
    '，disabled=' + byId('btnDrawBonus').disabled);
  check('载入后剩余牌与已抽牌不重叠', (function () {
    var drawn = {};
    Tarot.App.state.result.drawnIds.forEach(function (id) { drawn[id] = true; });
    return Tarot.App.state.result.remaining.every(function (id) { return !drawn[id]; });
  })());
}

section('交互 · 接口设置弹窗');

click(byId('btnSettings'));
check('设置弹窗打开', byId('settingsModal').hidden === false);
eq('服务预设渲染出 ' + Tarot.LLM.providers.length + ' 个',
  byId('providerSelect').options.length, Tarot.LLM.providers.length);
eq('默认选中 DeepSeek', byId('providerSelect').value, 'deepseek');
eq('地址已填入', byId('baseUrl').value, 'https://api.deepseek.com/v1');
eq('模型名已填入', byId('model').value, 'deepseek-chat');
check('预设说明非空', byId('providerNote').textContent.length > 4);

// 换预设应当自动填地址
byId('providerSelect').value = 'ollama';
var changeEvent = document.createEvent('HTMLEvents');
changeEvent.initEvent('change', true, true);
byId('providerSelect').dispatchEvent(changeEvent);
eq('切预设自动填地址', byId('baseUrl').value, 'http://localhost:11434/v1');
eq('切预设自动填模型', byId('model').value, 'qwen2.5:7b');

byId('temperature').value = '1.2';
click(byId('btnSaveSettings'));
eq('保存后温度写入状态', Tarot.App.state.settings.temperature, 1.2);
check('保存后关闭弹窗', byId('settingsModal').hidden === true);

/* ================================================================== *
 * 完整解读渲染（不联网，直接注入结果）
 * ================================================================== */

section('完整解读渲染');

var result = makeDraw({ spreadKey: 'three-choice', question: '渲染联动测试' });
Tarot.App.state.result = result;
Tarot.App.state.payload = {
  reading: {
    // 新结构：verdict / cards（带 gist）/ actions
    verdict: '这是结论文字。',
    cards: result.cards.map(function (item, i) {
      return {
        index: i + 1,
        position: item.position.title,
        quote: i === 1 ? '这段牌义原文里根本不存在' : item.meaning.text.slice(1, 16),
        gist: '第 ' + (i + 1) + ' 张牌的一句话摘要。',
        reading: '第 ' + (i + 1) + ' 个牌位的解读。',
        // 牌本身的含义（按当前朝向取），界面上先显示这个再显示解读
        meaning: item.meaning,
        quoteOk: i !== 1,
        orientation: item.orientation,
        cardName: item.card.name
      };
    }),
    actions: ['行动甲', '行动乙', '行动丙']
  },
  quoteStats: { ok: 2, total: 3 },
  issues: ['第 2 个牌位的引文未通过核对'],
  usage: { total_tokens: 2048 }
};
Tarot.App.render();

var readingText = byId('readingBody').textContent;
check('渲染出结论', readingText.indexOf('这是结论文字。') >= 0);
check('渲染出行动清单', readingText.indexOf('行动甲') >= 0);
check('渲染出每张牌的一句话摘要', readingText.indexOf('第 1 张牌的一句话摘要') >= 0);
check('渲染出引文核对比例', readingText.indexOf('引文核对 2/3') >= 0);
check('渲染出校验问题', readingText.indexOf('校验时发现 1 处问题') >= 0);
check('渲染出用量', readingText.indexOf('2048') >= 0);

/*
 * 顺序：结论 → 每张牌 → 行动。
 *
 * 用户明确提过这一点：「倾向说完了之后应该接每张牌是代表什么，是什么意思」。
 * 行动是从牌面推出来的结论，排在牌面前面等于把推理链倒过来讲。
 */
check('顺序是 结论 → 每张牌 → 行动', (function () {
  var body = byId('readingBody');
  var verdict = body.querySelector('.reading-verdict');
  var cards = body.querySelector('.card-readings');
  var actions = body.querySelector('.reading-actions-block');
  if (!verdict || !cards || !actions) return false;
  var FOLLOWING = 4;
  return Boolean(verdict.compareDocumentPosition(cards) & FOLLOWING) &&
    Boolean(cards.compareDocumentPosition(actions) & FOLLOWING);
})(), '期望 结论 在 每张牌 之前，每张牌 在 行动 之前');

/*
 * 每张牌要显示「这张牌本身是什么意思」，而且必须是**当前朝向**的那一份。
 *
 * 「正位就解释正位的意思，逆位就解释逆位的意思」——Cards.meaning() 已按朝向
 * 取好（正位取 up、逆位取 rev），这条断言把「渲染出来的确实是那一份」钉住。
 */
var firstCardBlock = byId('readingBody').querySelector('.card-reading');
check('牌位块里渲染了「这张牌的意思」', Boolean(firstCardBlock.querySelector('.cr-meaning')));
check('牌义标签标出了朝向',
  firstCardBlock.querySelector('.cr-meaning-tag').textContent.indexOf(
    result.cards[0].orientation) >= 0,
  firstCardBlock.querySelector('.cr-meaning-tag').textContent);
check('渲染出的牌义就是当前朝向那一份（正位对正位、逆位对逆位）',
  firstCardBlock.querySelector('.cr-meaning-text').textContent ===
    result.cards[0].meaning.text,
  '期望与 Cards.meaning 给的一致');
check('渲染了牌义关键词',
  firstCardBlock.querySelectorAll('.cr-keyword').length ===
    result.cards[0].meaning.keywords.length);
check('牌义排在针对问题的解读之前', (function () {
  var meaning = firstCardBlock.querySelector('.cr-meaning');
  var own = firstCardBlock.querySelector('.cr-own');
  if (!meaning || !own) return false;
  return Boolean(meaning.compareDocumentPosition(own) & 4);
})(), '应该先讲牌本身，再讲它对你这个问题说明什么');

var cardBlocks = document.querySelectorAll('#readingBody .card-reading');
eq('渲染出 3 个牌位解读块', cardBlocks.length, 3);
if (cardBlocks.length === 3) {
  check('第 1 个标为已核对', cardBlocks[0].textContent.indexOf('已核对') >= 0);
  check('第 2 个标为未通过', cardBlocks[1].textContent.indexOf('未通过核对') >= 0);
  check('第 2 个的引文框带错误类',
    document.querySelectorAll('#readingBody .cr-quote.is-bad').length === 1,
    '实际 ' + document.querySelectorAll('#readingBody .cr-quote.is-bad').length + ' 个');
  check('每个块都显示牌名', (function () {
    for (var i = 0; i < 3; i++) {
      if (cardBlocks[i].textContent.indexOf(result.cards[i].card.name) < 0) return false;
    }
    return true;
  })());
}

section('问题质量提示与贴合度');

// 短到问不出东西的问题给一句提示（注意：不是「劝退」，只是提醒写具体点）
typeInto(byId('question'), '嗯');
check('过短问题显示提示', byId('questionQuality').hidden === false);
check('提示说明问题有点短',
  byId('questionQuality').textContent.indexOf('有点短') >= 0,
  byId('questionQuality').textContent.slice(0, 60));
check('过短提示带警示样式',
  byId('questionQuality').className.indexOf('is-thin') >= 0,
  byId('questionQuality').className);

/*
 * 开放式问题（「我今天会发生些什么」）是完全正当的塔罗问法。
 *
 * 这里专门盯住它**不能**被当成「问得不好」：早先它会被打上 is-thin 并弹出
 * 「问题比较笼统」的警告，那是个判断错误。现在应该是中性的 is-open，
 * 并且说明它会被怎么读。
 */
typeInto(byId('question'), '我今天会发生些什么');
check('开放问题显示提示', byId('questionQuality').hidden === false);
check('开放问题用中性样式而不是警示样式',
  byId('questionQuality').className.indexOf('is-open') >= 0 &&
  byId('questionQuality').className.indexOf('is-thin') < 0,
  byId('questionQuality').className);
check('开放问题不被说成笼统',
  byId('questionQuality').textContent.indexOf('笼统') < 0,
  byId('questionQuality').textContent.slice(0, 80));
check('开放问题说明它会被怎么读',
  byId('questionQuality').textContent.indexOf('什么值得留意') >= 0);
check('开放问题带上它提到的时段',
  byId('questionQuality').textContent.indexOf('今天') >= 0);
check('开放问题明确说这样问也没问题',
  byId('questionQuality').textContent.indexOf('完全没问题') >= 0);

/*
 * 指向具体事情的是非问句不该被当成开放问题。
 *
 * 这是一个真实误判：「我现在继续和她打游戏可以增加好感吗」指向很具体的
 * 一件事，却因为词表里没有「游戏」「好感」而被标成「这是个开放的问题」。
 */
typeInto(byId('question'), '我现在继续和她打游戏可以增加好感吗');
check('是非问句用具体问题的样式',
  byId('questionQuality').className.indexOf('is-rich') >= 0 &&
  byId('questionQuality').className.indexOf('is-open') < 0,
  byId('questionQuality').className);
check('是非问句不被说成开放问题',
  byId('questionQuality').textContent.indexOf('开放的问题') < 0,
  byId('questionQuality').textContent.slice(0, 80));
check('是非问句列出抽出的实词',
  byId('questionQuality').textContent.indexOf('游戏') >= 0 &&
  byId('questionQuality').textContent.indexOf('好感') >= 0,
  byId('questionQuality').textContent.slice(0, 100));
check('是非问句说明会给明确判断',
  byId('questionQuality').textContent.indexOf('行不行') >= 0,
  byId('questionQuality').textContent.slice(0, 120));

// 具体的问题要列出会被围绕的方面
typeInto(byId('question'), '我现在的工作让我很疲惫，要不要换工作？');
check('具体问题不再警示',
  byId('questionQuality').className.indexOf('is-rich') >= 0,
  byId('questionQuality').className);
check('提示列出具体方面', byId('questionQuality').textContent.indexOf('会围绕这些点展开') >= 0);
check('列出了「工作」这个词',
  byId('questionQuality').textContent.indexOf('工作') >= 0);
check('识别为选择型并说明', byId('questionQuality').textContent.indexOf('要做选择') >= 0);

// 清空问题则隐藏提示
typeInto(byId('question'), '');
check('问题清空后隐藏提示', byId('questionQuality').hidden === true);

// 背景字段已经去掉：页面上不该再出现它（塔罗不需要额外背景输入）
check('页面上没有背景输入框', byId('background') === null);
check('状态里也没有 background',
  Tarot.App.state.background === undefined, String(Tarot.App.state.background));

section('解读里的贴合度与 primer');

var fitResult = makeDraw({ spreadKey: 'three-choice', question: '要不要换工作？' });
Tarot.App.state.result = fitResult;
Tarot.App.state.bonus = [];
Tarot.App.state.payload = {
  reading: {
    verdict: '结论：你真正卡住的不是要不要换，而是怕换了还是一样。',
    cards: fitResult.cards.map(function (item, i) {
      return {
        index: i + 1,
        position: item.position.title,
        quote: item.meaning.text.slice(1, 16),
        gist: i === 1 ? '这段关系需要更多的沟通。' : '关于换工作，你怕的是一样。',
        // 第 2 条故意写成套话，用来验证它会被标出来
        reading: i === 1 ? '这段关系需要更多的沟通。相信自己。' : '关于换工作，你怕的是一样。',
        quoteOk: true,
        orientation: item.orientation,
        cardName: item.card.name
      };
    }),
    actions: ['行动一', '行动二']
  },
  quoteStats: { ok: 3, total: 3 },
  specificity: Tarot.LLM.evaluateSpecificity({
    verdict: '总览文字。',
    actions: [],
    cards: fitResult.cards.map(function (item, i) {
      return {
        index: i + 1, position: item.position.title, cardName: item.card.name,
        quote: '', reading: i === 1 ? '这段关系需要更多的沟通。相信自己。' : '关于换工作，你怕的是一样。',
        quoteOk: true
      };
    })
  }, Tarot.LLM.parseQuestion('要不要换工作？'), ''),
  issues: [],
  usage: null
};
Tarot.App.render();

var fitBody = byId('readingBody');
check('渲染出贴合度横幅',
  fitBody.querySelectorAll('.fit-banner').length === 1,
  '实际 ' + fitBody.querySelectorAll('.fit-banner').length + ' 个');
check('横幅显示「问题贴合度」', fitBody.textContent.indexOf('问题贴合度') >= 0);
check('横幅点出跟问题关系不大的条数',
  fitBody.textContent.indexOf('内容换个问题也成立') >= 0, fitBody.textContent.slice(0, 200));
check('散掉的那条被标注',
  fitBody.querySelectorAll('.card-reading.is-loose').length === 1,
  '实际 ' + fitBody.querySelectorAll('.card-reading.is-loose').length + ' 条');
check('标注用了「与问题关系不大」的标签',
  fitBody.querySelectorAll('.loose-tag').length === 1);
check('横幅提供「换个说法再解读一次」的按钮',
  fitBody.textContent.indexOf('换个说法再解读一次') >= 0);
check('横幅提供「回去把问题写具体」的按钮',
  fitBody.textContent.indexOf('回去把问题写具体') >= 0);

/*
 * 结论必须渲染出来。
 *
 * 这里从前检查的是「primer 区块」——那个「模型对你这个问题的理解」段落
 * 已经删掉了：它是模型在自言自语，用户不关心模型怎么理解自己的问题。
 * 现在最重要的是结论，所以断言换到它上面。
 */
check('渲染出结论', fitBody.textContent.indexOf('你真正卡住的不是要不要换') >= 0,
  fitBody.textContent.slice(0, 150));
check('结论排在牌位细节之前', (function () {
  var verdictBox = fitBody.querySelector('.reading-verdict');
  var cardList = fitBody.querySelector('.card-readings');
  if (!verdictBox || !cardList) return false;
  // compareDocumentPosition 的 DOCUMENT_POSITION_FOLLOWING (4) 表示 cardList 在后面
  return Boolean(verdictBox.compareDocumentPosition(cardList) & 4);
})(), '结论应该出现在每张牌的细节之前');

// 贴合度 good 时不显示警示文案
var goodSpec = Tarot.LLM.evaluateSpecificity({
  primer: 'p', overview: 'o', synthesis: 's', actions: [], watchOut: 'w',
  cards: fitResult.cards.map(function (item, i) {
    return {
      index: i + 1, position: item.position.title, cardName: item.card.name,
      quote: '', reading: '关于换工作，你要的是把自己从疲惫里拿出来。', action: '算清现金流。',
      quoteOk: true
    };
  })
}, Tarot.LLM.parseQuestion('要不要换工作？'), '');
Tarot.App.state.payload.specificity = goodSpec;
Tarot.App.state.payload.reading.cards.forEach(function (c) {
  c.reading = '关于换工作，你要的是把自己从疲惫里拿出来。';
  c.action = '先算清现金流。';
});
Tarot.App.render();
check('贴合度好时横幅为 good 样式',
  byId('readingBody').querySelectorAll('.fit-banner.is-good').length === 1);
check('贴合度好时不出现「关系不大」的字样',
  byId('readingBody').textContent.indexOf('内容换个问题也成立') < 0);
check('贴合度好时没有散牌位标注',
  byId('readingBody').querySelectorAll('.loose-tag').length === 0);

/* ================================================================== *
 * XSS：模型返回里的脚本不能变成元素
 * ================================================================== */

section('XSS 防护');

Tarot.App.state.payload = {
  reading: {
    overview: '<img src=x onerror=alert(1)>',
    cards: [{
      index: 1, position: result.cards[0].position.title,
      quote: '<script>alert(2)</script>', reading: '<b>加粗</b>',
      action: '<iframe src="evil"></iframe>', quoteOk: false,
      orientation: '正位', cardName: '愚者'
    }],
    synthesis: '<svg onload=alert(3)>',
    actions: ['<a href="javascript:alert(4)">点我</a>'],
    watchOut: '<style>*{display:none}</style>'
  },
  quoteStats: { ok: 0, total: 1 },
  issues: ['<img src=x onerror=alert(5)>'],
  usage: null
};
Tarot.App.render();

var body = byId('readingBody');
var injected = body.querySelectorAll('img, script, iframe, svg, style, b, a');
eq('模型返回里的标签没有变成元素', injected.length, 0,
  (function () {
    var names = [];
    for (var i = 0; i < injected.length; i++) names.push(injected[i].tagName);
    return names.join(',');
  })());
check('恶意文本以纯文本呈现', body.textContent.indexOf('<script>alert(2)</script>') >= 0);

/* ================================================================== *
 * 顶栏不悬浮
 *
 * 这一段记录一次失败的尝试，免得以后又走回去。
 *
 * 顶栏原来是 position: sticky，一直浮在内容上方。手机上它占 70 多像素，
 * 而待挑牌区要滚十几行——牌从它下面滑过去就被盖住。
 *
 * 第一版修法是「向下滚时把顶栏收起」。它解决了静止时的遮挡，但**快速滑动时
 * 折叠动画追不上滚动位置**，牌还是会露到顶栏上面去。靠动画去躲滚动是治不好的。
 *
 * 最终改成顶栏 position: relative——它就是普通内容，往下滚就跟着滚走。
 * 滚走之后绝不会盖住任何东西，也不存在「动画跟不跟得上」的问题。
 *
 * 所以这里验的是「它没有 sticky / fixed，也没有留下折叠状态」。
 * ================================================================== */

section('顶栏不悬浮');

var topbar = document.querySelector('.topbar');
check('页面上找得到 .topbar', Boolean(topbar));
check('顶栏没有残留的折叠状态',
  Boolean(topbar) && !topbar.classList.contains('is-collapsed'));

/*
 * 滚动之后顶栏的类不该有任何变化——以前是「向下滚加 is-collapsed」，
 * 现在那条逻辑已经删掉了。这条断言防止它被无意中改回去。
 *
 * 守卫条件要**显式断言**，不能只靠 if。条件不成立时整块被跳过、
 * 套件仍打印「全部通过」——本项目踩过这个坑。虽然末尾的断言数基线
 * 也能兜住，但那要等到最后才知道少了东西；这里直接说清是哪个前提没成立。
 */
/* ---------------------------------------------------------------- *
 * 按钮震动
 *
 * 开关状态在 verify-ui.js 里测过了，这里测真正要紧的那一半：
 * haptic() 到底有没有把 navigator.vibrate 叫起来。只验开关的话，
 * 一个把 vibrate 拼错、或者被 if 挡住的实现也能全绿。
 *
 * domino 的 window 上没有 vibrate，先换掉 navigator。换不掉的话下面
 * 三条断言跑不到，断言总数会变少，MIN_EXPECTED_ASSERTIONS 会当场报出来。
 * ---------------------------------------------------------------- */
var vibrated = [];
Object.defineProperty(window, 'navigator', {
  value: { vibrate: function (ms) { vibrated.push(ms); } },
  configurable: true
});

section('按钮震动');
var hapticApp = window.Tarot.App;

hapticApp.state.settings.haptic = true;
hapticApp.state.busy = false;
hapticApp.startShuffle('main');
check('抽牌时调用了震动', vibrated.length === 1, 'vibrated=' + JSON.stringify(vibrated));
check('震动时长是 14ms', vibrated[0] === 14, String(vibrated[0]));

hapticApp.state.settings.haptic = false;
hapticApp.state.busy = false;
hapticApp.startShuffle('main');
check('关掉开关后不再震动', vibrated.length === 1, 'vibrated=' + JSON.stringify(vibrated));

hapticApp.state.settings.haptic = true;

section('顶栏滚动');
check('顶栏存在且支持事件监听（滚动断言的前提）',
  Boolean(topbar) && typeof window.addEventListener === 'function',
  'topbar=' + Boolean(topbar) + ' addEventListener=' + typeof window.addEventListener);

if (topbar && typeof window.addEventListener === 'function') {
  window.pageYOffset = 300;
  window.dispatchEvent(new window.Event('scroll'));

  setTimeout(function () {
    check('滚动后顶栏的类名不变（折叠逻辑已移除）',
      !topbar.classList.contains('is-collapsed'),
      topbar.className);

    section('页面错误汇总');
    eq('整个流程没有产生任何页面错误', pageErrors.length, 0, pageErrors.join(' | '));
    report();
  }, 0);

  return;
}

/* ================================================================== *
 * 汇总
 * ================================================================== */

section('页面错误汇总');
eq('整个流程没有产生任何页面错误', pageErrors.length, 0, pageErrors.join(' | '));

report();

} // runAssertions 结束

/*
 * 断言数基线。
 *
 * 这个文件里有多处 `if (xxx) { ...若干条断言... }` 的守卫块，
 * 条件不成立时整块被跳过，而套件仍然打印「全部通过」——只是断言数悄悄变少。
 * **本项目正是在这个文件里踩过这个坑**：新加的牌面结构断言写在扇形那一段，
 * 而那时牌桌还没渲染、`querySelector('.card-front')` 返回 null，
 * 整块 8 条被静默跳过，是靠「测试数怎么没变」才发现的。
 *
 * 所以最后核对一次总数。**加了新断言就把这个数改大**；
 * 它变小，就说明有东西被跳过了。
 */
var MIN_EXPECTED_ASSERTIONS = 240;

function report() {
  if (passed < MIN_EXPECTED_ASSERTIONS) {
    failures.push({
      group: '断言数基线',
      label: '断言数不足',
      detail: '只跑了 ' + passed + ' 项，基线是 ' + MIN_EXPECTED_ASSERTIONS +
        ' 项。多半是某个 if 守卫没成立、整块断言被跳过了。'
    });
  }

  console.log('\n' + '='.repeat(62));
  if (failures.length === 0) {
    console.log('全部通过：' + passed + ' 项断言（真实 DOM 引擎）');
    console.log('='.repeat(62));
    process.exit(0);
  }
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项：');
  failures.forEach(function (item) {
    console.log('  [' + item.group + '] ' + item.label + (item.detail ? '  → ' + item.detail : ''));
  });
  console.log('='.repeat(62));
  process.exit(1);
}
