/*
 * preview.js —— 生成一张静态预览页，把 6 种牌阵全部渲染出来
 *
 *     node preview.js
 *
 * 出来的 preview.html 和真实页面共用同一套 CSS、同一套渲染函数（render.js），
 * 只是不需要点按钮。用途是**用眼睛检查版面**：牌有没有叠在一起、牌位名会不会
 * 被裁掉、10 张牌的凯尔特十字会不会溢出。
 *
 * 这些是 automated 测试查不出来的——我能算出「牌的矩形在桌面范围内」，
 * 但算不出「看起来挤不挤」。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var domino = require(path.join(__dirname, '.domtest', 'package', 'lib', 'index.js'));

var ROOT = __dirname;

// 建一个干净的 DOM，只加载到 render.js（不需要 app.js 的交互）
var html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
  '<div id="tableSurface"></div><div id="tableFoot"></div>' +
  '<div id="readingBody"></div><div id="spreadList"></div><div id="deckOptions"></div>' +
  '</body></html>';

var window = domino.createWindow(html);
window.crypto = require('crypto').webcrypto;
var context = vm.createContext(window);

['random.js', 'cards-major.js', 'cards-minor.js', 'cards.js', 'spreads.js', 'engine.js', 'render.js']
  .forEach(function (file) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', file), 'utf8'), context, { filename: file });
  });

var Tarot = window.Tarot;
var document = window.document;
var Render = Tarot.Render;

/**
 * 走完整的「洗牌 → 挑牌 → 收尾」流程，固定挑最左边那张。
 * 预览页只关心版面，所以挑哪张无关紧要，可复现更重要。
 */
function drawAuto(options) {
  var session = Tarot.Engine.prepareFan(options);
  for (var i = 0; i < session.needed; i++) {
    Tarot.Engine.takeFromFan(session, 0);
  }
  return Tarot.Engine.finalizeDraw(session);
}

function makeResult(spreadKey) {
  return drawAuto({
    spreadKey: spreadKey,
    question: '（预览用的示例问题）',
    deckKey: 'full'
  });
}

var blocks = [];

blocks.push('<!DOCTYPE html>');
blocks.push('<html lang="zh-CN"><head><meta charset="UTF-8">');
blocks.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
blocks.push('<title>塔罗牌阵预览</title>');
blocks.push('<link rel="stylesheet" href="styles.css">');
blocks.push('<style>');
blocks.push('  body { padding: 24px; }');
blocks.push('  .pv-section { margin-bottom: 44px; }');
blocks.push('  .pv-title { font-size: 18px; color: #e0c060; margin: 0 0 4px; font-weight: 600; }');
blocks.push('  .pv-sub { font-size: 13px; color: #9a9cb0; margin: 0 0 14px; }');
blocks.push('  .pv-meta { font-size: 12px; color: #6c6f85; margin: 10px 0 0; line-height: 1.7; }');
blocks.push('  .pv-note { background: #161927; border: 1px solid #2a2f45; border-left: 3px solid #c9a227;');
blocks.push('    border-radius: 8px; padding: 16px 20px; margin-bottom: 30px; font-size: 13.5px; line-height: 1.8; }');
// 尺寸对照表
blocks.push('  .pv-table { border-collapse: collapse; margin: 0 0 22px; font-size: 13px; min-width: 380px; }');
blocks.push('  .pv-table caption { text-align: left; font-weight: 600; color: #cfc6ff;');
blocks.push('    padding: 0 0 8px; font-size: 14px; }');
blocks.push('  .pv-table th { text-align: left; font-weight: 500; color: #9a9cb0;');
blocks.push('    padding: 5px 18px 5px 0; white-space: nowrap; vertical-align: top; }');
blocks.push('  .pv-table td { padding: 5px 0; color: #e8e6f0; }');
blocks.push('  .pv-table tr + tr th, .pv-table tr + tr td { border-top: 1px solid #1e2233; }');
blocks.push('  /* 预览页不需要入场动画，牌直接显示成最终状态 */');
blocks.push('  .card-front { animation: none !important; }');
blocks.push('  .card-back { animation: none !important; display: none !important; }');
/*
 * 逆位靠 .cf-inner 的静态 rotate(180deg) 生效，不带 animation，
 * 所以上面关掉动画不影响它——这里不再需要额外覆盖。
 * （这里曾经写 `.is-reversed .card-flip { transform: rotate(180deg) }`，
 *   那是旧做法：转整张牌，而且和 .cf-inner 叠加成 360° 等于没转。）
 */
