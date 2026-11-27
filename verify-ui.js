/*
 * verify-ui.js —— 页面行为冒烟测试（无头）
 *
 *     node verify-ui.js
 *
 * verify.js 测的是「逻辑对不对」，这个文件测的是「页面连起来能不能动」：
 * 把 index.html 里的元素用 DOM 替身摆好，然后真的调用 app.js 的初始化、
 * 抽牌、翻转牌面、渲染解读——也就是把用户点一遍的路径走一遍。
 *
 * 它能抓到 verify.js 抓不到的一类错误：函数名写错、参数顺序错、
 * 在某个分支里访问了不存在的元素、状态改完忘了重渲染。
 * 这些错在纯逻辑测试里完全看不出来，但一打开页面就是白屏。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var BASE = path.join(__dirname, 'js');
['random.js', 'cards-major.js', 'cards-minor.js', 'cards.js', 'spreads.js', 'engine.js',
  'llm.js', 'render.js'].forEach(function (file) { require(path.join(BASE, file)); });

/* ================================================================== *
 * 迷你测试框架（与 verify.js 同一套写法）
 * ================================================================== */

var passed = 0;
var failures = [];
var group = '';

function section(name) {
  group = name;
  console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(0, 56 - name.length)));
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

/* ================================================================== *
 * DOM 替身
 * ================================================================== */

/*
 * 被测代码（js/*.js）真正会用到的选择器。
 *
 * 替身没有选择器引擎，但这几个必须放行——否则 render.js 的
 * measureAvailableWidth 拿不到容器、app.js 绑不上关闭按钮，初始化直接崩。
 * 它们返回「找不到」，被测代码会走各自的后退路径（render.js 退回推算宽度，
 * app.js 跳过绑定），这是这个精简环境下的预期行为。
 *
 * 维护方式：被测代码里新增选择器调用时，跑一次测试就会在
 * querySelector 那里抛错并报出是哪个选择器，把它加到这里即可。
 * 反过来，测试里写别的选择器会被拦住——那正是这个白名单要防的假通过。
 */
var PRODUCTION_SELECTORS = [
  '.table-wrap',   // render.js measureAvailableWidth
  '.fan-wrap',     // render.js measureAvailableWidth 的备选
  '[data-close]'   // app.js bindModals：弹窗的关闭按钮
];

function createDom() {
  function Node(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = new Style();
    this.attributes = {};
    this.listeners = {};
    this._text = '';
    this.className = '';
    this.id = '';
    this.hidden = false;
    this.value = '';
    this.disabled = false;
    this.tabIndex = 0;
    this.checked = false;
  }

  function Style() { this._p = {}; }
  Style.prototype.setProperty = function (k, v) { this._p[k] = v; };
  Style.prototype.getPropertyValue = function (k) { return this._p[k] || ''; };

  Node.prototype.appendChild = function (child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  };
  Node.prototype.removeChild = function (child) {
    var i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  };
  Node.prototype.setAttribute = function (name, value) { this.attributes[name] = String(value); };
  Node.prototype.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  };
  Node.prototype.addEventListener = function (type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  };
  Node.prototype.focus = function () {};
  Node.prototype.scrollIntoView = function () {};

  /*
   * classList：app.js 里用 btnDraw.classList.toggle('is-shuffling') 控制抽牌动画，
   * render.js 里用 className 字符串拼类名。两者必须指向同一份数据，
   * 否则「切换后按钮高亮」这类断言会看到不一致的状态。
   * 这里用一个 getter 让 classList 每次读写都落在 className 上。
   */
  Object.defineProperty(Node.prototype, 'classList', {
    get: function () {
      var node = this;
      return {
        contains: function (name) {
          return (' ' + node.className + ' ').indexOf(' ' + name + ' ') >= 0;
        },
        add: function (name) {
          if (!this.contains(name)) {
            node.className = (node.className ? node.className + ' ' : '') + name;
          }
        },
        remove: function (name) {
          node.className = (' ' + node.className + ' ')
            .split(' ').filter(function (part) {
              return part && part !== name;
            }).join(' ');
        },
        toggle: function (name, force) {
          var on = typeof force === 'boolean' ? force : !this.contains(name);
          if (on) this.add(name); else this.remove(name);
          return on;
        }
      };
    }
  });

  /** 触发某个事件的所有监听器 */
  Node.prototype.fire = function (type, event) {
    var handlers = this.listeners[type] || [];
    handlers.forEach(function (handler) { handler(event || {}); });
    return handlers.length;
  };

  Object.defineProperty(Node.prototype, 'firstChild', {
    get: function () { return this.children.length ? this.children[0] : null; }
  });

  Object.defineProperty(Node.prototype, 'textContent', {
    get: function () {
      var out = this._text || '';
      for (var i = 0; i < this.children.length; i++) out += this.children[i].textContent;
      return out;
    },
    set: function (value) {
      this._text = value === null || value === undefined ? '' : String(value);
      this.children = [];
    }
  });

  /** 深度优先找出所有后代里符合条件的节点 */
  Node.prototype.findAll = function (predicate) {
    var out = [];
    (function walk(node) {
      node.children.forEach(function (child) {
        if (predicate(child)) out.push(child);
        walk(child);
      });
    })(this);
    return out;
  };

  var byId = {};

  var document = {
    createElement: function (tag) { return new Node(tag); },
    createTextNode: function (text) {
      var node = new Node('#text');
      node._text = String(text);
      return node;
    },
    getElementById: function (id) { return byId[id] || null; },

    /*
     * 选择器：**白名单放行，其余一律抛错**。
     *
     * 这个替身是按 index.html 里的 id 建元素的，没有选择器引擎。
     *
     * 为什么不能简单地一律返回 null / []：
     *   被测代码自己会调选择器——render.js 的 measureAvailableWidth 查
     *   `.table-wrap` / `.fan-wrap`，app.js 查 `[data-close]`。替身不认这些，
     *   初始化会在 applyMetrics 里崩掉（这个坑当场踩到了）。
     *
     * 为什么也不能全部放行、都返回「找不到」：
     *   那样测试里写 `doc.querySelectorAll('.foo').length === 0` 会**静默通过**
     *   ——看着验过了，其实什么都没查。
     *
     * 所以：被测代码真正用到的那几个放行（返回「找不到」，让它走回退路径），
     * 其余抛错。以后有人在测试里写别的选择器，第一次跑就当场失败，
     * 立刻知道该换写法（用 getElementById，或者去 verify-browser.js 用真 domino）。
     */
    querySelector: function (sel) {
      if (PRODUCTION_SELECTORS.indexOf(sel) >= 0) return null;
      throw new Error('这个 DOM 替身不支持选择器 ' + JSON.stringify(sel) + '。' +
        '测试里请改用 getElementById 拿到的节点直接断言，' +
        '或把这条测试放到 verify-browser.js（那边是真 domino，支持完整选择器）。' +
        '（故意抛错而不是返回 null——返回 null 会让断言静默假通过。）');
    },
    querySelectorAll: function (sel) {
      if (PRODUCTION_SELECTORS.indexOf(sel) >= 0) return [];
      throw new Error('这个 DOM 替身不支持选择器 ' + JSON.stringify(sel) + '。' +
        '测试里请改用 getElementById 拿到的节点直接断言，' +
        '或把这条测试放到 verify-browser.js（那边是真 domino，支持完整选择器）。' +
        '（故意抛错而不是返回空数组——返回空数组会让断言静默假通过。）');
    },

    addEventListener: function () {},
    body: new Node('body'),
    readyState: 'complete'
  };

  /** 按 index.html 里的 id 建出所有元素 */
  function define(id, tag) {
    var node = new Node(tag || 'div');
    node.id = id;
    byId[id] = node;
    return node;
  }

  /*
   * 元素清单直接从 index.html 里读出来，不再手写维护。
   *
   * 手写清单的问题是：页面每加一个元素，这里就得同步加一行，忘了就是
   * 「某个测试莫名其妙挂在 textOf(undefined) 上」。既然 id 的真实来源就是
   * index.html，那就去那里读——永远不会不同步。
   *
   * 标签名（button / textarea / input）对渲染层有影响，所以单独标注；
   * 其余一律当 div 处理。
   */
  var html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  var TAG_HINTS = {
    question: 'textarea', background: 'textarea',
    btnDraw: 'button', btnDrawText: 'span', btnFanDone: 'button', btnHistory: 'button',
    btnSettings: 'button', btnTest: 'button', btnSaveSettings: 'button',
    btnBonusMinus: 'button', btnBonusPlus: 'button', btnDrawBonus: 'button',
    btnBonusPick: 'button', btnClearHistory: 'button', btnFlipCard: 'button',
    providerSelect: 'select', baseUrl: 'input', model: 'input', apiKey: 'input',
    temperature: 'input', hapticToggle: 'input',
    cardModalTitle: 'h3', fanPrompt: 'p', bonusNote: 'p', tableFoot: 'p', toast: 'div'
  };

  var ids = [];
  var idRe = /\bid="([^"]+)"/g;
  var match;
  while ((match = idRe.exec(html)) !== null) {
    if (ids.indexOf(match[1]) < 0) ids.push(match[1]);
  }
  ids.forEach(function (id) { define(id, TAG_HINTS[id] || 'div'); });

  return { document: document, byId: byId, define: define, Node: Node, ids: ids };
}