blocks.push('</style>');
blocks.push('</head><body>');
blocks.push('<div class="pv-note">');
blocks.push('  <strong>静态预览页</strong>——由 <code>node preview.js</code> 生成，用的是和真实页面');
blocks.push('  完全相同的样式与渲染代码，只是省掉了点击抽牌那一步。');
blocks.push('  用途是检查版面：牌有没有互相重叠、牌位名会不会被裁掉、大牌阵会不会溢出。<br>');
blocks.push('  真实页面的抽牌动画、翻转效果、AI 解读请求都不在这里。');
blocks.push('</div>');

var totalCards = 0;

Tarot.Spreads.all.forEach(function (spread) {
  var result = makeResult(spread.key);
  totalCards += result.cards.length;

  var surface = document.getElementById('tableSurface');
  var foot = document.getElementById('tableFoot');

  Render.renderTable(surface, result, { onCardClick: function () {} });
  Render.renderTableFoot(foot, result);

  var size = Render.tableSize(result);

  blocks.push('<div class="pv-section">');
  blocks.push('  <h2 class="pv-title">' + spread.name + '</h2>');
  blocks.push('  <p class="pv-sub">' + spread.subtitle + ' · ' + spread.positions.length +
    ' 张牌 · 桌面 ' + size.width + '×' + size.height + 'px</p>');
  blocks.push('  <div class="table-wrap">' + surface.innerHTML + '</div>');
  blocks.push('  <p class="pv-meta">' + foot.innerHTML + '</p>');
  blocks.push('</div>');

  // 清空复用
  surface.innerHTML = '';
  foot.innerHTML = '';
});

blocks.push('<p class="pv-meta">共渲染 ' + Tarot.Spreads.all.length + ' 种牌阵、' +
  totalCards + ' 个牌位。牌义库共 ' + Tarot.Cards.deck.length + ' 张。</p>');

/* ------------------------------------------------------------------ *
 * 补充牌的版面
 * ------------------------------------------------------------------ */

blocks.push('<h2 class="pv-title" style="margin-top:56px">补充牌（追加抽牌）</h2>');
blocks.push('<p class="pv-sub">抽完牌之后可以再补抽几张，它们排在牌阵下方，' +
  '金色边框并标着「补充」。</p>');

[[1, 'single'], [3, 'three-time'], [7, 'three-choice'], [12, 'cross-five']].forEach(function (pair) {
  var extraCount = pair[0];
  var spreadKey = pair[1];

  var base = drawAuto({ spreadKey: spreadKey, question: '（预览）' });
  var extras = Tarot.Engine.extraCards(base, extraCount);
  var view = Tarot.Render.mergeBonus(base, extras);

  var surface = document.getElementById('tableSurface');
  var foot = document.getElementById('tableFoot');
  Tarot.Render.renderTable(surface, view, { onCardClick: function () {} });
  Tarot.Render.renderTableFoot(foot, view);

  var size = Tarot.Render.tableSize(view);

  blocks.push('<div class="pv-section">');
  blocks.push('  <h3 class="pv-title" style="font-size:15px">' +
    Tarot.Spreads.get(spreadKey).name + ' + 补充 ' + extraCount + ' 张</h3>');
  blocks.push('  <p class="pv-sub">共 ' + view.cards.length + ' 张 · 桌面 ' +
    size.width + '×' + size.height + 'px</p>');
  blocks.push('  <div class="table-wrap">' + surface.innerHTML + '</div>');
  blocks.push('  <p class="pv-meta">' + foot.innerHTML + '</p>');
  blocks.push('</div>');

  surface.innerHTML = '';
  foot.innerHTML = '';
});

blocks.push('</body></html>');

/* ------------------------------------------------------------------ *
 * 待挑牌区
 * ------------------------------------------------------------------ */

blocks.push('<h2 class="pv-title" style="margin-top:56px">自己挑牌</h2>');
blocks.push('<p class="pv-sub">洗牌之后整副牌背面朝上按网格排开，由用户自己点选。' +
  '每张完整可见、互不压盖——曾经是重叠的扇形，手机上分不清哪张是哪张，改掉了。</p>');