/**
 * 测试用的抽牌助手：走完整的「洗牌 → 挑牌 → 收尾」流程。
 * 真实用户自己点扇形选位置；测试里固定挑「第 0 个位置」以保证可复现，
 * 随机性仍全部来自 crypto。
 */
function drawAuto(options) {
  var session = globalThis.Tarot.Engine.prepareFan(options);
  for (var i = 0; i < session.needed; i++) {
    globalThis.Tarot.Engine.takeFromFan(session, 0);
  }
  return globalThis.Tarot.Engine.finalizeDraw(session);
}

/**
 * 按真实用户路径完成一次抽牌：点「洗牌」按钮 → 依次点扇形里最左那张 → 收尾。
 *
 * 与 drawAuto 的区别是它走的是界面（会触发渲染、历史记录、状态流转），
 * 所以能顺带验证整条交互链路。
 *
 * @param {number} [howMany] 要挑几张；省略则挑到够为止
 * @returns {number} 实际挑的张数
 */
function pickThroughUI(howMany) {
  $('btnDraw').fire('click');
  if (!state.session) return 0;

  var target = howMany === undefined ? state.session.needed : howMany;
  var picked = 0;
  while (picked < target && $('fanSurface').children.length > 0) {
    $('fanSurface').children[0].fire('click');
    picked += 1;
  }
  return picked;
}

var dom = createDom();
globalThis.document = dom.document;
globalThis.localStorage = null; // 逼 app.js 走内存回退路径

// 保存真正的 fetch 备用。同步测试段里把它换成「一调用就失败」的桩，
// 用来确认没有意外的网络请求；异步段再换回来真跑本地 mock 服务。
// 注意：如果这里不先存下原版，「恢复 fetch」就会恢复成桩，
// 后续测试会莫名其妙地全部失败在一个和被测代码无关的地方。
var REAL_FETCH = globalThis.fetch;

globalThis.fetch = function () {
  return Promise.reject(new Error('本测试不应发起网络请求'));
};

// 抽牌后会调 requestAnimationFrame 做平滑滚动。无头环境下直接同步执行，
// 这样「抽牌 → 渲染」在同一步里完成，断言不必等异步。
globalThis.requestAnimationFrame = function (callback) { callback(0); };

// document 准备好之后才能 require app.js（它据此决定是否自动初始化）
require(path.join(BASE, 'app.js'));

var Tarot = globalThis.Tarot;
var App = Tarot.App;
var Render = Tarot.Render;
var state = App.state;
var $ = function (id) { return dom.byId[id]; };

function textOf(node) { return node.textContent; }

/* ================================================================== *
 * 1. 初始化
 * ================================================================== */

section('初始化');

var initErrors = [];
try {
  App.init();
} catch (error) {
  initErrors.push(error && error.stack ? error.stack : String(error));
}
eq('初始化没有抛错', initErrors.length, 0, initErrors.join('\n'));

check('随机源状态被写入徽标', textOf($('rngBadge')).indexOf('加密熵') >= 0, textOf($('rngBadge')));
eq('随机源徽标带成功样式', $('rngBadge').className, 'rng-badge is-ok');

eq('牌阵列表渲染出 6 项', $('spreadList').children.length, 6);
eq('牌库选项渲染出 2 项', $('deckOptions').children.length, 2);
eq('示例问题渲染出 ' + Render.examples.length + ' 条', $('exampleList').children.length, Render.examples.length);
check('牌阵摘要非空', textOf($('spreadCount')).indexOf('单张牌') >= 0, textOf($('spreadCount')));