[78, 22, 5].forEach(function (cardCount) {
  var layout = Tarot.Render.fanLayout(cardCount);

  blocks.push('<div class="pv-section">');
  blocks.push('  <h3 class="pv-title" style="font-size:15px">' +
    (cardCount === 78 ? '完整牌库' : '只用大阿卡纳') + ' · ' + cardCount + ' 张</h3>');
  blocks.push('  <p class="pv-sub">' + layout.rows + ' 行 · 区域 ' +
    layout.width + '×' + layout.height + 'px</p>');
  blocks.push('  <div class="fan-wrap"><div class="fan-surface" style="width:' +
    layout.width + 'px;height:' + layout.height + 'px">');

  layout.positions.forEach(function (p) {
    blocks.push('    <div class="fan-card" style="left:' + Math.round(p.left) +
      'px;top:' + Math.round(p.top) + 'px;z-index:' + (p.index + 1) +
      ';--rot:' + p.rotate.toFixed(2) + 'deg">' +
      '<div class="fan-back"><span class="fan-glyph">✦</span></div></div>');
  });

  blocks.push('  </div></div>');
  blocks.push('</div>');
});

/*
 * 手机视口预览。
 *
 * 上面那些版面都是按桌面尺寸渲染的（900px 基准宽）。手机上尺寸完全不同——
 * 牌从 104px 缩到 56px、待挑牌一行从 11 张变成 5 张、牌阵间距也跟着变。
 * 所以这里把每种视口的尺寸**现算一遍**并把关键数字列出来，
 * 让你不用掏出手机就能看出哪一档不合理。
 *
 * 刻意不重画版面：要判断排版得在真机上滑，静态预览会骗人。
 * 所以只给数字，数字来自 render.js 的 computeMetrics，不是另抄一份。
 */
blocks.push('<div class="pv-section">');
blocks.push('  <h2>手机 / 平板 / 桌面：尺寸对照</h2>');
blocks.push('  <p class="pv-note">下面的数字由 render.js 的 computeMetrics 现算。' +
  '要看真实排版，请用手机打开 index.html。</p>');

[
  { label: '手机 360（常见安卓）', vw: 360, touch: true },
  { label: '手机 390（iPhone 14/15）', vw: 390, touch: true },
  { label: '手机 430（iPhone Pro Max）', vw: 430, touch: true },
  { label: '平板 768（iPad 竖屏）', vw: 768, touch: true },
  { label: '桌面 1280', vw: 1280, touch: false },
  { label: '桌面 1440', vw: 1440, touch: false }
].forEach(function (vp) {
  var m = Render.computeMetrics(vp.vw, vp.touch);
  Render.setViewportWidth(vp.vw, vp.touch);
  var fan78 = Render.fanLayout(78);
  var celtic = Render.tableSize(makeResult('celtic-cross'));

  blocks.push('  <table class="pv-table">');
  blocks.push('    <caption>' + vp.label + '</caption>');
  blocks.push('    <tr><th>牌面尺寸</th><td>' + m.cardW + ' × ' + m.cardH + ' px</td></tr>');
  blocks.push('    <tr><th>牌桌基准宽</th><td>' + m.baseWidth + ' px</td></tr>');
  blocks.push('    <tr><th>凯尔特十字桌面</th><td>' + celtic.width + ' × ' +
    celtic.height + ' px</td></tr>');
  blocks.push('    <tr><th>待挑牌尺寸</th><td>' + m.fanCardW + ' × ' + m.fanCardH +
    ' px' + (vp.touch ? '（触摸，需 ≥44）' : '') + '</td></tr>');
  blocks.push('    <tr><th>待挑牌一行几张</th><td>' + m.fanPerRow + ' 张</td></tr>');
  blocks.push('    <tr><th>78 张排几行</th><td>' + fan78.rows + ' 行，高 ' +
    Math.round(fan78.height) + ' px</td></tr>');
  blocks.push('    <tr><th>输入方式</th><td>' + (m.isTouch ? '触摸' : '鼠标') + '</td></tr>');
  blocks.push('  </table>');
});

blocks.push('</div>');

blocks.push('</body></html>');

var out = path.join(ROOT, 'preview.html');
fs.writeFileSync(out, blocks.join('\n'), 'utf8');

console.log('已生成: ' + out);
console.log('大小: ' + fs.statSync(out).size + ' 字节');
console.log('牌阵数: ' + Tarot.Spreads.all.length + '，牌位总数: ' + totalCards);