check('未抽牌时隐藏牌桌', $('panelTable').hidden === true);
check('未抽牌时隐藏解读区', $('panelReading').hidden === true);
check('未抽牌时抽牌按钮可用', $('btnDraw').disabled === false);
check('未抽牌时按钮文案是「洗牌」', textOf($('btnDrawText')) === '洗牌',
  textOf($('btnDrawText')));

eq('默认牌阵是单张牌', state.spreadKey, 'single');
eq('默认牌库是完整 78 张', state.deckKey, 'full');
eq('默认服务是 DeepSeek', state.settings.provider, 'deepseek');
eq('默认接口地址', state.settings.baseUrl, 'https://api.deepseek.com/v1');
eq('默认模型', state.settings.model, 'deepseek-chat');

/* ================================================================== *
 * 2. 抽牌交互
 * ================================================================== */

section('抽牌交互 · 洗牌与扇形挑牌');

// 输入问题
$('question').value = '我要不要接受这个 offer？';
$('question').fire('input');
eq('问题写进状态', state.question, '我要不要接受这个 offer？');

// 点抽牌：这一步只是洗牌并摊开扇形，**不应该**直接产生结果
$('btnDraw').fire('click');

check('洗牌后有了待挑的会话', state.session !== null);
check('洗牌后还没有结果（结果是挑完才成立的）', state.result === null);
eq('扇形里是整副牌', state.session.fanOrder.length, 78);
eq('需要挑 1 张（单张牌阵）', state.session.needed, 1);
check('扇形面板显示出来', $('panelFan').hidden === false);
check('牌桌还没显示（还没有结果）', $('panelTable').hidden === true);
eq('扇形渲染出 78 张牌', $('fanSurface').children.length, 78);
check('扇形提示写明要挑第几张', textOf($('fanPrompt')).indexOf('请挑第 1 张') >= 0,
  textOf($('fanPrompt')));
check('扇形副标题显示进度', textOf($('fanSub')).indexOf('0 / 1') >= 0, textOf($('fanSub')));

// 扇形里的牌不能泄露任何牌面信息
var fanText = textOf($('fanSurface'));
var leaked = Tarot.Cards.deck.some(function (card) { return fanText.indexOf(card.name) >= 0; });
check('扇形里没有任何牌名（不能提前泄露）', !leaked, fanText.slice(0, 80));

// 挑走一张
var firstFanCard = $('fanSurface').children[0];
check('扇形里的牌带位置标记', firstFanCard.getAttribute('data-fan-index') === '0');
firstFanCard.fire('click');

check('挑够张数后生成了结果', state.result !== null);
eq('抽到 1 张牌（单张牌阵）', state.result.cards.length, 1);
eq('问题进入抽牌结果', state.result.question, '我要不要接受这个 offer？');
check('挑完后扇形收起', $('panelFan').hidden === true);
check('牌桌显示出来了', $('panelTable').hidden === false);
check('解读区显示出来了', $('panelReading').hidden === false);
eq('牌桌渲染出 1 个牌位', $('tableSurface').children.length, 1);
check('牌桌摘要显示牌阵名', textOf($('tableSub')).indexOf('单张牌') >= 0, textOf($('tableSub')));
check('牌桌脚注含抽牌编号', textOf($('tableFoot')).indexOf(state.result.id) >= 0);
check('牌桌脚注含随机源说明', textOf($('tableFoot')).indexOf('拒绝采样') >= 0);
check('抽牌后按钮文案变成「重新洗一次」', textOf($('btnDrawText')) === '重新洗一次',
  textOf($('btnDrawText')));
check('写入了历史记录', state.history.length === 1, '实际 ' + state.history.length + ' 条');
eq('历史记录的牌数', state.history[0].cards.length, 1);
eq('历史记录保留了问题', state.history[0].question, '我要不要接受这个 offer？');

// 挑到的那张必须真的来自扇形里的那个位置
check('结果里的牌来自扇形首位', state.result.cards.length === 1);

// init 必须是幂等的：再调一次不应该重复挂监听器
var historyBeforeReinit = state.history.length;
App.init();
$('btnDraw').fire('click');
eq('重复调用 init 不会导致一次点击洗两轮牌', state.session.picks.length, 0);
$('fanSurface').children[0].fire('click');
eq('重复调用 init 后仍只记录一次', state.history.length, historyBeforeReinit + 1);
eq('重复调用 init 不会叠加牌位', $('tableSurface').children.length, 1);

// 重新洗，回到单张牌阵继续后面的断言
$('question').value = '我要不要接受这个 offer？';
$('question').fire('input');

// 解读区显示的是「待生成」
check('解读区显示待生成', textOf($('readingBody')).indexOf('让模型来读') >= 0,
  textOf($('readingBody')).slice(0, 80));
check('解读区标题为待生成', textOf($('readingSub')).indexOf('待生成') >= 0);

// 换牌阵
var celticButton = $('spreadList').children.filter(function (node) {
  return node.getAttribute('data-spread') === 'celtic-cross';
})[0];
check('找得到凯尔特十字按钮', Boolean(celticButton));
celticButton.fire('click');
eq('切换牌阵', state.spreadKey, 'celtic-cross');

// 注意：render() 会重建整个牌阵列表，上面那个 celticButton 节点此刻已经从
// 容器里移除了。必须重新查询才能断言高亮状态——这是一个真实存在的坑：
// 拿着旧节点做断言，永远不会通过。
celticButton = $('spreadList').children.filter(function (node) {
  return node.getAttribute('data-spread') === 'celtic-cross';
})[0];
check('切换后按钮高亮', celticButton.className.indexOf('is-active') >= 0, celticButton.className);
check('切换牌阵不会清掉已有牌面', state.result !== null);

// 切到凯尔特十字后重新洗并挑满
var historyBeforeRedraw = state.history.length;
$('btnDraw').fire('click');
eq('重新洗牌后进入挑牌状态', state.session.needed, 10);
eq('扇形里仍是整副牌', state.session.fanOrder.length, 78);
check('挑牌期间牌桌隐藏（结果还没成立）', $('panelTable').hidden === true);

// 先挑 6 张，确认进度与「挑走的牌从扇形消失」
var pickedSoFar = pickThroughUI(6);
eq('挑了 6 张', pickedSoFar, 6);
eq('扇形里少了 6 张', $('fanSurface').children.length, 72);
eq('会话记录了 6 张', state.session.picks.length, 6);
check('挑牌进度显示在副标题', textOf($('fanSub')).indexOf('6 / 10') >= 0, textOf($('fanSub')));
check('提示写明下一张是第 7 张', textOf($('fanPrompt')).indexOf('请挑第 7 张') >= 0,
  textOf($('fanPrompt')));
eq('已挑的牌列出 6 个', $('fanPicked').children.length, 6);
check('牌桌仍然隐藏（没挑满）', $('panelTable').hidden === true);

// 继续挑满剩下的
pickThroughUI();
eq('挑满 10 张后生成结果', state.result.cards.length, 10);
eq('凯尔特十字渲染 10 个牌位', $('tableSurface').children.length, 10);
check('挑满后扇形收起', $('panelFan').hidden === true);
eq('历史记录每条抽牌各记一条', state.history.length, historyBeforeRedraw + 1);

// 挑出来的 10 张不能有重复
eq('一次抽牌不出现重复牌', state.result.drawnIds.length,
  state.result.drawnIds.filter(function (id, i) {
    return state.result.drawnIds.indexOf(id) === i;
  }).length);

// 换牌库
var majorChip = $('deckOptions').children[1];
majorChip.fire('click');
eq('切到只用大阿卡纳', state.deckKey, 'major');
pickThroughUI();
check('大阿卡纳模式下抽到的都是大牌', state.result.cards.every(function (item) {
  return item.card.suit === 'major';
}));

// 切回完整牌库，避免影响后面的断言
$('deckOptions').children[0].fire('click');
eq('切回完整牌库', state.deckKey, 'full');

/* ================================================================== *
 * 3. 牌义弹窗与正逆位翻转
 * ================================================================== */

section('牌义弹窗与翻转');

var firstSlot = $('tableSurface').children[0];
firstSlot.fire('click');

check('弹窗被打开', $('cardModal').hidden === false);
check('弹窗标题含牌位名', textOf($('cardModalTitle')).indexOf('现状') >= 0, textOf($('cardModalTitle')));
check('弹窗内容含牌名', textOf($('cardModalBody')).indexOf(state.result.cards[0].card.name) >= 0);
check('弹窗给出当前朝向的牌义', textOf($('cardModalBody')).indexOf('当前朝向') >= 0);
check('弹窗同时给出另一朝向', textOf($('cardModalBody')).indexOf('另一种朝向') >= 0);

var beforeOrientation = state.result.cards[0].orientation;
var beforeText = state.result.cards[0].meaning.text;

$('btnFlipCard').fire('click');

var afterOrientation = state.result.cards[0].orientation;
check('朝向被翻转', afterOrientation !== beforeOrientation,
  beforeOrientation + ' → ' + afterOrientation);
check('牌义随朝向一起更新', state.result.cards[0].meaning.text !== beforeText);
check('朝向与 reversed 字段保持一致',
  (state.result.cards[0].orientation === '逆位') === state.result.cards[0].reversed);
check('翻转后弹窗关闭', $('cardModal').hidden === true);
check('翻转后重新渲染了牌桌', $('tableSurface').children.length === 10);

/* ================================================================== *
 * 4. 未配置接口时的解读入口
 * ================================================================== */

section('未配置接口时的行为');

// 清空配置
state.settings.baseUrl = '';
state.settings.model = '';
Render.clear($('readingBody'));

// 走完整流程拿到一个结果（点是「占位区给出的按钮」需要先有牌面）
pickThroughUI();

var generateButton = $('readingBody').findAll(function (node) {
  return node.tagName === 'BUTTON';
})[0];
check('占位区给出按钮', Boolean(generateButton));
check('未配置时按钮提示去配置', textOf(generateButton).indexOf('去配置') >= 0,
  textOf(generateButton));

generateButton.fire('click');
check('点击后打开设置弹窗', $('settingsModal').hidden === false);
check('设置弹窗列出了服务预设', $('providerSelect').children.length === Tarot.LLM.providers.length);
check('设置弹窗填入了当前地址', $('baseUrl').value === '');
check('预设说明有内容', textOf($('providerNote')).length > 4);

/* ================================================================== *
 * 5. 保存配置与连通性测试的错误路径
 * ================================================================== */

section('配置保存与错误提示');

$('providerSelect').value = 'ollama';
$('providerSelect').fire('change');
eq('选预设会填入地址', $('baseUrl').value, 'http://localhost:11434/v1');
eq('选预设会填入模型名', $('model').value, 'qwen2.5:7b');

$('apiKey').value = '';
$('temperature').value = '1.2';
$('btnSaveSettings').fire('click');

eq('配置已保存到状态', state.settings.baseUrl, 'http://localhost:11434/v1');
eq('模型名已保存', state.settings.model, 'qwen2.5:7b');
eq('温度已保存', state.settings.temperature, 1.2);
check('保存后关闭弹窗', $('settingsModal').hidden === true);

// 温度越界要被夹住
$('btnSettings').fire('click');
$('temperature').value = '99';
$('btnSaveSettings').fire('click');
eq('温度上限被夹到 1.5', state.settings.temperature, 1.5);

$('btnSettings').fire('click');
$('temperature').value = 'abc';
$('btnSaveSettings').fire('click');
eq('温度非法时回落到默认 0.8', state.settings.temperature, 0.8);

// 按钮震动开关：默认开，关掉要能存下来，再打开设置时状态要对得上
check('震动默认开着', state.settings.haptic === true);
$('btnSettings').fire('click');
check('打开设置时震动开关是勾上的', $('hapticToggle').checked === true);
$('hapticToggle').checked = false;
$('btnSaveSettings').fire('click');
eq('关掉震动后存成 false', state.settings.haptic, false);
$('btnSettings').fire('click');
check('再打开设置时开关保持关着', $('hapticToggle').checked === false);
$('hapticToggle').checked = true;
$('btnSaveSettings').fire('click');
eq('重新勾上后存成 true', state.settings.haptic, true);

// 连通性测试的失败路径放在文件末尾的异步段里验证（它要等 fetch 的 Promise 落地）。

/* ================================================================== *
 * 6. 历史记录面板
 * ================================================================== */

section('历史记录面板');

var historyCount = state.history.length;
check('已有历史记录可供展示', historyCount >= 2);

$('btnHistory').fire('click');
check('历史弹窗被打开', $('historyModal').hidden === false);
eq('历史列表渲染出 ' + historyCount + ' 条', $('historyList').children.length, historyCount);

var firstRecord = $('historyList').children[0];
check('历史条目含问题', textOf(firstRecord).length > 10);
check('历史条目含牌名', textOf(firstRecord).indexOf(state.history[0].cards[0].cardName) >= 0,
  textOf(firstRecord).slice(0, 120));

// 重新载入一条历史
var restoreButton = firstRecord.findAll(function (node) {
  return node.tagName === 'BUTTON' && node.textContent.indexOf('重新载入') >= 0;
})[0];
check('历史条目有载入按钮', Boolean(restoreButton));
restoreButton.fire('click');

check('载入后关闭历史弹窗', $('historyModal').hidden === true);
eq('载入后牌数与记录一致', state.result.cards.length, state.history[0].cards.length);
eq('载入后问题回到输入框', $('question').value, state.history[0].question);
check('载入后旧解读被清空', state.payload === null);
check('载入后重新渲染了牌桌', $('tableSurface').children.length === state.result.cards.length);

/*
 * 记录里的牌在牌库里找不到时，要给用户一句话，而不是静默失败。
 *
 * 这种脏记录确实会出现：改过牌库 id、手工编辑过 localStorage、旧版本写的。
 * 以前这种情况会抛 TypeError 并**从点击事件处理器里逃出去**——用户看到的
 * 是「点了按钮没反应」：弹窗不关、没有提示、桌面也没变。
 *
 * 注意断言的是「有提示且状态没被弄坏」，不只是「不抛异常」——
 * 静默吞掉异常同样不可接受。
 */
(function () {
  var goodRecord = state.history[0];
  var broken = JSON.parse(JSON.stringify(goodRecord));
  broken.cards[0].cardId = 'major-999-not-a-real-card';

  var beforeResult = state.result;
  var toastNode = $('toast');
  var toastBefore = textOf(toastNode);

  // 直接把坏记录喂给载入路径：包一层 catch，异常逃出来这里就能发现
  var threw = false;
  try {
    Tarot.App.restoreRecord(broken);
  } catch (e) {
    threw = true;
  }

  check('坏记录不会让异常逃出事件处理器', threw === false,
    threw ? '异常逃出来了，用户会看到按钮没反应' : '');
  check('坏记录给出了提示', textOf(toastNode) !== toastBefore,
    'toast 没变：' + textOf(toastNode).slice(0, 80));
  check('坏记录的提示说清是牌找不到',
    /找不到|载入失败/.test(textOf(toastNode)),
    textOf(toastNode).slice(0, 100));
  check('坏记录不会把桌面上的牌弄坏', state.result === beforeResult,
    'state.result 被换掉了');
})();

// 删除一条
$('btnHistory').fire('click');
var deleteButton = $('historyList').children[0].findAll(function (node) {
  return node.tagName === 'BUTTON' && node.textContent.indexOf('删除') >= 0;
})[0];
check('历史条目有删除按钮', Boolean(deleteButton));
var beforeDelete = state.history.length;
deleteButton.fire('click');
eq('删除一条后历史减一', state.history.length, beforeDelete - 1);

/* ================================================================== *
 * 7. 渲染完整解读（不联网，直接喂结果）
 * ================================================================== */

section('完整解读渲染');

var readingResult = drawAuto({ spreadKey: 'three-choice', question: '渲染联动测试' });
state.result = readingResult;
state.payload = null;

// 造一份真实形状的解读：引文第一条正确、第二条编造
var payload = {
  reading: {
    // 新结构：verdict 是「直接回答」，不再有 primer / overview / synthesis / watchOut
    verdict: '整体看，这件事的关键在于你先确认条件，再决定要不要接受。',
    cards: readingResult.cards.map(function (item, i) {
      return {
        index: i + 1,
        position: item.position.title,
        quote: i === 1 ? '这句牌义原文里根本不存在，是模型编的' : item.meaning.text.slice(1, 18),
        gist: '第 ' + (i + 1) + ' 张牌的一句话摘要。',
        reading: '第 ' + (i + 1) + ' 个牌位的解读正文。',
        quoteOk: i !== 1,
        orientation: item.orientation,
        cardName: item.card.name
      };
    }),
    actions: ['先确认预算', '列出底线', '给自己三天']
  },
  quoteStats: { ok: 2, total: 3 },
  issues: ['第 2 个牌位（行动）的引文未通过核对'],
  usage: { total_tokens: 2048 }
};

state.payload = payload;

// 通过正常路径重渲染（改牌库 key 触发 render()）
$('deckOptions').children[1].fire('click');
$('deckOptions').children[0].fire('click');

var readingText = textOf($('readingBody'));
check('渲染出结论', readingText.indexOf('关键在于你先确认条件') >= 0);
check('渲染出行动清单', readingText.indexOf('先确认预算') >= 0);
check('渲染出每张牌的一句话摘要', readingText.indexOf('第 1 张牌的一句话摘要') >= 0);
check('渲染出引文核对比例', readingText.indexOf('引文核对 2/3') >= 0, readingText.slice(0, 100));
check('渲染出校验问题', readingText.indexOf('校验时发现 1 处问题') >= 0);
check('渲染出用量', readingText.indexOf('2048') >= 0);
check('解读标题变为完成', textOf($('readingSub')).indexOf('解读完成') >= 0, textOf($('readingSub')));

/*
 * 牌位块现在是 <details>，所以按 tagName 找。
 *
 * className 精确匹配在这里不再适用——每个 <details> 还带 is-open 之类的类。
 */
var readingCards = $('readingBody').findAll(function (node) {
  return node.tagName === 'DETAILS' && node.className.indexOf('card-reading') >= 0;
});
eq('渲染出 3 个牌位解读块', readingCards.length, 3);
check('第一个牌位标为已核对', textOf(readingCards[0]).indexOf('已核对') >= 0);
check('第二个牌位标为未通过', textOf(readingCards[1]).indexOf('未通过核对') >= 0);
check('每个牌位都显示牌名', readingCards.every(function (node, i) {
  return textOf(node).indexOf(readingResult.cards[i].card.name) >= 0;
}));

// 导出（不触发真实下载，只验证文本生成路径没坏）
var exportText = App.buildExportText(readingResult, payload);
check('导出文本含解读正文', exportText.indexOf('整体看') >= 0);
check('导出文本标出未通过核对的引文', exportText.indexOf('（未通过核对）') >= 0);
check('导出文本含用量之外的完整结构', exportText.indexOf('可以去做的事') >= 0);

/* ================================================================== *
 * 8. 异步段：真正走一次「点生成解读」的全流程
 *
 * 前面几节都是同步断言，这里换成真跑 Promise 链：
 * 起一个本地 mock 接口，把 fetch 换掉，然后点按钮、等状态变化。
 * 这一段覆盖的是 app.js 里最容易出错的异步部分——busy 标志、
 * 加载态、成功后的渲染、失败后的错误提示。
 * ================================================================== */

var http = require('http');

function startMock(handler) {
  return new Promise(function (resolve) {
    var server = http.createServer(handler);
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, port: server.address().port });
    });
  });
}

/** 等一小段时间，让 Promise 链跑完 */
function settle() {
  return new Promise(function (resolve) { setTimeout(resolve, 30); });
}

/* ---- 8.1 连通性测试的失败路径 ---- */

function testConnectionFailure() {
  section('连通性测试失败路径');

  // 临时把 fetch 换成直接拒绝，模拟地址不可达
  globalThis.fetch = function () {
    return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:9'));
  };

  $('btnSettings').fire('click');
  $('baseUrl').value = 'http://127.0.0.1:9/v1';
  $('model').value = 'no-such-model';
  $('btnTest').fire('click');

  eq('点击后先显示进行中', textOf($('testResult')), '正在测试…');

  return settle().then(function () {
    check('失败原因被显示出来', textOf($('testResult')).indexOf('✗') >= 0, textOf($('testResult')));
    check('不再停留在进行中', textOf($('testResult')).indexOf('正在测试') < 0);
    eq('失败时结果行带错误样式', $('testResult').className, 'test-result bad');
    // 换回真正的 fetch，后续要用它连本地 mock 服务
    globalThis.fetch = REAL_FETCH;
    $('settingsModal').hidden = true;
  });
}

/* ---- 8.2 生成解读：成功路径 ---- */

function testGenerateSuccess() {
  section('生成解读 · 成功路径');

  // 换成 3 张的牌阵，方便断言
  state.spreadKey = 'three-choice';
  state.result = drawAuto({ spreadKey: 'three-choice', question: '生成流程测试' });
  /*
   * 输入框也要有值。
   *
   * generateReading 现在读的是输入框里的当前问题（改问题不用重新抽牌），
   * 所以只设 state.result.question 而不管输入框，请求里带的就是上一次
   * 测试残留的问题。两者在这里保持一致，才符合真实使用。
   */
  $('question').value = '生成流程测试';
  $('question').fire('input');
  state.payload = null;
  state.busy = false;

  /*
   * 造一条与这次牌面对应的历史记录。
   *
   * drawAuto 是测试用的直通函数，不走「点洗牌 → 挑牌」那条 UI 路径，
   * 所以它不会触发 saveHistoryRecord。真实使用里抽完牌就会有一条记录，
   * 下面要验「解读回填进记录、载入时能恢复」，就得先把那条记录补上。
   * 字段与 saveHistoryRecord 写的保持一致。
   */
  state.history.unshift({
    id: state.result.id,
    at: state.result.at,
    question: state.result.question,
    spreadKey: state.result.spreadKey,
    spreadName: state.result.spreadName,
    deckKey: state.result.deckKey,
    deckLabel: state.result.deckLabel,
    reading: null,
    cards: state.result.cards.map(function (item) {
      return {
        cardId: item.cardId,
        cardName: item.card.name,
        reversed: item.reversed,
        orientation: item.orientation,
        positionTitle: item.position.title
      };
    })
  });

  var server = null;
  var received = null;
  var receivedHeaders = null;

  return startMock(function (req, res) {
    var body = '';
    receivedHeaders = req.headers;
    req.on('data', function (chunk) { body += chunk; });
    req.on('end', function () {
      received = JSON.parse(body);
      // mock 返回**新结构**（verdict / cards+[gist] / actions），
      // 也就是当前 prompt 实际要求的形状——这条链路测的是用户会走的路径。
      var reading = {
        verdict: '这是结论。',
        cards: state.result.cards.map(function (item, i) {
          return {
            index: i + 1,
            position: item.position.title,
            quote: item.meaning.text.slice(2, 20),
            gist: '第 ' + (i + 1) + ' 张牌的一句话摘要。',
            reading: '第 ' + (i + 1) + ' 个牌位的解读。'
          };
        }),
        actions: ['行动甲', '行动乙', '行动丙']
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(reading) } }],
        usage: { total_tokens: 999 }
      }));
    });
  }).then(function (mock) {
    server = mock.server;
    state.settings.baseUrl = 'http://127.0.0.1:' + mock.port + '/v1';
    state.settings.model = 'mock-model';
    state.settings.apiKey = 'sk-ui-test';

    // 先渲染出「待生成」占位区，再找按钮点它——走的是真实用户路径。
    // 注意必须在这一步之前把配置写好：占位区是按「有没有配置」渲染的，
    // 未配置时它给的按钮是「去配置接口」，点了只会打开设置弹窗。
    App.render();

    var generateButton = $('readingBody').findAll(function (node) {
      return node.tagName === 'BUTTON' && textOf(node).indexOf('生成 AI 解读') >= 0;
    })[0];
    check('找得到「生成 AI 解读」按钮', Boolean(generateButton));

    generateButton.fire('click');

    check('点击后进入忙碌状态', state.busy === true);
    check('抽牌按钮被禁用', $('btnDraw').disabled === true);
    check('显示加载提示', textOf($('readingBody')).indexOf('正在解读这 3 张牌') >= 0,
      textOf($('readingBody')).slice(0, 80));
    check('解读标题显示进行中', textOf($('readingSub')).indexOf('正在解读') >= 0);

    return settle().then(function () {
      check('请求带上了解读所需内容', Boolean(received) &&
        received.messages[1].content.indexOf('生成流程测试') >= 0);
      eq('请求带上了 Authorization', receivedHeaders.authorization, 'Bearer sk-ui-test');
      eq('请求带上了模型名', received.model, 'mock-model');
      check('请求里包含抽到的牌名', received.messages[1].content.indexOf(
        state.result.cards[0].card.name) >= 0);

      eq('忙碌状态已解除', state.busy, false);
      check('解读结果已存下', state.payload !== null);
      eq('引文核对 3/3', state.payload.quoteStats.ok, 3);
      eq('没有校验问题', state.payload.issues.length, 0);

      /*
       * 解读要回填进对应的历史记录。
       *
       * 这是「关掉页面就没了」这个问题的直接防线：用户花的是真金白银的
       * token，一次凯尔特十字要一千多个，结果只活在一次会话里说不过去。
       */
      var savedRecord = state.history[0];
      check('解读被回填进历史记录', Boolean(savedRecord && savedRecord.reading),
        'history[0].reading = ' + JSON.stringify(savedRecord && savedRecord.reading));
      check('存下来的解读带结论',
        Boolean(savedRecord && savedRecord.reading) &&
        savedRecord.reading.reading.verdict === '这是结论。');
      check('存下来的解读带行动清单',
        Boolean(savedRecord && savedRecord.reading) &&
        savedRecord.reading.reading.actions.length === 3);
      check('存下来的解读不包含原始响应文本',
        Boolean(savedRecord && savedRecord.reading) &&
        savedRecord.reading.raw === undefined);

      check('抽牌按钮恢复可用', $('btnDraw').disabled === false);
      check('解读标题变为完成', textOf($('readingSub')).indexOf('解读完成') >= 0);

      var shown = textOf($('readingBody'));
      check('页面显示结论', shown.indexOf('这是结论。') >= 0);
      check('页面显示行动清单', shown.indexOf('行动甲') >= 0);
      check('页面显示每张牌的一句话摘要', shown.indexOf('第 1 张牌的一句话摘要') >= 0);
      check('页面显示核对通过', shown.indexOf('引文核对 3/3') >= 0);
      check('页面显示用量', shown.indexOf('999') >= 0);
      check('成功时没有错误框', $('readingBody').findAll(function (n) {
        return n.className === 'reading-error';
      }).length === 0);

      // 换一张牌的朝向后，旧的解读必须作废
      var slot = $('tableSurface').children[0];
      var hadPayload = state.payload !== null;
      check('翻转前有解读结果', hadPayload);
      slot.fire('click');
      $('btnFlipCard').fire('click');
      check('翻转朝向后旧解读被作废', state.payload === null);
      check('翻转朝向后回到待生成状态',
        textOf($('readingBody')).indexOf('让模型来读') >= 0);

      /*
       * 改过问题之后再生成，请求里必须是新问题。
       *
       * 这里守的是一个很具体的用户动作：抽完牌、看到牌面，才想起要把问题
       * 改得更具体。以前 generateReading 读的是 state.result.question
       * （抽牌那一刻的快照），改了输入框等于没改——用户看到的就是「我明明
       * 改了，它装没看见」。
       *
       * 借翻转作废之后的「待生成」状态来测，不用额外造状态。
       */
      received = null;
      $('question').value = '改过之后的新问题';
      $('question').fire('input');

      var again = $('readingBody').findAll(function (node) {
        return node.tagName === 'BUTTON' && textOf(node).indexOf('生成 AI 解读') >= 0;
      })[0];
      check('作废之后又能找到生成按钮', Boolean(again));
      again.fire('click');

      return settle().then(function () {
        check('重新生成时请求带上了改过的问题', Boolean(received) &&
          received.messages[1].content.indexOf('改过之后的新问题') >= 0,
          received ? received.messages[1].content.slice(0, 160) : '（服务端没收到请求）');
        check('重新生成时没有沿用抽牌那一刻的旧问题', Boolean(received) &&
          received.messages[1].content.indexOf('生成流程测试') < 0);

        /*
         * 从历史记录重新载入这副牌，刚存下的那份解读要一起回来。
         *
         * 用户的实际处境：看到解读、关掉页面（或者转身抽了别的牌），过两天
         * 想回头翻——以前这时候什么都翻不到，只能再花一次 token 重新问。
         */
        check('要载入的那条记录里有解读',
          Boolean(state.history[0] && state.history[0].reading));

        state.payload = null; // 模拟「页面重开过，内存里什么都没有」
        $('btnHistory').fire('click');

        var firstItem = $('historyList').children[0];
        check('历史条目里标出了「含解读」',
          textOf(firstItem).indexOf('含解读') >= 0, textOf(firstItem).slice(0, 140));

        var reloadButton = firstItem.findAll(function (node) {
          return node.tagName === 'BUTTON' && textOf(node).indexOf('重新载入') >= 0;
        })[0];
        check('历史条目有载入按钮', Boolean(reloadButton));
        reloadButton.fire('click');

        check('载入后解读从记录里恢复了', state.payload !== null);
        check('恢复的解读和存下的一致',
          Boolean(state.payload) && state.payload.reading.verdict === '这是结论。');
        check('载入后直接显示解读，不用重新生成',
          textOf($('readingBody')).indexOf('这是结论。') >= 0,
          textOf($('readingBody')).slice(0, 100));

        server.close();
      });
    });
  });
}

/* ---- 8.4 解读进行中：牌面必须被锁住 ---- */

function testBusyLocksBoard() {
  section('解读进行中 · 牌面锁定');

  // 起一个故意慢回复的服务，好稳定地停在「解读中」这个状态上
  var pending = null;
  return startMock(function (req, res) {
    var body = '';
    req.on('data', function (chunk) { body += chunk; });
    req.on('end', function () { pending = { res: res, body: body }; });
  }).then(function (mock) {
    state.settings.baseUrl = 'http://127.0.0.1:' + mock.port + '/v1';
    state.settings.model = 'mock-model';
    state.settings.apiKey = 'sk-ui-test';
    state.result = drawAuto({ spreadKey: 'three-choice', question: '锁定测试' });
    state.bonus = [];
    state.payload = null;
    state.busy = false;
    state.bonusStep = 1;
    App.render();

    var generateButton = $('readingBody').findAll(function (node) {
      return node.tagName === 'BUTTON' && textOf(node).indexOf('生成 AI 解读') >= 0;
    })[0];
    check('找得到生成按钮', Boolean(generateButton));
    generateButton.fire('click');

    eq('处于忙碌状态', state.busy, true);
    check('追加牌按钮被禁用', $('btnDrawBonus').disabled === true);
    check('张数加号被禁用', $('btnBonusPlus').disabled === true);
    check('张数减号被禁用', $('btnBonusMinus').disabled === true);
    check('抽牌按钮被禁用', $('btnDraw').disabled === true);

    var bonusBefore = state.bonus.length;
    $('btnDrawBonus').fire('click');
    eq('忙碌期间点追加牌没有生效', state.bonus.length, bonusBefore);

    return settle().then(function () {
      check('服务端确实收到了请求', Boolean(pending));
      var reading = {
        overview: '锁定测试总览。',
        cards: state.result.cards.map(function (item, i) {
          return {
            index: i + 1, position: item.position.title,
            quote: item.meaning.text.slice(2, 18),
            reading: '第 ' + (i + 1) + ' 段。', action: '行动 ' + (i + 1)
          };
        }),
        synthesis: '综合。', actions: ['a', 'b', 'c'], watchOut: '不确定之处。'
      };
      pending.res.writeHead(200, { 'Content-Type': 'application/json' });
      pending.res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(reading) } }]
      }));

      return settle().then(function () {
        eq('忙碌状态已解除', state.busy, false);
        check('解读正常落地', state.payload !== null);
        check('落地后追加牌按钮恢复可用', $('btnDrawBonus').disabled === false);
        eq('牌面没有被偷偷改掉', state.bonus.length, 0);
        eq('牌桌张数仍是 3', $('tableSurface').children.length, 3);
        mock.server.close();
      });
    });
  });
}

/* ---- 8.5 解读期间改了牌面 → 结果必须作废 ---- */

function testStaleReadingDiscarded() {
  section('解读期间改牌面 · 结果作废');

  var pending = null;
  return startMock(function (req, res) {
    var body = '';
    req.on('data', function (chunk) { body += chunk; });
    req.on('end', function () { pending = { res: res, body: body }; });
  }).then(function (mock) {
    state.settings.baseUrl = 'http://127.0.0.1:' + mock.port + '/v1';
    state.settings.model = 'mock-model';
    state.result = drawAuto({ spreadKey: 'three-choice', question: '作废测试' });
    state.bonus = [];
    state.payload = null;
    state.busy = false;
    App.render();

    var generateButton = $('readingBody').findAll(function (node) {
      return node.tagName === 'BUTTON' && textOf(node).indexOf('生成 AI 解读') >= 0;
    })[0];
    generateButton.fire('click');
    eq('处于忙碌状态', state.busy, true);

    var staleReading = {
      overview: '这份解读是针对旧牌面的，不应该被显示。',
      cards: state.result.cards.map(function (item, i) {
        return {
          index: i + 1, position: item.position.title,
          quote: item.meaning.text.slice(2, 18),
          reading: '过期解读第 ' + (i + 1) + ' 段。', action: 'x'
        };
      }),
      synthesis: '综合。', actions: ['a', 'b', 'c'], watchOut: '不确定。'
    };

    // 绕过被禁用的按钮，直接改状态来模拟「解读期间牌面变了」，
    // 检验的是回调里的指纹比对有没有生效
    state.bonus = state.bonus.concat(Tarot.Engine.extraCards(state.result, 1));
    check('牌面确实变了', state.bonus.length === 1);

    return settle().then(function () {
      pending.res.writeHead(200, { 'Content-Type': 'application/json' });
      pending.res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(staleReading) } }]
      }));

      return settle().then(function () {
        eq('忙碌状态已解除', state.busy, false);
        check('过期解读被丢弃', state.payload === null);
        check('页面上没有出现过期解读',
          textOf($('readingBody')).indexOf('不应该被显示') < 0,
          textOf($('readingBody')).slice(0, 80));
        check('回到待生成状态', textOf($('readingBody')).indexOf('让模型来读') >= 0);
        eq('牌面保留了追加的那张', state.bonus.length, 1);
        mock.server.close();
      });
    });
  });
}

/* ---- 8.6 失败路径 ---- */

function testGenerateFailure() {

  section('生成解读 · 失败路径');

  return startMock(function (req, res) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Authentication Fails' } }));
  }).then(function (mock) {
    state.settings.baseUrl = 'http://127.0.0.1:' + mock.port + '/v1';
    state.settings.model = 'mock-model';
    state.settings.apiKey = 'wrong-key';
    state.payload = null;
    state.busy = false;

    App.render();

    var generateButton = $('readingBody').findAll(function (node) {
      return node.tagName === 'BUTTON' && textOf(node).indexOf('生成 AI 解读') >= 0;
    })[0];
    check('失败路径也找得到生成按钮', Boolean(generateButton));
    generateButton.fire('click');
    check('失败路径也先进忙碌状态', state.busy === true);

    return settle().then(function () {
      eq('忙碌状态已解除', state.busy, false);
      check('显示错误框', $('readingBody').findAll(function (n) {
        return n.className === 'reading-error';
      }).length === 1);
      check('错误信息含 401 提示', textOf($('readingBody')).indexOf('401') >= 0,
        textOf($('readingBody')).slice(0, 120));
      check('错误信息提示检查 Key', textOf($('readingBody')).indexOf('API Key') >= 0);
      check('错误框提供重试按钮', $('readingBody').findAll(function (n) {
        return n.tagName === 'BUTTON' && textOf(n).indexOf('重试') >= 0;
      }).length === 1);
      check('失败后抽牌按钮恢复可用', $('btnDraw').disabled === false);
      check('失败后不留下解读结果', state.payload === null);
      check('解读标题显示失败', textOf($('readingSub')).indexOf('解读失败') >= 0);

      mock.server.close();
    });
  });
}

/* ---- 8.4 汇总 ---- */

/*
 * 断言数基线。
 *
 * 这个文件里有多处 `if (xxx) { ...若干条断言... }` 的守卫块，
 * 条件不成立时整块被跳过，而套件仍然打印「全部通过」——只是断言数悄悄变少。
 * 本项目在 verify-browser.js 里踩过这个坑：8 条断言静默失效，
 * 是靠「测试数怎么没变」才发现的。
 *
 * 所以最后核对一次总数。**加了新断言就把这个数改大**；
 * 它变小，就说明有东西被跳过了。
 */
var MIN_EXPECTED_ASSERTIONS = 201;

function summarize() {
  if (passed < MIN_EXPECTED_ASSERTIONS) {
    failures.push({
      group: '断言数基线',
      label: '断言数不足',
      detail: '只跑了 ' + passed + ' 项，基线是 ' + MIN_EXPECTED_ASSERTIONS +
        ' 项。多半是某个 if 守卫没成立、整块断言被跳过了。'
    });
  }

  console.log('\n' + '='.repeat(64));
  if (failures.length === 0) {
    console.log('全部通过：' + passed + ' 项断言');
    console.log('='.repeat(64));
    process.exit(0);
  }
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项：');
  failures.forEach(function (item) {
    console.log('  [' + item.group + '] ' + item.label + (item.detail ? '  → ' + item.detail : ''));
  });
  console.log('='.repeat(64));
  process.exit(1);
}

testConnectionFailure()
  .then(testGenerateSuccess)
  .then(testBusyLocksBoard)
  .then(testStaleReadingDiscarded)
  .then(testGenerateFailure)
  .then(summarize)
  .catch(function (error) {
    console.error('\n冒烟测试自身出错：', error && error.stack ? error.stack : error);
    process.exit(2);
  });
