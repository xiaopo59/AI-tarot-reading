/*
 * verify.js —— 核心链路验证
 *
 * 不需要联网、不需要装任何依赖，直接用 Node 跑：
 *
 *     node verify.js
 *
 * 覆盖三件事：
 *   1. 随机性——这是「完全随机」这个承诺的唯一凭据，必须用统计检验来证明，
 *      而不是靠代码看起来对不对。文件里跑的是真正的卡方检验。
 *   2. 引文核对——专门用拼接、改写、繁简、换词等手段试着骗过校验，
 *      确认骗不过去。这一段是整个 AI 解读可信度的地基。
 *   3. 返回解析与容错——模型返回带围栏、带前缀、缺字段、顺序错乱时，
 *      程序的行为是否符合预期（能救的救，不能救的明确报错）。
 */
'use strict';

var path = require('path');

var BASE = path.join(__dirname, 'js');
['random.js', 'cards-major.js', 'cards-minor.js', 'cards.js', 'spreads.js', 'engine.js',
  'llm.js', 'render.js']
  .forEach(function (file) { require(path.join(BASE, file)); });

var Tarot = globalThis.Tarot;
var Cards = Tarot.Cards;
var Spreads = Tarot.Spreads;
var Engine = Tarot.Engine;
var RNG = Tarot.RNG;
var LLM = Tarot.LLM;
var Render = Tarot.Render;

/* ================================================================== *
 * 迷你测试框架
 * ================================================================== */

var passed = 0;
var failures = [];
var group = '';

function section(name) {
  group = name;
  console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(0, 58 - name.length)));
}

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    return true;
  }
  failures.push({ group: group, label: label, detail: detail });
  console.log('  ✗ ' + label + (detail ? '  → ' + detail : ''));
  return false;
}

function eq(label, actual, expected, extra) {
  return check(label, actual === expected,
    '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) +
    (extra ? '（' + extra + '）' : ''));
}

function near(label, actual, expected, tolerance) {
  return check(label, Math.abs(actual - expected) <= tolerance,
    '期望 ' + expected + ' ±' + tolerance + '，实际 ' + actual);
}

function throws(label, fn, matcher) {
  try {
    fn();
  } catch (error) {
    if (!matcher) return check(label, true);
    return check(label, matcher.test(error.message), '错误信息为「' + error.message + '」');
  }
  return check(label, false, '本应抛错但没有');
}

/**
 * 测试用的抽牌助手：走完整的「洗牌 → 挑牌 → 收尾」流程。
 *
 * 真实用户是自己点扇形选位置的；测试里必须有个确定的挑法，
 * 否则无法复现。这里固定挑「第 0 个位置」（每次都挑扇形最左那张），
 * 随机性仍然全部来自 crypto——只是把「人选择哪个位置」这一步固定下来。
 *
 * @param {Object} options 与 prepareFan 的参数一致
 * @returns {Object} 收尾后的抽牌结果
 */
function drawAuto(options) {
  var session = Engine.prepareFan(options);
  for (var i = 0; i < session.needed; i++) {
    Engine.takeFromFan(session, 0);
  }
  return Engine.finalizeDraw(session);
}

/* ================================================================== *
 * 1. 牌库结构
 * ================================================================== */

section('牌库结构');

var cardCheck = Cards.validate();
check('78 张牌结构自检通过', cardCheck.ok, cardCheck.errors.slice(0, 6).join('；'));
eq('总数 78 张', cardCheck.stats.total, 78);
eq('大阿卡纳 22 张', cardCheck.stats.major, 22);
eq('小阿卡纳 56 张', cardCheck.stats.minor, 56);

/*
 * 大阿卡纳每张牌的符号必须唯一。
 *
 * 这个符号会印在牌面上。原来 08 力量 和 11 正义 都写 ⚖，翻到那两张就是
 * 两个天平——功能上没影响，但一眼就看得见，而且容易让人以为 08 跟「裁决」
 * 有关。符号不参与任何逻辑，所以只能在测试里钉住唯一性。
 *
 * 只管大阿卡纳：小阿卡纳的符号是花色共用的（同一花色的 14 张都印「杖」），
 * 那是设计，不是重复。
 */
var glyphOwner = {};
var glyphDup = [];
Cards.deck.forEach(function (card) {
  if (card.id.indexOf('major-') !== 0) return;
  if (glyphOwner[card.glyph]) {
    glyphDup.push(card.glyph + ' 被 ' + glyphOwner[card.glyph] + ' 和 ' + card.name + ' 同时使用');
  } else {
    glyphOwner[card.glyph] = card.name;
  }
});
check('大阿卡纳每张牌的符号都不重复', glyphDup.length === 0, glyphDup.join('；'));
eq('权杖 14 张', cardCheck.stats.bySuit.wands, 14);
eq('圣杯 14 张', cardCheck.stats.bySuit.cups, 14);
eq('宝剑 14 张', cardCheck.stats.bySuit.swords, 14);
eq('星币 14 张', cardCheck.stats.bySuit.pentacles, 14);

eq('按 id 取牌可用', Cards.get('major-00').name, '愚者');
eq('不存在的 id 返回 undefined', Cards.get('nope-99'), undefined);

var allIds = {};
var dupId = false;
Cards.deck.forEach(function (card) {
  if (allIds[card.id]) dupId = true;
  allIds[card.id] = true;
});
check('没有重复 id', !dupId);

var sameAdvice = Cards.deck.filter(function (card) { return card.up === card.rev; });
eq('没有正逆位牌义完全相同的牌', sameAdvice.length, 0);

var meaningUp = Cards.meaning(Cards.get('major-13'), false);
var meaningRev = Cards.meaning(Cards.get('major-13'), true);
check('正位取到正位牌义', meaningUp.text === Cards.get('major-13').up);
check('逆位取到逆位牌义', meaningRev.text === Cards.get('major-13').rev);
check('正逆位牌义不同', meaningUp.text !== meaningRev.text);

/* ================================================================== *
 * 2. 牌阵结构
 * ================================================================== */

section('牌阵结构');

var spreadCheck = Spreads.validate();
check('牌阵自检通过', spreadCheck.ok, spreadCheck.errors.join('；'));
eq('共 6 种牌阵', Spreads.all.length, 6);

var spreadKeys = Spreads.all.map(function (s) { return s.key; });
['single', 'three-time', 'three-choice', 'cross-five', 'relationship', 'celtic-cross']
  .forEach(function (key) {
    check('包含牌阵 ' + key, spreadKeys.indexOf(key) >= 0);
  });

eq('单张牌 1 个牌位', Spreads.get('single').positions.length, 1);
eq('三张牌 3 个牌位', Spreads.get('three-time').positions.length, 3);
eq('五张牌 5 个牌位', Spreads.get('cross-five').positions.length, 5);
eq('关系牌阵 6 个牌位', Spreads.get('relationship').positions.length, 6);
eq('凯尔特十字 10 个牌位', Spreads.get('celtic-cross').positions.length, 10);

var missingAsks = [];
Spreads.all.forEach(function (spread) {
  spread.positions.forEach(function (pos) {
    if (!pos.asks || pos.asks.length < 8) missingAsks.push(spread.key + '/' + pos.title);
  });
});
eq('每个牌位都有实质性的 asks', missingAsks.length, 0);

/*
 * 每行的牌位必须关于中线对称。
 *
 * 这一条抓的是一个很显眼、但只在多行牌阵上才暴露的问题：
 * 牌阵的 x 坐标是手写的，早先写成了 13/45/77 和 14/52 这种值——
 * 每行的中心分别落在 45、33，整副牌看着明显偏左。单张和三张牌阵
 * （22/50/78）本来就对称，所以一直没被发现。
 *
 * 判据是「每行最左与最右牌位的中点 = 50」。差的绝对值超过 0.5 个百分点
 * 就算歪——0.5 换算到 302px 的牌桌上约 1.5px，肉眼刚好能看出来。
 */
var asymmetric = [];
Spreads.all.forEach(function (spread) {
  var rows = {};
  spread.positions.forEach(function (pos) {
    var key = String(pos.y);
    if (!rows[key]) rows[key] = [];
    rows[key].push(pos.x);
  });

  Object.keys(rows).forEach(function (y) {
    var xs = rows[y];
    var lo = Math.min.apply(null, xs);
    var hi = Math.max.apply(null, xs);
    var center = (lo + hi) / 2;
    if (Math.abs(center - 50) > 0.5) {
      asymmetric.push(spread.name + ' 第 y=' + y + ' 行：中心 ' +
        center.toFixed(1) + '（应 50）');
    }
  });
});
eq('每个牌阵的每一行都关于中线对称', asymmetric.length, 0, asymmetric.join('；'));

// 左右边距也要相等——这是「对称」更直观的说法
Spreads.all.forEach(function (spread) {
  var rows = {};
  spread.positions.forEach(function (pos) {
    var key = String(pos.y);
    if (!rows[key]) rows[key] = [];
    rows[key].push(pos.x);
  });

  var worst = 0;
  Object.keys(rows).forEach(function (y) {
    var lo = Math.min.apply(null, rows[y]);
    var hi = Math.max.apply(null, rows[y]);
    worst = Math.max(worst, Math.abs(lo - (100 - hi)));
  });

  check(spread.name + '：各行左右边距相等（差 <1 百分点）', worst < 1,
    '最大差 ' + worst.toFixed(1) + ' 百分点');
});

/* ================================================================== *
 * 3. 抽牌规则
 * ================================================================== */

section('抽牌规则');

var draw = drawAuto({ spreadKey: 'celtic-cross', question: '测试问题' });
eq('抽到 10 张牌', draw.cards.length, 10);
eq('问题被记录', draw.question, '测试问题');
eq('牌阵名正确', draw.spreadName, '凯尔特十字');

var drawnIds = draw.cards.map(function (c) { return c.cardId; });
var uniqueIds = drawnIds.filter(function (id, i) { return drawnIds.indexOf(id) === i; });
eq('同一次抽牌不出现重复牌', uniqueIds.length, 10);

eq('牌位顺序与牌阵一致', draw.cards[0].position.title, '现状');
check('每个牌位都带 asks', draw.cards.every(function (c) {
  return typeof c.position.asks === 'string' && c.position.asks.length > 5;
}));
check('每张牌都带牌义', draw.cards.every(function (c) { return c.meaning.text.length > 10; }));
check('每张牌都有朝向', draw.cards.every(function (c) {
  return c.orientation === '正位' || c.orientation === '逆位';
}));
check('朝向与 reversed 字段一致', draw.cards.every(function (c) {
  return (c.orientation === '逆位') === c.reversed;
}));
check('抽牌编号为 16 位十六进制', /^[0-9a-f]{16}$/.test(draw.id), draw.id);
check('审计信息非空', draw.audit.length > 10);
check('问题留空时不报错', drawAuto({ spreadKey: 'single' }).question === '');

// 只用大阿卡纳
var majorDraw = drawAuto({ spreadKey: 'celtic-cross', deckKey: 'major' });
check('大阿卡纳模式下只出现大牌', majorDraw.cards.every(function (c) {
  return c.card.suit === 'major';
}));
eq('大阿卡纳模式牌库标签', majorDraw.deckLabel, '只用大阿卡纳 22 张');

// 牌数不足时报错：临时把牌库缩小到 5 张，再抽需要 10 张的牌阵
var realDeck = Cards.deck;
try {
  Tarot.Cards.deck = realDeck.slice(0, 5);
  throws('牌数不足时明确报错',
    function () { drawAuto({ spreadKey: 'celtic-cross' }); },
    /牌库只有 5 张/);
} finally {
  Tarot.Cards.deck = realDeck;
}
eq('测试后牌库已还原', Tarot.Cards.deck.length, 78);

throws('不存在的牌阵会报错',
  function () { drawAuto({ spreadKey: 'not-a-spread' }); },
  /没有这个牌阵/);

// 两次抽牌应当不同（同一次抽到完全相同的 10 张牌顺序的概率约为 1/78! ）
var drawA = drawAuto({ spreadKey: 'celtic-cross' });
var drawB = drawAuto({ spreadKey: 'celtic-cross' });
var sameOrder = drawA.cards.every(function (c, i) { return c.cardId === drawB.cards[i].cardId; });
check('连续两次抽牌结果不同', !sameOrder);

// 抽牌不应修改牌库本身
var deckBefore = Cards.deck.map(function (c) { return c.id; }).join(',');
drawAuto({ spreadKey: 'celtic-cross' });
eq('抽牌不修改牌库顺序', Cards.deck.map(function (c) { return c.id; }).join(','), deckBefore);

/* ================================================================== *
 * 4. 随机性统计检验
 * ================================================================== */

section('随机性统计检验');

check('crypto.getRandomValues 可用', RNG.available());

/*
 * 4.1 均匀性：卡方检验（自由度 77）。
 *
 * 用「多次独立试验取均值」，不用单次检验。理由是卡方的一个反直觉性质：
 * 原假设成立时，卡方统计量的分布**与样本量无关**——无论抽多少次，
 * 单次卡方超过临界值的概率都是固定的（自由度 77 时 0.05 临界值 98.0，
 * 也就是说约 5% 的概率随机失败）。
 *
 * 这条曾经是单次检验，实测确实会偶发失败（一次跑到 113.6，超过 0.01 临界值）。
 * 一个会随机失败的测试比没有更糟：它训练人去忽略失败。
 *
 * 改成 60 次试验取均值后，均值的期望是自由度 77、标准差约 4.5，
 * 落在 [65, 90] 之外的几率可以忽略；同时对真实偏差反而更灵敏。
 */
var buckets = 78;
var TRIALS_78 = 60;
var PER_TRIAL_78 = 2000;   // 每格期望 2000/78 ≈ 25.6

var chiSum78 = 0;
var chiMin78 = Infinity;
var chiMax78 = -Infinity;
var allCounts = new Array(buckets).fill(0);

for (var trial78 = 0; trial78 < TRIALS_78; trial78++) {
  var counts = new Array(buckets).fill(0);
  for (var i = 0; i < PER_TRIAL_78; i++) {
    var b = RNG.randomBelow(buckets);
    counts[b] += 1;
    allCounts[b] += 1;
  }
  var exp78 = PER_TRIAL_78 / buckets;
  var chi = 0;
  counts.forEach(function (count) { chi += Math.pow(count - exp78, 2) / exp78; });
  chiSum78 += chi;
  if (chi < chiMin78) chiMin78 = chi;
  if (chi > chiMax78) chiMax78 = chi;
}

var meanChi78 = chiSum78 / TRIALS_78;
console.log('  卡方均值 = ' + meanChi78.toFixed(2) +
  '（自由度 77，60 次试验；单次区间 [' + chiMin78.toFixed(1) + ', ' + chiMax78.toFixed(1) + ']）');
check('1-78 分布均匀（均值卡方落在 65 到 90 之间）',
  meanChi78 > 65 && meanChi78 < 90, '均值卡方 = ' + meanChi78.toFixed(2));

// 全量样本也检查一遍：每格都取得到、且都在合理区间
var emptyBuckets = allCounts.filter(function (count) { return count === 0; }).length;
eq('没有取不到的数值', emptyBuckets, 0);

/*
 * 单格计数的容差要按统计量算，不能拍脑袋。
 *
 * 这一条曾经写 ±10%，而那只有 2.7 个标准差——78 个格子取最大最小值，
 * 超出去是必然的，所以它会偶发失败。正确的算法：
 *
 *   单格计数近似正态，标准差 σ = sqrt(n·p·(1-p))，其中 n 是总抽数、p = 1/78
 *
 * 但「4σ」这个档位选错了。4σ 单侧误报率约 3e-5，看起来极小，可这里有
 * 78 个格子各检一次、又取最大最小值，家族错误率就变成
 *
 *   1 - (1 - 2×3.2e-5) ^ 78 ≈ 0.5%
 *
 * 也就是平均每 200 次会红一次——而这一条实测确实红过（最多 1702，
 * 容差 156，超了 8）。一条每两百次假红一次的断言比没有更糟：它会训练
 * 人看到红就直接重跑，真出问题时也一起被忽略掉。
 *
 * 改取 5σ：单侧约 2.9e-7，78 格约 4.5e-5（1/22000 次），可以当成真信号。
 * 灵敏度并没有因此失去——5σ 对应 195 的偏差，真要是某个数偏多偏少，
 * 那是能抓出来的量级。代价是「只偏一点」的偏差这条看不到，所以下面
 * 补了一条单次卡方上界：卡方是把 78 格一起算的，偏一点点也累积得起来。
 */
var totalDraws = TRIALS_78 * PER_TRIAL_78;
var p78 = 1 / buckets;
var avgPerBucket = totalDraws / buckets;
var sigma78 = Math.sqrt(totalDraws * p78 * (1 - p78));
var tol78 = 5 * sigma78;

var minCount = Math.min.apply(null, allCounts);
var maxCount = Math.max.apply(null, allCounts);
console.log('  每格：期望 ' + avgPerBucket.toFixed(0) + '，σ = ' + sigma78.toFixed(1) +
  '，容差 ±5σ = ±' + tol78.toFixed(0));
check('每格出现次数都在 ±5σ 内',
  minCount > avgPerBucket - tol78 && maxCount < avgPerBucket + tol78,
  '最少 ' + minCount + '，最多 ' + maxCount + '，期望 ' + avgPerBucket.toFixed(0));

/*
 * 单次卡方的上界。
 *
 * 这个界同样不能按「单次分位数」来取——上面 4σ 那条踩的就是这个坑，
 * 这里差点又踩一遍。chiMax78 是 TRIALS_78 次试验里的**最大值**，
 * 不是一次观测：
 *
 *   自由度 77 的卡方，单次 99.9% 分位约 116
 *   但 60 次里至少一次超过 116 的概率 = 1 - 0.999^60 ≈ 6%
 *
 * 也就是说按 116 设阈，这条断言自己会有 6% 的假红率。
 * 要让假红率低于万分之一，单次允许的概率得压到 1.7e-6 以下，
 * 对应卡方约 145。取 145。
 *
 * 145 仍然抓得住真实的偏斜：真要是某个数少抽了 10%，77 个自由度的
 * 卡方会轻松冲到 200 以上。
 */
check('单次分布没有明显不匀（卡方 < 145）', chiMax78 < 145,
  '最大卡方 = ' + chiMax78.toFixed(1));

// 4.2 边界：randomBelow 必须只产生 [0, bound)
var outOfRange = 0;
for (var j = 0; j < 20000; j++) {
  var value = RNG.randomBelow(78);
  if (value < 0 || value >= 78 || value !== Math.floor(value)) outOfRange += 1;
}
eq('randomBelow 不越界且为整数', outOfRange, 0);

// 4.3 bound = 1 的退化情况
var ones = 0;
for (var k = 0; k < 100; k++) ones += RNG.randomBelow(1);
eq('bound=1 时恒返回 0', ones, 0);

// 4.4 正逆位比例（二项分布，n = 40000，p = 0.5，标准差约 100）
var reversedCount = 0;
for (var m = 0; m < 40000; m++) if (RNG.randomBool()) reversedCount += 1;
var revRate = reversedCount / 40000;
console.log('  逆位比例 = ' + (revRate * 100).toFixed(2) + '%');
near('正逆位比例接近 50%', revRate, 0.5, 0.02);

// 4.5 洗牌均匀性：第一张牌应当覆盖全部 78 张
var firstSeen = {};
for (var n = 0; n < 30000; n++) {
  var shuffled = RNG.shuffle(Cards.deck.slice());
  firstSeen[shuffled[0].id] = (firstSeen[shuffled[0].id] || 0) + 1;
}
eq('洗牌后 78 张牌都可能当第一张', Object.keys(firstSeen).length, 78);

// 4.6 洗牌应当原地修改并返回同一个数组
var arr = [1, 2, 3, 4, 5];
var returned = RNG.shuffle(arr);
check('shuffle 返回同一个数组引用', returned === arr);

// 4.7 sample 不修改原数组
var source = [1, 2, 3, 4, 5, 6, 7, 8];
var picked = RNG.sample(source, 3);
eq('sample 不修改原数组', source.join(','), '1,2,3,4,5,6,7,8');
eq('sample 取到 3 个', picked.length, 3);

// 4.8 无偏性硬证据：小范围取样是否严格等概率。
//
// 这里必须用「多次独立试验取均值」，不能只跑一次。
//
// 原因是卡方的一个反直觉性质：在原假设成立时，卡方统计量的分布**与样本量无关**。
// 所以无论抽多少次，单次卡方超过临界值的概率都是固定的（自由度 4 时约 1%）。
// 早先这条测试跑 100 万次样本、只用一次卡方，还注释说「样本量大所以不会偶发失败」
// ——那个理由是错的，它实际上有约 1% 的概率随机失败。一个会随机失败的测试比没有更糟：
// 它训练人去忽略失败。
//
// 改成跑 400 次独立试验、每次 5 万样本、取卡方的**均值**之后：
// 均值的期望是自由度 4，标准差约 0.2，所以落在 [3, 5] 之外的几率可以忽略。
// 同时它对真实偏差比单次检验更灵敏——真实偏差会把均值整体推高。
var TRIALS = 400;
var PER_TRIAL = 50000;
var EXPECTED_PER_BUCKET = PER_TRIAL / 5;

var chiSum = 0;
var chiMin = Infinity;
var chiMax = -Infinity;
for (var trial = 0; trial < TRIALS; trial++) {
  var bucket = new Array(5).fill(0);
  for (var p = 0; p < PER_TRIAL; p++) bucket[RNG.randomBelow(5)] += 1;
  var chi = 0;
  bucket.forEach(function (count) {
    chi += Math.pow(count - EXPECTED_PER_BUCKET, 2) / EXPECTED_PER_BUCKET;
  });
  chiSum += chi;
  if (chi < chiMin) chiMin = chi;
  if (chi > chiMax) chiMax = chi;
}
var meanChi = chiSum / TRIALS;

console.log('  小范围卡方（5 格 自由度 4，' + TRIALS + ' 次试验取均值）= ' +
  meanChi.toFixed(3));
console.log('    单次区间 [' + chiMin.toFixed(2) + ', ' + chiMax.toFixed(2) +
  ']，理论期望 4');
check('小范围取样均匀（均值卡方落在 3 到 5 之间）',
  meanChi > 3 && meanChi < 5, '均值卡方 = ' + meanChi.toFixed(3));

// 4.9 拒绝采样：bound 为 3 时 2^32 % 3 = 1，理论上会有极少量拒绝。
// 跑 20 万次，确认结果依旧全在范围内、且三个值分布均匀。
var three = [0, 0, 0];
for (var q = 0; q < 200000; q++) three[RNG.randomBelow(3)] += 1;
var threeSpread = Math.max.apply(null, three) - Math.min.apply(null, three);
check('bound=3 分布均匀', threeSpread < 4000, '最大最小差 ' + threeSpread);

// 4.10 审计记录
RNG.startAudit();
var auditValue = RNG.randomBelow(78);
var auditRecord = RNG.endAudit();
eq('审计记录了 1 个随机字', auditRecord.rawCount, 1);
check('审计记录了原始值', auditRecord.words.length === 1 && typeof auditRecord.words[0] === 'number');
check('审计值能推出抽到的牌', auditValue >= 0 && auditValue < 78);
var auditText = RNG.auditLine();
check('审计文字包含消耗字数', /消耗 \d+ 个 32 位随机字/.test(auditText), auditText);

// 4.11 参数校验
throws('randomBelow(0) 会报错', function () { RNG.randomBelow(0); }, /bound/);
throws('randomBelow(-3) 会报错', function () { RNG.randomBelow(-3); }, /bound/);
throws('shuffle(null) 会报错', function () { RNG.shuffle(null); }, /数组/);
throws('sample 超量会报错', function () { RNG.sample([1, 2], 5); }, /只有/);

/* ================================================================== *
 * 4. 扇形洗牌与挑牌
 * ================================================================== */

section('扇形洗牌与挑牌');

var fanSession = Engine.prepareFan({ spreadKey: 'three-time', question: '扇形测试' });

eq('扇形里是整副牌', fanSession.fanOrder.length, 78);
eq('牌序也是整副牌', fanSession.deckOrder.length, 78);
eq('需要挑 3 张', fanSession.needed, 3);
eq('问题被记录', fanSession.question, '扇形测试');
check('一开始没有已挑的牌', fanSession.picks.length === 0);

// 关键：扇形顺序必须独立于牌序，否则「自己选」就是假的
check('扇形顺序与牌序不是同一个排列',
  JSON.stringify(fanSession.fanOrder) !== JSON.stringify(fanSession.deckOrder));

var fanSorted = fanSession.fanOrder.slice().sort().join(',');
var deckSorted = fanSession.deckOrder.slice().sort().join(',');
eq('扇形与牌序包含同一副牌', fanSorted, deckSorted);

// 挑牌：挑的是位置
var expectedFirst = fanSession.fanOrder[5];
var pick1 = Engine.takeFromFan(fanSession, 5);
eq('挑到的正是该位置上的牌', pick1.cardId, expectedFirst);
eq('挑牌后扇形少一张', fanSession.fanOrder.length, 77);
check('挑走的牌从扇形里消失', fanSession.fanOrder.indexOf(expectedFirst) < 0);
eq('记录里有一张', fanSession.picks.length, 1);
check('挑牌时定下了朝向',
  pick1.orientation === '正位' || pick1.orientation === '逆位');
check('挑牌带完整牌义', pick1.meaning.text.length > 10);

// 越界与非法参数
throws('超出扇形范围会报错',
  function () { Engine.takeFromFan(fanSession, 999); }, /没有第 999 个位置/);
throws('负数位置会报错',
  function () { Engine.takeFromFan(fanSession, -1); }, /没有第 -1 个位置/);
throws('没有会话时挑牌会报错',
  function () { Engine.takeFromFan({}, 0); }, /请先洗牌/);

// 挑满并收尾
Engine.takeFromFan(fanSession, 0);
Engine.takeFromFan(fanSession, 3);
eq('已挑 3 张', fanSession.picks.length, 3);

var fanResult = Engine.finalizeDraw(fanSession);
eq('收尾后牌数为 3', fanResult.cards.length, 3);
eq('按牌阵顺序落位', fanResult.cards[0].position.title, '过去');
eq('第 2 张落在第二位', fanResult.cards[1].position.title, '现在');
eq('第 3 张落在第三位', fanResult.cards[2].position.title, '未来');
eq('第 1 张就是先挑的那张', fanResult.cards[0].cardId, expectedFirst);
eq('收尾后剩余 75 张', fanResult.remaining.length, 75);
check('已抽牌与剩余牌没有交集', fanResult.drawnIds.every(function (id) {
  return fanResult.remaining.indexOf(id) < 0;
}));
check('审计覆盖整段动作（含挑牌消耗的字数）',
  /消耗 \d+ 个 32 位随机字/.test(fanResult.audit), fanResult.audit);
check('随机源说明写明了用户选牌',
  fanResult.rng.indexOf('选牌位置由用户决定') >= 0, fanResult.rng);

// 收尾的边界
throws('没有挑任何牌不能收尾',
  function () { Engine.finalizeDraw(Engine.prepareFan({ spreadKey: 'three-time' })); },
  /还没有挑任何牌/);
throws('不存在的牌阵会报错',
  function () { Engine.prepareFan({ spreadKey: 'nope' }); }, /没有这个牌阵/);

// 挑牌顺序决定牌位归属：先挑的落在第一个牌位
var orderSession = Engine.prepareFan({ spreadKey: 'three-time' });
var pickA = Engine.takeFromFan(orderSession, 40);
var pickB = Engine.takeFromFan(orderSession, 10);
var pickC = Engine.takeFromFan(orderSession, 70);
var ordered = Engine.finalizeDraw(orderSession);
eq('先挑的落在第一位', ordered.cards[0].cardId, pickA.cardId);
eq('第二挑的落在第二位', ordered.cards[1].cardId, pickB.cardId);
eq('第三挑的落在第三位', ordered.cards[2].cardId, pickC.cardId);

/* ================================================================== *
 * 5. 扇形位置与牌面的独立性（「自己选」成立的前提）
 * ================================================================== */

section('扇形位置与牌面独立');

// 如果扇形顺序就是牌序，那么「牌序里的第一张」永远出现在扇形第 0 位。
// 跑很多次，看它是不是散布在 78 个位置里。
var firstCardPositions = {};
for (var round = 0; round < 400; round++) {
  var s = Engine.prepareFan({ spreadKey: 'single' });
  var topOfDeck = s.deckOrder[0];
  var at = s.fanOrder.indexOf(topOfDeck);
  firstCardPositions[at] = (firstCardPositions[at] || 0) + 1;
}
var distinctPositions = Object.keys(firstCardPositions).length;
console.log('  牌序首位在扇形里出现过的位置数：' + distinctPositions + ' / 78');
check('牌序首位能出现在扇形的各种位置',
  distinctPositions > 60, '只出现了 ' + distinctPositions + ' 个不同位置');

// 反向看：固定挑扇形第 0 位，多次抽牌应当抽到各种不同的牌
var cardsAtZero = {};
for (var round2 = 0; round2 < 400; round2++) {
  var s2 = Engine.prepareFan({ spreadKey: 'single' });
  var zeroId = Engine.takeFromFan(s2, 0).cardId;
  cardsAtZero[zeroId] = (cardsAtZero[zeroId] || 0) + 1;
}
var distinctCards = Object.keys(cardsAtZero).length;
console.log('  固定挑第 0 位，抽到过的不同牌数：' + distinctCards + ' / 78');
check('固定挑同一位置也能抽到各种牌', distinctCards > 60,
  '只出现了 ' + distinctCards + ' 种牌');

/* ================================================================== *
 * 6. 扇形版面
 * ================================================================== */

section('待挑牌区版面');

/*
 * 这一区从「弧形 + 重叠的扇形」改成了**网格**：每张牌完整可见、互不压盖。
 *
 * 改的原因在手机上很直接：扇形靠每张只露 22px 制造牌堆感，牌面本来就小，
 * 重叠之后根本分不清哪张是哪张，点起来全靠猜。网格让边界清楚，
 * 代价是一屏放不下 78 张，需要滚动。
 *
 * 所以下面验的也换了：不再是「弧形对不对、旋转角对不对」，
 * 而是「有没有真的一格一张、不重叠、不越界」。
 */

var FM = Render.metrics();
var FAN_W = FM.fanCardW;
var FAN_H = FM.fanCardH;
var FAN_CELL = FM.fanCell;

console.log('  当前尺寸：牌 ' + FAN_W + '×' + FAN_H +
  '，格子 ' + FAN_CELL + '，一行 ' + FM.fanPerRow + ' 张');

var fan1 = Render.fanLayout(1);
eq('1 张时只有 1 个位置', fan1.positions.length, 1);
eq('1 张时水平居中',
  Math.round(fan1.positions[0].left + FAN_W / 2),
  Math.round(fan1.width / 2));

var fan78 = Render.fanLayout(78);
eq('78 张时排出 78 个位置', fan78.positions.length, 78);

// 记下当前视口，跑完这一组要恢复
var savedVwForFan = Render.metrics().viewport;
var savedTouchForFan = Render.metrics().isTouch;

/** 按行号分组，返回 {row: 该行位置数} */
function rowCountOf(layout) {
  var rows = {};
  layout.positions.forEach(function (p) { rows[p.row] = (rows[p.row] || 0) + 1; });
  return rows;
}

/*
 * 行数要满足两条**互相独立**的约束，而不是把实现的公式抄一遍。
 *
 * 原来写的是 `eq(fan78.rows, Math.ceil(78 / FM.fanPerRow))`——右边就是
 * render.js 里算行数的同一个式子。公式错了两边一起错，断言照样绿。
 *
 * 改成从两个方向夹：
 *   不多 —— 每行都不能超过一行容量（超了说明排不下还硬塞）
 *   不少 —— 行数不能多到「少一行也放得下」（多排一行是浪费，也说明落位算错）
 */
[78, 22, 5].forEach(function (n) {
  var layout = Render.fanLayout(n);
  var counts = rowCountOf(layout);
  var perRow = Object.keys(counts).map(function (r) { return counts[r]; });

  eq(n + ' 张：位置数与张数一致', layout.positions.length, n);

  check(n + ' 张：每行都不超过一行容量',
    perRow.every(function (c) { return c <= FM.fanPerRow; }),
    '每行 ' + perRow.join('/') + '，容量 ' + FM.fanPerRow);

  check(n + ' 张：行数没有多排（少一行就放不下）',
    (layout.rows - 1) * FM.fanPerRow < n,
    layout.rows + ' 行 × 容量 ' + FM.fanPerRow + ' ≥ ' + n);

  check(n + ' 张：行号从 0 连续编号',
    Object.keys(counts).sort(function (a, b) { return a - b; })
      .join(',') === Array.apply(null, Array(layout.rows))
        .map(function (_, i) { return i; }).join(','),
    '实际行号 ' + Object.keys(counts).join(','));
});

var fan22 = Render.fanLayout(22);
check('22 张比 78 张矮', fan22.height < fan78.height,
  fan22.height + ' vs ' + fan78.height);

/* ---- 核心：一张一格，不重叠 ---- */

/*
 * 相邻牌的间距下限用**外部标准**，不用实现里的常量。
 *
 * 原来断言的是 `xs[i] - xs[i-1] >= FAN_W`，而位置是 `leftBase + c * fanCell`、
 * `fanCell = fanCardW + fanGap`、`fanGap = max(5, …)` 生成的——相邻差恒等于
 * fanCell，断言实际退化成 `fanGap >= 0`，永远成立。
 *
 * 现在改成「间距必须够手指点」：触摸设备 44px（通用的触控目标下限，
 * 和牌多大无关）。牌变小、间距被压到 44px 以下时这条会红——
 * 而那正是会点错牌的情形。
 */
var minStep = FM.isTouch ? 44 : 20;

check('同一行内相邻牌的间距够点得准（≥' + minStep + 'px）', (function () {
  var byRow = {};
  fan78.positions.forEach(function (p) {
    if (!byRow[p.row]) byRow[p.row] = [];
    byRow[p.row].push(p.left);
  });
  return Object.keys(byRow).every(function (row) {
    var xs = byRow[row].sort(function (a, b) { return a - b; });
    for (var i = 1; i < xs.length; i++) {
      if (xs[i] - xs[i - 1] < minStep) return false;
    }
    return true;
  });
})(), '牌宽 ' + FAN_W + '，格子 ' + FAN_CELL + '，下限 ' + minStep);

// 相邻两行的纵向间距必须装得下整张牌（否则上下两行会压在一起）
var fanRowTops = (function () {
  var tops = {};
  fan78.positions.forEach(function (p) { tops[p.row] = p.top; });
  return Object.keys(tops).map(function (r) { return tops[r]; })
    .sort(function (a, b) { return a - b; });
})();

check('相邻两行不重叠', (function () {
  for (var i = 1; i < fanRowTops.length; i++) {
    if (fanRowTops[i] - fanRowTops[i - 1] < FAN_H) return false;
  }
  return true;
})(), '牌高 ' + FAN_H);

check('行距大于牌高（上下两行之间有缝）',
  fanRowTops.length < 2 || (fanRowTops[1] - fanRowTops[0]) > FAN_H,
  '行距 ' + (fanRowTops.length > 1 ? (fanRowTops[1] - fanRowTops[0]).toFixed(1) : 'n/a') +
  '，牌高 ' + FAN_H);

/*
 * 触摸设备上的牌不能小于 44px，而且牌之间要有**看得见的缝隙**。
 *
 * 原写法是 `!FM.isTouch || FAN_W >= 44`，而 FM 是本节开头取的 metrics——
 * 那时还是默认的鼠标设备，`!FM.isTouch` 为真，整条直接短路成 true，
 * 右边的尺寸检查**从来没执行过**。
 *
 * 「一格 ≥44px」只保证点得准，不保证看得清：牌宽 44、间距 1px 时
 * fanCell = 45 仍然过线，但两张牌视觉上贴在一起，分不清边界。
 * 所以要单独验缝隙——它才是「一张一格」这个设计真正要的效果。
 */
var MIN_VISIBLE_GAP = 3;

[360, 390, 430, 768].forEach(function (vw) {
  var tm = Render.setViewportWidth(vw, true);

  check('触摸视口 ' + vw + '：待挑牌 ≥44px', tm.fanCardW >= 44,
    '实际 ' + tm.fanCardW + 'px');
  check('触摸视口 ' + vw + '：一格 ≥44px', tm.fanCell >= 44,
    '实际 ' + tm.fanCell + 'px');
  check('触摸视口 ' + vw + '：一行至少放得下 2 张', tm.fanPerRow >= 2,
    '实际 ' + tm.fanPerRow + ' 张');

  check('触摸视口 ' + vw + '：牌之间有看得见的缝隙（≥' + MIN_VISIBLE_GAP + 'px）',
    tm.fanCell - tm.fanCardW >= MIN_VISIBLE_GAP,
    '缝隙 ' + (tm.fanCell - tm.fanCardW) + 'px（牌宽 ' + tm.fanCardW +
    '，格子 ' + tm.fanCell + '）');
  check('触摸视口 ' + vw + '：行间也有缝隙',
    tm.fanRowPitch - tm.fanCardH >= MIN_VISIBLE_GAP,
    '行间缝 ' + (tm.fanRowPitch - tm.fanCardH) + 'px');
});

// 鼠标设备同样要有可见缝隙
check('鼠标视口：牌之间有看得见的缝隙（≥' + MIN_VISIBLE_GAP + 'px）',
  FM.fanCell - FM.fanCardW >= MIN_VISIBLE_GAP,
  '缝隙 ' + (FM.fanCell - FM.fanCardW) + 'px');

Render.setViewportWidth(savedVwForFan, savedTouchForFan);

/* ---- 每行居中 ---- */

[1, 2, 22, 40, 41, 78].forEach(function (n) {
  var l = Render.fanLayout(n);
  var byRow = {};
  l.positions.forEach(function (p) {
    if (!byRow[p.row]) byRow[p.row] = [];
    byRow[p.row].push(p.left);
  });
  var centered = Object.keys(byRow).every(function (row) {
    var xs = byRow[row];
    var leftEdge = Math.min.apply(null, xs);
    var rightEdge = Math.max.apply(null, xs) + FAN_W;
    return Math.abs((leftEdge + rightEdge) / 2 - l.width / 2) < 1;
  });
  check(n + ' 张时每行都水平居中', centered);
});

check('所有牌都在待挑区宽度内', fan78.positions.every(function (p) {
  return p.left >= 0 && p.left + FAN_W <= fan78.width;
}), '宽度 ' + fan78.width);

check('所有牌的 top 非负', fan78.positions.every(function (p) {
  return p.top >= 0;
}));

// 网格不旋转——旋转会让卡片超出格子、和邻牌挨上
check('网格布局不旋转', fan78.positions.every(function (p) {
  return p.rotate === 0;
}), '有非零旋转角');

var fanEmpty = Render.fanLayout(0);
eq('0 张时没有位置', fanEmpty.positions.length, 0);
eq('0 张时没有行', fanEmpty.rows, 0);

check('提示要写第几张',
  Render.fanPrompt({ needed: 10, picked: 3, remaining: 75 }).indexOf('请挑第 4 张') >= 0);
check('提示写明牌区还剩多少',
  Render.fanPrompt({ needed: 10, picked: 3, remaining: 75 })
    .indexOf('牌区里还剩 75 张') >= 0);
// 一共几张由面板右上角的「3 / 10」负责说，提示里再写一遍是同一个数字
// 出现两次。这里反过来钉住它不许回来。
check('提示不再重复总数',
  Render.fanPrompt({ needed: 10, picked: 3, remaining: 75 }).indexOf('共 10 张') < 0,
  Render.fanPrompt({ needed: 10, picked: 3, remaining: 75 }));
check('挑够后提示结束',
  Render.fanPrompt({ needed: 3, picked: 3, remaining: 70 }).indexOf('已经挑够') >= 0);

/* ================================================================== *
 * 6.5 问题拆解与贴合度（「解读跟我的问题关系不大」这个问题的对策）
 * ================================================================== */

section('问题拆解');

var q1 = LLM.parseQuestion('我要不要接受这个 offer？');
check('识别出这是一个选择型问题', q1.hints.choice);
check('锚点取到 offer', q1.hints.about === 'offer', q1.hints.about);
check('抽到 offer 这个具体词', q1.terms.indexOf('offer') >= 0, q1.terms.join(','));
check('不算空泛', !q1.isVague);

var q2 = LLM.parseQuestion('我现在的工作让我很疲惫，但又不确定要不要换。我该怎么考虑这件事？');
check('抽到「工作」', q2.terms.indexOf('工作') >= 0, q2.terms.join(','));
check('抽到「疲惫」', q2.terms.indexOf('疲惫') >= 0);
check('锚点取「工作」而不是时间词「现在」', q2.hints.about === '工作', q2.hints.about);
check('摘出了顾虑', q2.hints.stake.indexOf('不确定要不要换') >= 0, q2.hints.stake);
check('识别为选择型', q2.hints.choice);

var q3 = LLM.parseQuestion('该不该为了孩子搬到另一个城市，但怕影响收入');
check('抽到「孩子」「城市」「收入」',
  q3.terms.indexOf('孩子') >= 0 && q3.terms.indexOf('城市') >= 0 && q3.terms.indexOf('收入') >= 0,
  q3.terms.join(','));

var qBlank = LLM.parseQuestion('');
check('空问题标记为空白', qBlank.isBlank);
check('空问题没有具体词', qBlank.terms.length === 0);

var qVague = LLM.parseQuestion('嗯');
check('短到问不出东西的标记为空泛', qVague.isVague);
check('空泛问题的 kind 是 vague', qVague.kind === 'vague', qVague.kind);

/*
 * 开放式问法：不是「问得不好」，是另一种正当的问法。
 *
 * 这一节的存在有具体起因：早先只有「具体 / 空泛」两分，于是
 * 「我今天会发生些什么」被判成「问题太笼统」并弹出警告——等于告诉用户
 * 一个塔罗本来就该答的问题不该问。那是个判断错误。
 */
section('开放问题的识别');

[
  { q: '我今天会发生些什么', tf: '今天' },
  { q: '今天会发生什么', tf: '今天' },
  { q: '这段时间我该留意什么', tf: '这段时间' },
  { q: '这周会怎么样', tf: '这周' },
  { q: '最近运气怎么样', tf: '最近' },
  { q: '我该怎么办', tf: '' }
].forEach(function (item) {
  var p = LLM.parseQuestion(item.q);
  check('「' + item.q + '」识别为开放问题', p.isOpen, 'kind=' + p.kind);
  check('「' + item.q + '」不判为空泛', !p.isVague);
  check('「' + item.q + '」kind 是 open', p.kind === 'open', p.kind);
  if (item.tf) {
    eq('「' + item.q + '」抽出时段「' + item.tf + '」', p.hints.timeframe, item.tf);
  }
});

// 开放问题即使一个字的具体词都没有，也不该被劝退
var qOpenNoWord = LLM.parseQuestion('帮我看看今天');
check('开放问题可以没有具体词', qOpenNoWord.isOpen && !qOpenNoWord.isVague);

// 开放问题不能把时间词当成「核心」（否则提示词里会出现「核心是：今天」这种废话）
var qOpenAnchor = LLM.parseQuestion('我今天会发生些什么');
check('开放问题不把时间词当锚点', qOpenAnchor.hints.about !== '今天',
  qOpenAnchor.hints.about);

/*
 * 是非问句必须归到「具体问题」，不能因为词表没命中就判成开放。
 *
 * 这一节的起因是一个真实的误判：「我现在继续和她打游戏可以增加好感吗」
 * 指向很具体的一件事，却因为词表里没有「游戏」「好感」而被标成
 * 「这是个开放的问题」——完全读错了用户的意图。
 *
 * 更广的问题还不止这一个：「我还该不该继续找她聊天」「要不要约她出来见面」
 * 同样被判成开放，而它们明明是要求判断的是非问句。
 * 所以判据不能只有词表——句子的形式本身就带着信息。
 */
section('是非问句与日常词');

[
  '我现在继续和她打游戏可以增加好感吗',
  '我还该不该继续找她聊天',
  '要不要约她出来见面',
  '继续这样下去会有用吗',
  '我该不该主动联系她'
].forEach(function (q) {
  var p = LLM.parseQuestion(q);
  check('「' + q + '」归为具体问题', p.kind === 'normal', 'kind=' + p.kind);
  check('「' + q + '」不被当成开放问题', !p.isOpen);
  check('「' + q + '」抽出实词', p.terms.length > 0, p.terms.join(','));
});

// 「游戏」「好感」「聊天」「见面」这些日常词必须能被抽到
[
  { q: '我现在继续和她打游戏可以增加好感吗', want: ['游戏', '好感'] },
  { q: '我还该不该继续找她聊天', want: ['聊天'] },
  { q: '要不要约她出来见面', want: ['见面'] }
].forEach(function (item) {
  var p = LLM.parseQuestion(item.q);
  item.want.forEach(function (w) {
    check('「' + item.q + '」抽到「' + w + '」', p.terms.indexOf(w) >= 0, p.terms.join(','));
  });
});

/*
 * 锚点不能取「继续 / 改变 / 值得」这类通用词。
 *
 * 「继续」几乎出现在任何句子里，拿它当核心等于没给核心。用户在意的
 * 是「好感」「游戏」这种具体的东西。
 */
var qAnchor = LLM.parseQuestion('我现在继续和她打游戏可以增加好感吗');
check('锚点不取「继续」这类通用动作词', qAnchor.hints.about !== '继续',
  qAnchor.hints.about);
check('锚点取到具体的词', qAnchor.hints.about.length > 0, qAnchor.hints.about);

// 开放意图优先于「吗」——句末有疑问词也可能是在问内容
var qOpenWithMa = LLM.parseQuestion('今天会发生什么吗');
check('问内容时即使带「吗」也算开放问题', qOpenWithMa.isOpen,
  'kind=' + qOpenWithMa.kind);

/*
 * 选择型（choice）与是非判断型（verdict）要分开。
 *
 * 两者需要的回答形状不同：choice 要说清支持哪一边，verdict 要给明确的
 * 「能 / 不能 / 取决于什么」。早先只认 choice，于是「…可以增加好感吗」
 * 这类判断句在提示词里一点要求都没有，模型很容易回一段
 * 「感情需要双方努力」——等于没回答。
 */
section('选择型与判断型');

var qChoice = LLM.parseQuestion('我该不该辞职');
/*
 * 「该不该」既是选择（做 / 不做）也是判断（该 / 不该），所以 choice 和
 * verdict 双真才是对的。以前这里断言 !verdict，是因为当时 verdict 只认
 * 「…吗」句式；现在只要有判断词就算判断句，那条断言就过时了。
 *
 * 真正要保证的是答案词：问「该不该」不能答成「要」或「能」。
 */
check('「该不该」判为选择型，答案词是「该 / 不该」',
  qChoice.hints.choice &&
  qChoice.hints.verdictWord &&
  qChoice.hints.verdictWord.yes === '该' &&
  qChoice.hints.verdictWord.no === '不该',
  'choice=' + qChoice.hints.choice + ' verdict=' + qChoice.hints.verdict +
  ' word=' + JSON.stringify(qChoice.hints.verdictWord));

var qVerdict = LLM.parseQuestion('我现在继续和她打游戏可以增加好感吗');
check('「可以…吗」判为判断型', qVerdict.hints.verdict && !qVerdict.hints.choice,
  'choice=' + qVerdict.hints.choice + ' verdict=' + qVerdict.hints.verdict);

/*
 * 「A 不 A」是中文里最随意的判断型问法：「爱不爱」「去不去」「合不合适」。
 *
 * 它很容易被漏掉——答案词表里没有这几条，句子结尾也没有「吗」，
 * 实词表同样抽不到东西，于是一路落到 isOpen 的兜底条件里被判成
 * 「开放问题」，而开放分支根本不要求答案词，模型就又开始泛泛而谈。
 */
[
  { q: '他到底爱不爱我', yes: '爱', no: '不爱' },
  { q: '我到底去不去见她', yes: '去', no: '不去' },
  { q: '我们还合不合适', yes: '合', no: '不合' }
].forEach(function (c) {
  var p = LLM.parseQuestion(c.q);
  check('「' + c.q + '」认出答案词「' + c.yes + ' / ' + c.no + '」',
    Boolean(p.hints.verdictWord) &&
    p.hints.verdictWord.yes === c.yes &&
    p.hints.verdictWord.no === c.no,
    'word=' + JSON.stringify(p.hints.verdictWord));
  check('「' + c.q + '」不判成开放问题', !p.isOpen, 'kind=' + p.kind);
});

/*
 * 以「吗」结尾、但判断词藏在动词里的问法。
 *
 * 这一批是真实漏判：asksForJudgment 第二个正则早就认「能…吗」「该…吗」
 * 这类结构，可 judgmentWordOf 的答案词表只有「能不能」「该不该」这种
 * A 不 A 写法，于是分类正确（isOpen 为 false）但 verdictWord 为 null，
 * prompt 里一句答案词要求都没有，模型自由发挥。
 */
[
  { q: '我能考上吗', yes: '能', no: '不能' },
  { q: '能成功吗', yes: '能', no: '不能' },
  { q: '我该相信他吗', yes: '该', no: '不该' },
  { q: '我要相信他吗', yes: '要', no: '不要' },
  { q: '我需要辞职吗', yes: '需要', no: '不需要' },
  { q: '我做得对吗', yes: '对', no: '不对' }
].forEach(function (c) {
  var p = LLM.parseQuestion(c.q);
  check('「' + c.q + '」认出答案词「' + c.yes + ' / ' + c.no + '」',
    Boolean(p.hints.verdictWord) &&
    p.hints.verdictWord.yes === c.yes &&
    p.hints.verdictWord.no === c.no,
    'word=' + JSON.stringify(p.hints.verdictWord));
});

/*
 * 「需要」必须排在「要」前面。
 *
 * 「我需要辞职吗」里含「要辞职吗」，若「要…吗」那条先命中，答案词会从
 * 「需要 / 不需要」被抢成「要 / 不要」——同一条答错题的另一副面孔。
 */
var qNeed = LLM.parseQuestion('我需要辞职吗');
check('「需要…吗」不会被「要…吗」抢走',
  qNeed.hints.verdictWord && qNeed.hints.verdictWord.yes === '需要',
  'word=' + JSON.stringify(qNeed.hints.verdictWord));

/*
 * 「对不对」的答案是「对 / 不对」，不是「是 / 不是」。
 *
 * 问「我做得对吗」回一个「是」，在中文里就是答错了题——从「是」看不出
 * 用户问的那个字是「对」。这条和「是不是」拆成两条正是因为答案不同。
 */
var qRight = LLM.parseQuestion('我做得对吗');
check('「对不对」给的是「对 / 不对」而不是「是 / 不是」',
  qRight.hints.verdictWord &&
  qRight.hints.verdictWord.yes === '对' &&
  qRight.hints.verdictWord.no === '不对',
  'word=' + JSON.stringify(qRight.hints.verdictWord));

/*
 * 复合词里的「要」不是判断词。
 *
 * 真实 bug：「她之前想要说的事是她被表白了吗」被抽成 {要, 不要}，
 * 模型于是答了「要。」——但问题问的是「是不是」，该答「是 / 不是」。
 * 「想要说」里的「要」属于「想要」，跟要不要做某件事毫无关系。
 * 判断词表里「要…吗」排在「是…吗」前面，就把答案词抢走了。
 */
var qWantTell = LLM.parseQuestion('她之前想要说的事是她被表白了吗');
check('「想要说…吗」不被「要…吗」抢走答案词',
  qWantTell.hints.verdictWord &&
  qWantTell.hints.verdictWord.yes === '是' &&
  qWantTell.hints.verdictWord.no === '不是',
  'word=' + JSON.stringify(qWantTell.hints.verdictWord));

check('「是表白吗」同样给「是 / 不是」',
  (function () {
    var p = LLM.parseQuestion('她之前想要说的事是表白吗');
    return p.hints.verdictWord && p.hints.verdictWord.yes === '是';
  })());

/*
 * 但「需要」不能被误伤——它自己就是判断词，答案「需要 / 不需要」。
 * 「我需要辞职吗」里也有「要辞职吗」，抹多了就会退化成「要 / 不要」。
 */
check('「需要…吗」仍给「需要 / 不需要」而不是「是 / 不是」',
  (function () {
    var p = LLM.parseQuestion('我需要辞职吗');
    return p.hints.verdictWord &&
      p.hints.verdictWord.yes === '需要' &&
      p.hints.verdictWord.no === '不需要';
  })());

/*
 * 「是不是 X」问的是「是不是」，答案就是「是 / 不是」。
 *
 * 我一开始把它改成了「由后面的动词决定答案词」——「是不是应该冷静」
 * 答「该。」。那是错的：「是不是应该冷静」是在问「应该冷静，是不是」，
 * 把它答成「该。」等于替提问者把问题改写成了「该不该冷静」。
 * 中文里自然的回答是「是。」（= 是的，应该）或者「不应该。」。
 *
 * 「是否」是同一件事的书面说法，行为必须一致：「是否该放手」也该答
 * 「是 / 不是」，而不是「该 / 不该」。
 *
 * 这里只钉住答案词的形式，不钉具体抽到哪个词——「是 / 不是」这类
 * 由表里那一行统一给出，句子里有没有「应该 / 需要」都不影响。
 */
var IS_YESNO = [
  '是不是应该冷静一下', '是不是该分手了', '是不是需要辞职',
  '是不是要主动联系他', '是不是可以试试', '是不是值得等',
  '是否该放手', '我是否应该主动', '是否值得继续', '他是否喜欢我'
];
IS_YESNO.forEach(function (q) {
  var p = LLM.parseQuestion(q);
  check('「' + q + '」的答案词是「是 / 不是」',
    p.hints.verdictWord &&
    p.hints.verdictWord.yes === '是' &&
    p.hints.verdictWord.no === '不是',
    'word=' + JSON.stringify(p.hints.verdictWord));
  check('「' + q + '」不被当成开放问题', p.isOpen === false);
});

/*
 * 反过来：真正在问「该不该」「要不要」的，不能被「是 / 不是」抢走。
 * 这些句子里没有「是不是」「是否」，走的是各自那一行。
 */
[
  { q: '该不该继续等', yes: '该', no: '不该' },
  { q: '要不要表白', yes: '要', no: '不要' },
  { q: '需不需要道歉', yes: '需要', no: '不需要' },
  { q: '值不值得再试一次', yes: '值得', no: '不值得' },
  { q: '他会不会回来', yes: '会', no: '不会' },
  { q: '我们能不能复合', yes: '能', no: '不能' }
].forEach(function (c) {
  var p = LLM.parseQuestion(c.q);
  check('「' + c.q + '」仍是「' + c.yes + ' / ' + c.no + '」',
    p.hints.verdictWord &&
    p.hints.verdictWord.yes === c.yes &&
    p.hints.verdictWord.no === c.no,
    'word=' + JSON.stringify(p.hints.verdictWord));
});

/*
 * 误伤防护：这几个词里都藏着「能 / 会 / 好 / 对 / 行」，
 * 一旦把它们当判断动词，问句的性质就被改写了。
 * 「是不是会员」问的是「是不是」，不是「会不会」。
 */
['是不是会员', '是不是能力不够', '是不是好像不太高兴',
  '是不是行李太多了', '是不是对我说了什么', '是不是会议改期了']
  .forEach(function (q) {
    var p = LLM.parseQuestion(q);
    check('「' + q + '」没有被误判成能 / 会 / 好 / 对',
      p.hints.verdictWord &&
      p.hints.verdictWord.yes === '是' &&
      p.hints.verdictWord.no === '不是',
      'word=' + JSON.stringify(p.hints.verdictWord));
  });

/*
 * 以「吗」收尾的短问句不能算 vague。
 *
 * 「他爱我吗」只有四个字、也抽不出实词，但问题是明确的，
 * 要的就是「爱 / 不爱」。算进 vague 会让提示词走「问题太短」
 * 那一条，把一个好好的是非问句当成坏输入打回去。
 */
['他爱我吗', '他想我吗', '他在乎我吗', '他们合适吗'].forEach(function (q) {
  var p = LLM.parseQuestion(q);
  check('「' + q + '」是正常问句而不是 vague',
    p.kind === 'normal' && p.isVague === false,
    'kind=' + p.kind + ' isVague=' + p.isVague);
  check('「' + q + '」被要求回答是 / 不是', p.hints.yesNo === true);
});

/*
 * 「只要 / 要是」这类连词也不能被当成判断词，
 * 但它们本身不是判断词，所以正确答案是「抽不出答案词」。
 */
check('「只要…就」里的「要」不算判断词',
  (function () {
    var p = LLM.parseQuestion('只要我努力就能成功吗');
    return !p.hints.verdictWord || p.hints.verdictWord.yes !== '要';
  })());

/*
 * 以「吗」结尾、但判断词表一个都没命中（「他喜欢我吗」）。
 *
 * 这时抽不出答案词，verdict 和 choice 原本都是 false，提示词对回答形状零要求。
 * 兜底标记 yesNo 要求模型复用问句里的动词，而不是换成「该 / 能」或给一段空话。
 */
var qLike = LLM.parseQuestion('他喜欢我吗');
check('「他喜欢我吗」被标记为通用是非问', qLike.hints.yesNo === true,
  'yesNo=' + qLike.hints.yesNo);
check('「他喜欢我吗」不会被硬塞一个答案词', !qLike.hints.verdictWord,
  'word=' + JSON.stringify(qLike.hints.verdictWord));
check('「他喜欢我吗」不判成开放问题', !qLike.isOpen, 'kind=' + qLike.kind);

// 短到问不出东西的句子不能被当成是非问，否则会要求它给一个是非答案
['然后呢', '怎么办'].forEach(function (q) {
  var p = LLM.parseQuestion(q);
  check('「' + q + '」不被标记为通用是非问', !p.hints.yesNo, 'yesNo=' + p.hints.yesNo);
});

// 开放问题同样不该被要求给是非答案
var qOpenNo = LLM.parseQuestion('最近运势怎么样');
check('「最近运势怎么样」不被标记为通用是非问', !qOpenNo.hints.yesNo,
  'yesNo=' + qOpenNo.hints.yesNo);

/*
 * 主体识别。
 *
 * 用户问「他们互相喜欢吗」，模型答成了「你当下的关系状态是停滞的」——
 * 主语被悄悄换掉，等于答了另一个问题。根因是提示词里对「这件事问的是谁」
 * 零约束，而塔罗解读的默认读法是把一切读成求问者自己的内心。
 *
 * 这里只验证识别本身，提示词层面的断言放在后面。
 */
var qThird = LLM.parseQuestion('他们互相喜欢吗');
check('「他们互相喜欢吗」认出主体是第三方', qThird.hints.subject === 'third',
  'subject=' + qThird.hints.subject);

var qMixed = LLM.parseQuestion('他喜欢我吗');
check('「他喜欢我吗」认出主体是我和他都在场', qMixed.hints.subject === 'mixed',
  'subject=' + qMixed.hints.subject);

var qSelf = LLM.parseQuestion('我该不该换工作');
check('「我该不该换工作」的主体是提问者自己', qSelf.hints.subject === 'self',
  'subject=' + qSelf.hints.subject);

/*
 * 反向：「吉他」「其他」里的「他」不是人称代词。
 * 不排除的话，「吉他买哪个好」会被认成在问别人的事。
 */
['吉他买哪个好', '其他方面还有什么要注意的吗', '他处还有机会吗'].forEach(function (q) {
  var p = LLM.parseQuestion(q);
  check('「' + q + '」不被认成在问别人', p.hints.subject === 'self',
    'subject=' + p.hints.subject);
});

/*
 * 反向：「我朋友」「我同事」里的「我」是定语，不是主体。
 *
 * 「我朋友和她男朋友会分手吗」问的是那两个人，提问者只是认识他们；
 * 判成 mixed 会让提示词要求「说清哪部分是你的」，等于把提问者
 * 硬拉进一段他不在场的关系里。这个 bug 是靠枚举同类型问法发现的。
 */
['我朋友和她男朋友会分手吗', '他对我朋友有意思吗',
  '我同事跟他关系怎么样'].forEach(function (q) {
  var p = LLM.parseQuestion(q);
  check('「' + q + '」的主体不是我', p.hints.subject === 'third',
    'subject=' + p.hints.subject);
});

/*
 * 「…吗」结尾就是是非问句，不能因为抽不到实词就判成开放。
 *
 * 这三个问题的「合适 / 断了 / 同意」都进不了实词表，旧逻辑一路落到
 * 「长度 ≥5 就算开放」的兜底，整段答案词要求被跳过。
 */
['他们两个合适吗', '他跟那个人真的断了吗', '他们家里人同意吗'].forEach(function (q) {
  var p = LLM.parseQuestion(q);
  check('「' + q + '」不算开放问题', p.isOpen === false,
    'isOpen=' + p.isOpen);
});

/*
 * 但「呢」结尾和带开放疑问词的「吗」不能跟着一起改坏。
 */
['我该怎么办呢', '他们现在关系怎么样', '今天会发生些什么'].forEach(function (q) {
  var p = LLM.parseQuestion(q);
  check('「' + q + '」仍然是开放问题', p.isOpen === true,
    'isOpen=' + p.isOpen);
});

var qBlank = LLM.parseQuestion('');
check('空问题的主体默认是自己', qBlank.hints.subject === 'self',
  'subject=' + qBlank.hints.subject);

/*
 * 反向：下面这些句子里也有「不」字，但都不是 A 不 A 结构，
 * 兜底规则不能把它们误伤成判断句。
 */
[
  '不管怎样我都想知道结果',
  '不但没变好，反而更糟',
  '不过我还是想试试',
  '这差不多就是我想要的'
].forEach(function (q) {
  var p = LLM.parseQuestion(q);
  check('「' + q + '」不算判断句', !p.hints.verdictWord,
    'word=' + JSON.stringify(p.hints.verdictWord));
});

var qVerdict2 = LLM.parseQuestion('继续这样下去会有用吗');
check('「会有用吗」判为判断型', qVerdict2.hints.verdict, String(qVerdict2.hints.verdict));

var qVerdict3 = LLM.parseQuestion('这样做值不值得');
check('「值不值得」判为判断型', qVerdict3.hints.verdict, String(qVerdict3.hints.verdict));

var qNotVerdict = LLM.parseQuestion('我今天会发生些什么');
check('开放问题不判为判断型', !qNotVerdict.hints.verdict);

// 指向具体事情的问法仍走常规路径
var qNormal = LLM.parseQuestion('我该不该换工作？');
check('具体问题不走开放路径', !qNormal.isOpen && qNormal.kind === 'normal', qNormal.kind);
check('具体问题仍抽出实词', qNormal.terms.indexOf('换工作') >= 0, qNormal.terms.join(','));

// 时间词不能当锚点（否则提示词里会出现「关于『现在』……」这种废话）
var qTime = LLM.parseQuestion('现在的状态我该怎么走下一步');
check('锚点不会取时间词', qTime.hints.about !== '现在' && qTime.hints.about !== '最近',
  qTime.hints.about);

// 长词优先：问「换工作」时不该只抽到「工作」
var qLong = LLM.parseQuestion('我要不要换工作');
check('长词优先命中「换工作」', qLong.terms.indexOf('换工作') >= 0, qLong.terms.join(','));

section('贴合度检查');

/** 造一份用于检验贴合度的解读 */
function fakeReading(lines) {
  return {
    primer: '先复述处境',
    overview: '总览',
    cards: lines.map(function (text, i) {
      return {
        index: i + 1, position: '位' + (i + 1), cardName: '牌' + (i + 1),
        quote: '', reading: text, action: '', quoteOk: false
      };
    }),
    synthesis: '综合', actions: ['a'], watchOut: 'w'
  };
}

var fitQuestion = LLM.parseQuestion('我现在的工作让我很疲惫，要不要换工作？');

// 套话：一条都没提到问题里的具体词
var genericFit = LLM.evaluateSpecificity(
  fakeReading([
    '这段关系需要更多的沟通与理解。相信自己的直觉，顺其自然就好。',
    '保持耐心，一切都会好起来。跟随内心的声音。',
    '宇宙会给你安排最好的结果。'
  ]), fitQuestion, '');

eq('套话版：三条全部标为散', genericFit.loose.length, 3);
eq('套话版：三条都命中套话词', genericFit.generic.length, 3);
eq('套话版：没有回应任何具体词', genericFit.termsUsed.length, 0);
check('套话版分数很低', genericFit.score < 30, '分数 ' + genericFit.score);
eq('套话版等级为 poor', genericFit.level, 'poor');

// 具体：每条都落到问题里的词上
var tightFit = LLM.evaluateSpecificity(
  fakeReading([
    '你这份工作让你疲惫的根源不是工作量，而是学不到东西。',
    '关于要不要换工作，牌面显示你怕的是换了之后还是一样。',
    '你提到工作疲惫，这张牌说的是你需要的不是休息而是变化。'
  ]), fitQuestion, '');

eq('具体版：没有散掉的牌位', tightFit.loose.length, 0);
eq('具体版：没有套话', tightFit.generic.length, 0);
check('具体版回应了具体词', tightFit.termsUsed.length > 0, tightFit.termsUsed.join(','));
check('具体版分数很高', tightFit.score >= 80, '分数 ' + tightFit.score);
eq('具体版等级为 good', tightFit.level, 'good');

check('具体版分数明显高于套话版', tightFit.score > genericFit.score + 40,
  genericFit.score + ' vs ' + tightFit.score);

// fair 档的定义是「大部分具体，个别一条泛」。三条里散两条属于质量问题，
// 应当是 poor——所以这里用「四条里散一条」来代表 fair。
var fairFit = LLM.evaluateSpecificity(
  fakeReading([
    '你这份工作让你疲惫的根源不是工作量，而是学不到东西。',
    '关于要不要换工作，牌面显示你怕的是换了之后还是一样。',
    '你提到工作疲惫，这张牌说的是你需要的不是休息而是变化。',
    '这段关系需要更多的沟通。'
  ]), fitQuestion, '');

eq('四条里散一条：只标出那一条', fairFit.loose.length, 1);
eq('四条里散一条的等级为 fair', fairFit.level, 'fair');
check('四条里散一条的分数在中间',
  fairFit.score > genericFit.score && fairFit.score < tightFit.score,
  genericFit.score + ' < ' + fairFit.score + ' < ' + tightFit.score);

// 三条里散两条：问题不小，分数应当明显低于 fair 档
var mostlyLooseFit = LLM.evaluateSpecificity(
  fakeReading([
    '你这份工作让你疲惫。',
    '这段关系需要更多的沟通。',
    '保持耐心，相信自己。'
  ]), fitQuestion, '');

eq('三条里散两条：标出两条', mostlyLooseFit.loose.length, 2);
eq('三条里散两条的等级为 poor', mostlyLooseFit.level, 'poor');
check('分数落在全散与 fair 之间',
  mostlyLooseFit.score > genericFit.score && mostlyLooseFit.score < fairFit.score,
  genericFit.score + ' < ' + mostlyLooseFit.score + ' < ' + fairFit.score);

// 问题留空时跳过检查
var skipFit = LLM.evaluateSpecificity(fakeReading(['随便写点']), LLM.parseQuestion(''), '');
eq('问题留空时跳过检查', skipFit.level, 'skip');
eq('跳过时不给散牌位', skipFit.loose.length, 0);

/*
 * 开放问题走专门的检查：看有没有把牌读成「事件预告」。
 *
 * 为什么不用常规的贴合度：开放问题里只有时间词，词覆盖率天然是 0% 或 100%，
 * 无论哪种都没有信息量；而「散牌位」会全部命中（因为正确的读法本来就不该
 * 去复述那些词）。继续按常规打分只会显示一个吓人的低分，把一次正常的解读
 * 说成失败——那正是「我今天会发生些什么」这个 bug 的另一半。
 */
section('开放问题的解读检查');

var openQuestion = LLM.parseQuestion('我今天会发生些什么');

// 好的写法：读成当下处境的映照
var openGood = LLM.evaluateOpenReading({
  primer: 'p', overview: 'o',
  cards: [
    { index: 1, position: '此刻的核心', cardName: 'a', reading: '你现在把注意力放在了几件互相牵扯的事上。', action: '今天先挑一件做完。', quote: '', quoteOk: false },
    { index: 2, position: '行动', cardName: 'b', reading: '值得留意的是你自己的犹豫，它比外部条件更挡路。', action: '把犹豫的点写下来。', quote: '', quoteOk: false },
    { index: 3, position: '结果', cardName: 'c', reading: '你对手上这件事的耐心正在变化。', action: '给自己留半小时不被打断。', quote: '', quoteOk: false }
  ],
  synthesis: 's', actions: [], watchOut: 'w'
});
eq('不预告事件的解读评为 good', openGood.level, 'good');
eq('good 时没有可疑条目', openGood.predictLike.length, 0);

// 坏的写法：像在写日程表
var openPredict = LLM.evaluateOpenReading({
  primer: 'p', overview: 'o',
  cards: [
    { index: 1, position: '此刻的核心', cardName: 'a', reading: '今天会有意外的消息传来。', action: '保持手机畅通。', quote: '', quoteOk: false },
    { index: 2, position: '行动', cardName: 'b', reading: '下午要注意你的同事说的话。', action: '少说话。', quote: '', quoteOk: false },
    { index: 3, position: '结果', cardName: 'c', reading: '这件事本身没什么问题。', action: '按原计划走。', quote: '', quoteOk: false }
  ],
  synthesis: 's', actions: [], watchOut: 'w'
});
eq('写成事件预告的评为 poor', openPredict.level, 'poor');
check('抓出了预告式的条目', openPredict.predictLike.length >= 2,
  String(openPredict.predictLike.length));
check('预告条目带上了原因',
  openPredict.predictLike[0].reason.length > 0, openPredict.predictLike[0].reason);
eq('预告条目记下牌位名', openPredict.predictLike[0].position, '此刻的核心');

// 常规贴合度检查遇到开放问题要改用 open 通道，而不是打一个误导性的低分
var openFit = LLM.evaluateSpecificity(
  { primer: 'p', overview: 'o', cards: [{ index: 1, position: 'x', cardName: 'a', reading: '随便写点', action: '' }], synthesis: 's', actions: [], watchOut: 'w' },
  openQuestion
);
eq('开放问题走 open 通道', openFit.level, 'open');
check('开放问题不给分数', openFit.score === null, String(openFit.score));
eq('开放问题不给散牌位', openFit.loose.length, 0);
eq('开放问题不给套话标记', openFit.generic.length, 0);

section('问题质量与提示词');

// 空泛的问题要在提示词里被指出来
var vagueResult = Engine.prepareFan({ spreadKey: 'single', question: '嗯' });
Engine.takeFromFan(vagueResult, 0);
var vaguePrompt = LLM.buildUserPrompt(Engine.finalizeDraw(vagueResult));
check('空泛问题在提示词里被标注', vaguePrompt.indexOf('短到看不出在问什么') >= 0);

/*
 * 开放问题必须拿到**专门的解读指令**，而不是一句「问题比较笼统」。
 *
 * 早先那样写是两头不落：既劝退了用户，也没告诉模型该怎么答好，
 * 结果模型还是会把它当普通问题处理、写成事件预告。
 */
var openResult = Engine.prepareFan({ spreadKey: 'single', question: '我今天会发生些什么' });
Engine.takeFromFan(openResult, 0);
var openPrompt = LLM.buildUserPrompt(Engine.finalizeDraw(openResult));
check('开放问题在提示词里被标为开放式', openPrompt.indexOf('开放式的') >= 0);
check('开放问题带上时段', openPrompt.indexOf('「今天」') >= 0);
check('开放问题要求把牌读成处境的映照',
  openPrompt.indexOf('对「此刻处境」的映照') >= 0);
check('开放问题要求指出值得留意什么',
  openPrompt.indexOf('什么值得留意') >= 0);
check('开放问题明确不要预告具体事件',
  openPrompt.indexOf('不要指定具体时间、地点、人名') >= 0);
check('开放问题不再说「问题比较笼统」',
  openPrompt.indexOf('这个问题比较笼统') < 0);
check('开放问题不给「必须出现具体词」的硬要求',
  openPrompt.indexOf('每一条 reading 都必须出现') < 0);

/*
 * 这一条来自真事：用户问「接下来该怎么走」，模型回了
 * 「该。你和他的现在这个状态，下一步该做的是……」——把开放问题答成了是非题。
 *
 * 根因不在问题分类（parseQuestion 判得对，isOpen 为真、verdictWord 为 null），
 * 而在 system prompt 的 JSON 格式示例里写死了「第一句就是判断本身，一个词加
 * 句号：该。」，模型照着模板填了个「该」。所以两边都要堵：格式示例区分两类
 * 问题，开放分支再明确禁止一次。只堵一边的话，另一边还在往同一个方向拽。
 */
check('开放问题明确禁止用是非判断词开头',
  openPrompt.indexOf('不要用「该」「能」「会」「可以」「值得」') >= 0);
check('开放问题的提示词点明答成「该」是错题',
  openPrompt.indexOf('就是答错题') >= 0);
check('system 提示词的格式示例区分是非题和开放题',
  LLM.buildSystemPrompt().indexOf('开放题：第一句直接给方向') >= 0);

/*
 * system 模板不能只给「能 / 不能 / 该 / 不该」这几个例子。
 *
 * 模板是最后一道指引，比上面任何一句要求都更靠近模型。原模板写的是
 * 「一个词加句号（能。/ 不能。/ 该。/ 不该。）」——对「他喜欢我吗」，
 * 它等于在教模型答「能」。改成按问句里的词作答后，模板才能覆盖
 * 判断词表抽不出来的那一类。
 */
check('system 模板要求是非题的答案词取自问句本身',
  LLM.buildSystemPrompt().indexOf('问「喜欢吗」答「喜欢。/ 不喜欢。」') >= 0);

// 具体问题要把拆解结果写进提示词
var richResult = Engine.prepareFan({
  spreadKey: 'single',
  question: '我现在的工作让我很疲惫，但又不确定要不要换。'
});
Engine.takeFromFan(richResult, 0);
var richPrompt = LLM.buildUserPrompt(Engine.finalizeDraw(richResult));
check('提示词列出具体方面', richPrompt.indexOf('这件事涉及的具体方面') >= 0);
check('提示词点明核心是什么', richPrompt.indexOf('核心是：') >= 0);
check('提示词要求每条解读出现具体词',
  richPrompt.indexOf('每一条 reading 都必须出现') >= 0);
check('提示词点明这是是非判断问题',
  richPrompt.indexOf('这是一个**是非判断**的问题') >= 0);
check('具体问题不走开放路径', richPrompt.indexOf('开放式的') < 0);

/*
 * 是非判断句要拿到「给明确判断」的指令。
 * 不给的话，模型很容易用「因人而异」把问题推回来。
 */
var verdictResult = Engine.prepareFan({
  spreadKey: 'single',
  question: '我现在继续和她打游戏可以增加好感吗'
});
Engine.takeFromFan(verdictResult, 0);
var verdictPrompt = LLM.buildUserPrompt(Engine.finalizeDraw(verdictResult));
check('判断型问题在提示词里被标注', verdictPrompt.indexOf('是非判断') >= 0);
check('判断型问题要求第一句只能是能或不能',
  verdictPrompt.indexOf('第一句只能是「能」或「不能」') >= 0);
check('判断型问题要求说明依据', verdictPrompt.indexOf('依据是哪张牌的哪一点') >= 0);
check('判断型问题禁止用「倾向于能」这类模棱两可的说法',
  verdictPrompt.indexOf('不要写「倾向于能」') >= 0);
check('判断型问题不走选择型路径',
  verdictPrompt.indexOf('这是一个「要做选择」的问题') < 0);
check('判断型问题带上抽出的实词',
  verdictPrompt.indexOf('游戏') >= 0 && verdictPrompt.indexOf('好感') >= 0,
  verdictPrompt.slice(0, 200));

/*
 * 判断词必须和问题对得上。
 *
 * 真实 bug：用户问「要不要主动联系」，页面第一句是「该。」——答案词用错了。
 * 根因是提示词里写死「只能是「能」或「不能」」，所有是非问都被逼着用同一组词。
 * 这里逐类检查：问哪个词，提示词就得给出对应的答案对。
 */
var promptFor = function (question) {
  var r = Engine.prepareFan({ spreadKey: 'single', question: question });
  Engine.takeFromFan(r, 0);
  return LLM.buildUserPrompt(Engine.finalizeDraw(r));
};

var wantPrompt = promptFor('我要不要主动联系她');
check('「要不要」要求第一句答要或不要',
  wantPrompt.indexOf('第一句只能是「要」或「不要」') >= 0);
check('「要不要」不许要求答能或不能', wantPrompt.indexOf('「能」或「不能」') < 0);
check('「要不要」不许含糊成「权衡」',
  wantPrompt.indexOf('不要只写「要权衡」') >= 0);

var shouldPrompt = promptFor('我该不该继续等她');
check('「该不该」要求第一句答该或不该',
  shouldPrompt.indexOf('第一句只能是「该」或「不该」') >= 0);

var worthyPrompt = promptFor('这段关系值不值得继续投入');
check('「值不值得」要求答值得或不值得',
  worthyPrompt.indexOf('「值得」或「不值得」') >= 0);

var willPrompt = promptFor('我主动联系她会理我吗');
check('「会…吗」要求答会或不会', willPrompt.indexOf('「会」或「不会」') >= 0);

var canPrompt = promptFor('我能考上吗');
check('「能…吗」要求答能或不能', canPrompt.indexOf('「能」或「不能」') >= 0);

var needPrompt = promptFor('我需要辞职吗');
check('「需要…吗」要求答需要或不需要',
  needPrompt.indexOf('「需要」或「不需要」') >= 0);
check('「需要…吗」不许退化成答要或不要',
  needPrompt.indexOf('「要」或「不要」') < 0);

var rightPrompt = promptFor('我做得对吗');
check('「对…吗」要求答对或不对', rightPrompt.indexOf('「对」或「不对」') >= 0);

/*
 * 抽不出答案词的是非问：不指定词，但要求复用问句里的动词。
 *
 * 「他喜欢我吗」的判断词表一个都没命中。硬塞一个「能 / 不能」是另一场
 * 答错题，所以要求模型从问句本身取动词。
 */
var likePrompt = promptFor('他喜欢我吗');
check('「他喜欢我吗」要求直接回答且复用问句动词',
  likePrompt.indexOf('这是一个**是非问句**') >= 0 &&
  likePrompt.indexOf('复用我问句里的那个动词') >= 0);
check('「他喜欢我吗」不硬塞具体答案词',
  likePrompt.indexOf('第一句只能是「') < 0);

var choosePrompt = promptFor('我是该辞职还是留下来继续做');
check('没有判断词时二选一不指定答案词',
  choosePrompt.indexOf('这是一个「要做选择」的问题') >= 0 &&
  choosePrompt.indexOf('「要」或「不要」') < 0 &&
  choosePrompt.indexOf('「该」或「不该」') < 0);

/*
 * 主体必须写进提示词里。
 *
 * 只识别出 subject 是不够的——模型看不到那个字段，它看到的只有提示词文本。
 * 所以每一类主体都要在提示词里留下明确的指令，否则等于什么都没做。
 */
var thirdPrompt = promptFor('他们互相喜欢吗');
check('第三方问题：提示词点明问的是他们而不是我',
  thirdPrompt.indexOf('这件事问的是他们（他 / 她），不是我') >= 0);
check('第三方问题：提示词要求每条 reading 的主语是他们',
  thirdPrompt.indexOf('每一条 reading 的主语都必须是他们') >= 0);
check('第三方问题：提示词说明只有行动段可以用「你」',
  thirdPrompt.indexOf('只有在「可以去做的事」那一段才可以用「你」') >= 0);

var mixedPrompt = promptFor('他喜欢我吗');
check('混合主体：提示词点明两个人都到场',
  mixedPrompt.indexOf('这件事里我和另一个人都在场') >= 0);
check('混合主体：要求说清哪部分是谁的',
  mixedPrompt.indexOf('哪部分是对方的状态，哪部分是我的') >= 0);

var selfPrompt = promptFor('我该不该换工作');
check('问自己的问题不出现主体约束',
  selfPrompt.indexOf('这件事问的是他们') < 0 &&
  selfPrompt.indexOf('这件事里我和另一个人都在场') < 0);

/*
 * 系统提示词原来写着「不要断言任何第三方（对方、同事、家人）的想法、感情」。
 * 用户问「他们互相喜欢吗」时，这条被字面执行就等于禁止回答——模型只好
 * 转去谈提问者自己。现在改成正面的要求：可以答，只是别把解读说成事实。
 */
var sysPrompt = LLM.buildSystemPrompt();
check('系统提示词允许正面回答关于别人的问题',
  sysPrompt.indexOf('用户问的是别人的事') >= 0);
check('系统提示词明确禁止把话题换成「你自己怎么看」',
  sysPrompt.indexOf('绝对不要因为被问的是第三方') >= 0);
check('系统提示词不再一刀切地禁止谈第三方感情',
  sysPrompt.indexOf('不要断言任何第三方') < 0);

// 提示词里不该再有「补充背景」这一节——那个字段已经去掉了
check('提示词不含补充背景小节', richPrompt.indexOf('我补充的背景') < 0);

/*
 * system 提示词必须要求 **verdict 字段**（直接回答）。
 *
 * 这里从前检查的是 `"primer"`（先复述你理解的处境）。那个字段已经删掉了——
 * 它是模型在自言自语，用户不关心模型怎么理解自己的问题，只关心结论。
 * 现在最重要的是「先给答案」，所以断言跟着换到 verdict 上。
 */
var sysPrompt = LLM.buildSystemPrompt();
check('system 要求先给答案（verdict）', sysPrompt.indexOf('"verdict"') >= 0);
check('system 说明答案是整份解读里最重要的部分',
  sysPrompt.indexOf('最重要的部分') >= 0);
check('system 要求出现用户问题里的具体词',
  sysPrompt.indexOf('都要出现用户问题里的具体词') >= 0);
check('system 给了反例和正例',
  sysPrompt.indexOf('反例：') >= 0 && sysPrompt.indexOf('正例：') >= 0);

/*
 * 提示词必须允许「这张牌没有额外信息」。
 *
 * 这是治「硬编凑数」的关键一条：早先 prompt 强迫每张牌都写出独特内容，
 * 十个牌位就得编十条，结果重点被稀释、读起来全是废话。
 * 现在明确允许留白，模型才敢说实话。
 */
check('system 允许「没有额外提示」（不逼模型硬编）',
  sysPrompt.indexOf('没有额外提示') >= 0);
check('system 说明陪衬是正常的',
  sysPrompt.indexOf('陪衬') >= 0);
check('system 限制行动条数（宁少勿滥）',
  sysPrompt.indexOf('凑数是负价值') >= 0);

/* ================================================================== *
 * 7. 引擎层面的张数控制
 *
 * 界面上抽几张由牌阵决定（牌阵有几个牌位就抽几张），所以这一节测的是引擎
 * 自己支持任意张数的能力。留着它有一个实际用处：将来如果要加回「自定义张数」，
 * 引擎这层不需要重做，而且现在就有测试保证它是对的。
 * ================================================================== */

section('引擎层面的张数控制');

[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].forEach(function (n) {
  var s = Engine.prepareFan({ spreadKey: 'three-choice', count: n, question: '张数测试' });
  eq(n + ' 张时 needed = ' + n, s.needed, n);
  check(n + ' 张时扇形仍是整副牌', s.fanOrder.length === 78);

  for (var i = 0; i < n; i++) Engine.takeFromFan(s, 0);
  var r = Engine.finalizeDraw(s);
  eq(n + ' 张收尾后牌数为 ' + n, r.cards.length, n);
  eq(n + ' 张时剩余 ' + (78 - n), r.remaining.length, 78 - n);
});

// 不指定张数时用牌阵的牌位数——这是界面上实际走的那条路径
var noCount = Engine.prepareFan({ spreadKey: 'celtic-cross' });
eq('不指定张数时用牌阵的牌位数', noCount.needed, 10);
var noCount2 = Engine.prepareFan({ spreadKey: 'single' });
eq('单张牌阵不指定张数时为 1', noCount2.needed, 1);
var noCount3 = Engine.prepareFan({ spreadKey: 'cross-five' });
eq('五张牌阵不指定张数时为 5', noCount3.needed, 5);

// 张数超过牌库要报错
throws('张数超过牌库会报错',
  function () { Engine.prepareFan({ spreadKey: 'single', count: 99, deckKey: 'major' }); },
  /牌库只有 22 张/);
var majorTen = Engine.prepareFan({ spreadKey: 'single', count: 22, deckKey: 'major' });
eq('大阿卡纳正好抽满 22 张', majorTen.needed, 22);

// 非法张数退回牌阵牌位数，而不是崩掉
var badCount = Engine.prepareFan({ spreadKey: 'three-time', count: 0 });
eq('张数为 0 时退回牌阵牌位数', badCount.needed, 3);
var badCount2 = Engine.prepareFan({ spreadKey: 'three-time', count: 'abc' });
eq('张数非法时退回牌阵牌位数', badCount2.needed, 3);

// 调用方可以给出自己的牌位（界面上不用，但引擎要支持）
var customS = Engine.prepareFan({ spreadKey: 'three-time', count: 5 });
customS.positions = [
  { title: 'A', asks: 'a', x: 20, y: 45 },
  { title: 'B', asks: 'b', x: 35, y: 45 },
  { title: 'C', asks: 'c', x: 50, y: 45 },
  { title: 'D', asks: 'd', x: 65, y: 45 },
  { title: 'E', asks: 'e', x: 80, y: 45 }
];
for (var ci = 0; ci < 5; ci++) Engine.takeFromFan(customS, 0);
var customR = Engine.finalizeDraw(customS);
eq('自定义牌位被采用', customR.cards.length, 5);
eq('第 1 个牌位名来自自定义', customR.cards[0].position.title, 'A');
eq('第 5 个牌位名来自自定义', customR.cards[4].position.title, 'E');
eq('自定义牌位的坐标被采用', customR.cards[2].position.x, 50);

// 张数少于牌阵时，用牌阵的前 n 个牌位
var shortS = Engine.prepareFan({ spreadKey: 'celtic-cross', count: 3 });
shortS.positions = Spreads.get('celtic-cross').positions.slice(0, 3);
for (var si = 0; si < 3; si++) Engine.takeFromFan(shortS, 0);
var shortR = Engine.finalizeDraw(shortS);
eq('少于牌阵张数时取前几个牌位', shortR.cards.length, 3);
eq('第 1 个仍是「现状」', shortR.cards[0].position.title, '现状');
eq('第 3 个是「根基」', shortR.cards[2].position.title, '根基');

/* ================================================================== *
 * 8. 追加补充牌
 * ================================================================== */

section('追加补充牌');

var bonusBase = drawAuto({ spreadKey: 'three-choice', question: '追加牌测试' });

check('抽牌结果保存了剩余牌序', Array.isArray(bonusBase.remaining));
eq('剩余牌数 = 牌库大小 - 已抽张数', bonusBase.remaining.length, 78 - 3);
eq('已抽集合长度为牌阵张数', bonusBase.drawnIds.length, 3);
check('剩余牌序里的 id 都真实存在', bonusBase.remaining.every(function (id) {
  return Boolean(Cards.get(id));
}));
check('剩余牌序没有重复', bonusBase.remaining.length ===
  bonusBase.remaining.filter(function (id, i) { return bonusBase.remaining.indexOf(id) === i; }).length);
check('剩余牌与已抽牌没有交集', bonusBase.remaining.every(function (id) {
  return bonusBase.drawnIds.indexOf(id) < 0;
}));

var bonus1 = Engine.extraCards(bonusBase, 1);
eq('追加 1 张', bonus1.length, 1);
check('追加的牌带完整牌义', bonus1[0].meaning.text.length > 10);
check('追加的牌带朝向', bonus1[0].orientation === '正位' || bonus1[0].orientation === '逆位');
eq('追加后已抽集合 +1', bonusBase.drawnIds.length, 4);
check('审计信息记录了追加',
  bonusBase.audit.indexOf('追加 1 张') >= 0 && bonusBase.audit.indexOf('熵流偏移') >= 0);

// 最核心的一条：追加的牌不能和桌上已有的重复
var bonusMore = Engine.extraCards(bonusBase, 5);
eq('再追加 5 张', bonusMore.length, 5);
var allDrawn = bonusBase.drawnIds;
check('所有抽出的牌互不重复', allDrawn.length === allDrawn.filter(function (id, i) {
  return allDrawn.indexOf(id) === i;
}).length, allDrawn.length + ' 张里出现重复');
check('追加的牌不在原牌阵里', bonusMore.every(function (item) {
  return bonusBase.cards.every(function (c) { return c.cardId !== item.cardId; });
}));

// 连续追加很多次也不会重复
var manyBase = drawAuto({ spreadKey: 'single' });
var collected = manyBase.cards.map(function (c) { return c.cardId; });
for (var round = 0; round < 20; round++) {
  Engine.extraCards(manyBase, 3).forEach(function (item) { collected.push(item.cardId); });
}
eq('连续追加 20 轮共抽出', collected.length, 1 + 60);
check('连续追加仍不重复', collected.length === collected.filter(function (id, i) {
  return collected.indexOf(id) === i;
}).length);

// 抽完为止
var exhaust = drawAuto({ spreadKey: 'single' });
Engine.extraCards(exhaust, 77);
eq('可以把整副牌抽完', exhaust.drawnIds.length, 78);
eq('抽完后剩余为 0', exhaust.remaining.length, 0);
throws('抽完后追加会报错',
  function () { Engine.extraCards(exhaust, 1); }, /已经抽完/);

// 要得比剩下的多时，只给剩下的
var partial = drawAuto({ spreadKey: 'single' });
var got = Engine.extraCards(partial, 999);
eq('要超量时只给剩下的', got.length, 77);
eq('超量追加后剩余归零', partial.remaining.length, 0);

// 参数与状态校验
throws('张数为 0 会报错', function () { Engine.extraCards(bonusBase, 0); }, /不小于 1/);
throws('张数为负会报错', function () { Engine.extraCards(bonusBase, -2); }, /不小于 1/);
throws('没有剩余牌序的结果会报错',
  function () { Engine.extraCards({ remaining: null, drawnIds: [] }, 1); }, /没有保存剩余牌序/);

// 只用大阿卡纳时，追加的也应当是大牌
var majorBase = drawAuto({ spreadKey: 'single', deckKey: 'major' });
eq('大阿卡纳牌库抽 1 张后剩 21 张', majorBase.remaining.length, 21);

var majorBonus = Engine.extraCards(majorBase, 5);
eq('追加 5 张后剩 16 张', majorBase.remaining.length, 16);
check('大阿卡纳模式下追加的仍是大牌', majorBonus.every(function (item) {
  return item.card.suit === 'major';
}));

section('追加牌的排版与合并');

var celticResult = drawAuto({ spreadKey: 'celtic-cross' });
var layoutBase = celticResult.cards;
// 凯尔特十字最低一张是第 10 位「最终走向」，y=173（四行，每行 55 单位）
var celticLowest = Math.max.apply(null, layoutBase.map(function (c) { return c.position.y; }));
eq('凯尔特十字最低牌位在 y=173', celticLowest, 173);

// 补充牌必须排在牌阵下方，而且要留够一个牌位名的高度
var APPROACH_MIN = 55;
// bonusLayout 是纯函数，直接验坐标
var oneLayout = Render.bonusLayout(1, layoutBase);
eq('排 1 张得到 1 个位置', oneLayout.length, 1);
eq('单张追加牌横向居中', Math.round(oneLayout[0].x), 50);
check('追加牌排在牌阵最低那张之下', oneLayout[0].y > celticLowest,
  oneLayout[0].y + ' 应大于 ' + celticLowest);
check('追加牌与牌阵之间留够一个牌位名的高度',
  oneLayout[0].y - celticLowest >= APPROACH_MIN,
  '实际只差 ' + (oneLayout[0].y - celticLowest) + ' 单位');

/*
 * 一行的容量与横向间距都由当前尺寸现算，所以期望值也从同样的口径推出来，
 * 不写死数字——写死会在换屏幕尺寸时误报（原来写死 7 张，手机上是 5 张）。
 *
 * 牌位名宽取 metrics().captionW，**不在这里另算 cardW * 1.15**：
 * computeMetrics 给 captionW 加了「不能宽于最密列间距」的上限，
 * 测试再算一遍就会和实现脱钩。
 */
var bonusMetrics = Render.metrics();
var bonusSpanPx = (87 - 8) / 100 * bonusMetrics.baseWidth;
var bonusMinStepPx = Math.max(bonusMetrics.captionW + 8, bonusMetrics.cardW + 6);
var bonusPerRow = Math.max(2, Math.floor(bonusSpanPx / bonusMinStepPx));

var sevenLayout = Render.bonusLayout(7, layoutBase);
var sevenInFirstRow = sevenLayout.filter(function (p) { return p.row === 0; }).length;
check('7 张第一行不超过行容量', sevenInFirstRow <= bonusPerRow,
  '第一行 ' + sevenInFirstRow + ' 张，容量 ' + bonusPerRow);
check('第一行左边缘不出界', sevenLayout[0].x >= 6, '最左 x=' + sevenLayout[0].x.toFixed(1));
check('第一行右边缘不出界',
  sevenLayout[sevenInFirstRow - 1].x <= 94,
  '最右 x=' + sevenLayout[sevenInFirstRow - 1].x.toFixed(1));

var tenLayout = Render.bonusLayout(10, layoutBase);
eq('10 张总共 10 个位置', tenLayout.length, 10);
check('第 2 行比第 1 行低', tenLayout[9].y > tenLayout[0].y);

/*
 * 补充牌的行分布必须均衡——每行都 ≥2 张，绝不出现只剩一张的尾巴。
 *
 * 这一条守的是一个很显眼的问题：原来「前面的行排满、余数丢给最后一行」，
 * 于是 10 张排成 3/3/3/1、5 张排成 2/2/1，最后一行孤零零一张，整块看着是歪的。
 * 用户反馈「补充牌抽多了超过十个也要对称」。
 */
[[4], [5], [6], [7], [8], [9], [10], [11], [12], [13], [14], [20], [30]]
  .forEach(function (pair) {
    var n = pair[0];
    var layout = Render.bonusLayout(n, layoutBase);

    var counts = {};
    layout.forEach(function (p) {
      counts[p.row] = (counts[p.row] || 0) + 1;
    });
    var rowCounts = Object.keys(counts).map(Number).sort(function (a, b) { return a - b; })
      .map(function (r) { return counts[r]; });

    var spare = rowCounts.filter(function (c) { return c < 2; });

    eq(n + ' 张不会有只剩一张的行', spare.length, 0,
      '每行张数 ' + rowCounts.join('/'));

    check(n + ' 张每行都不超过行容量', rowCounts.every(function (c) { return c <= bonusPerRow; }),
      '每行张数 ' + rowCounts.join('/') + '，容量 ' + bonusPerRow);

    check(n + ' 张各行张数相差不超过 1', (function () {
      return Math.max.apply(null, rowCounts) - Math.min.apply(null, rowCounts) <= 1;
    })(), '每行张数 ' + rowCounts.join('/'));

    // 每一行都要关于中线对称
    var rowXs = {};
    layout.forEach(function (p) {
      if (!rowXs[p.row]) rowXs[p.row] = [];
      rowXs[p.row].push(p.x);
    });
    var skewed = Object.keys(rowXs).filter(function (r) {
      var xs = rowXs[r];
      var center = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
      return Math.abs(center - 50) > 0.01;
    });
    eq(n + ' 张每一行都居中', skewed.length, 0,
      '歪的行：' + skewed.join(','));
  });

/*
 * 最要紧的一条：一行的牌必须真的放得进牌桌宽度。
 *
 * 这条守的是一个真实 bug——间距按「整张牌桌宽能放几张」算，但一行实际只用
 * 79 个百分点的跨度，于是最右边那张被牌桌边缘裁掉一半。
 */
check('一行排满时最右边缘不越界', (function () {
  var perRow = bonusPerRow;
  var wide = Render.bonusLayout(perRow, layoutBase);
  var maxX = Math.max.apply(null, wide.map(function (p) { return p.x; }));
  var rightEdge = maxX / 100 * bonusMetrics.baseWidth + bonusMetrics.cardW / 2;
  return rightEdge <= bonusMetrics.baseWidth + 0.5;
})(), '行容量 ' + bonusPerRow + ' 张，牌桌宽 ' + bonusMetrics.baseWidth);

// 单张时居中、多张时铺开，但都要在两侧留够空间
var twoLayout = Render.bonusLayout(2, layoutBase);
check('2 张左右对称', Math.abs((twoLayout[0].x + twoLayout[1].x) / 2 - 50) < 0.01,
  twoLayout[0].x + ' / ' + twoLayout[1].x);

// 所有追加牌都必须落在牌阵下方，且横向在牌桌内
var manyLayout = Render.bonusLayout(14, layoutBase);
check('追加牌都在牌阵下方', manyLayout.every(function (p) { return p.y > celticLowest; }));
check('追加牌横向都在牌桌内', manyLayout.every(function (p) {
  return p.x >= 5 && p.x <= 95;
}));
check('同一行内相邻牌间距足够（不会叠在一起）', (function () {
  var byRow = {};
  manyLayout.forEach(function (p) {
    if (!byRow[p.row]) byRow[p.row] = [];
    byRow[p.row].push(p.x);
  });
  return Object.keys(byRow).every(function (row) {
    var xs = byRow[row].sort(function (a, b) { return a - b; });
    for (var i = 1; i < xs.length; i++) {
      if (xs[i] - xs[i - 1] < 11.9) return false;
    }
    return true;
  });
})());

/*
 * 牌位坐标 → 像素：这是渲染时真正用的折算。
 *
 * 这一组以前是**自证型断言**——左边和右边是同一个表达式的两种写法，
 * 恒为真，改坏实现也不会红：
 *   positionToPixels({y:0}).top  ≡  padTop + 0 * pxPerUnit   ≡ metrics().padTop
 *   positionToPixels({x:50}).left ≡  (50/100) * baseWidth    ≡ baseWidth / 2（IEEE754 精确）
 *   10 * pxPerUnit 那条更是精确等于 0，写成 `< 1e-9` 只是看着严谨
 *
 * 现在改成验**相对关系**和**跨视口的行为**——这些才是实现错了会露馅的地方。
 */
var px = Render.positionToPixels({ x: 50, y: 93 });
check('坐标折算成像素：y 越大越靠下', px.top > Render.positionToPixels({ x: 50, y: 10 }).top);

// 横向：x 是从左到右的百分比，三个采样点必须单调递增且中点居中
var pxLeft = Render.positionToPixels({ x: 0, y: 0 }).left;
var pxMid = Render.positionToPixels({ x: 50, y: 0 }).left;
var pxRight = Render.positionToPixels({ x: 100, y: 0 }).left;
check('x 从左到右单调递增', pxLeft < pxMid && pxMid < pxRight,
  pxLeft.toFixed(1) + ' / ' + pxMid.toFixed(1) + ' / ' + pxRight.toFixed(1));
check('x=0 贴着左边缘', Math.abs(pxLeft) < 1e-9, '实际 ' + pxLeft);
check('x=50 正好在中点', Math.abs(pxMid - (pxLeft + pxRight) / 2) < 1e-9,
  '中点是 ' + ((pxLeft + pxRight) / 2).toFixed(3) + '，x=50 算出来是 ' + pxMid.toFixed(3));
check('x 的跨度等于牌桌基准宽', Math.abs((pxRight - pxLeft) - Render.metrics().baseWidth) < 1e-9);

// 纵向：y 是「单位数」，一格就是一行的高度，必须线性
var y0 = Render.positionToPixels({ x: 0, y: 0 }).top;
var y1 = Render.positionToPixels({ x: 0, y: 55 }).top;
var y2 = Render.positionToPixels({ x: 0, y: 110 }).top;
var perUnit = Render.metrics().pxPerUnit;
check('纵向线性：两格的高度差是一格的两倍',
  Math.abs((y2 - y0) - 2 * (y1 - y0)) < 1e-9,
  (y1 - y0).toFixed(4) + ' vs ' + ((y2 - y0) / 2).toFixed(4));
check('一格的高度等于 55 个单位的刻度',
  Math.abs((y1 - y0) - 55 * perUnit) < 1e-9);
check('y=0 落在顶部留白上', Math.abs(y0 - Render.metrics().padTop) < 1e-9);

/*
 * 真正有判别力的一条：**同一套坐标在不同视口下必须换算成不同的像素**。
 *
 * 上面那些相对关系在「刻度算错但内部自洽」时依然成立（比如 pxPerUnit 恒定
 * 不随屏幕变）。跨视口比一次才能证明它真的跟着尺寸走。
 */
var pxBig = Render.setViewportWidth(1024, false);
var bigCardH = pxBig.cardH;
var bigY55 = Render.positionToPixels({ x: 0, y: 55 }).top
  - Render.positionToPixels({ x: 0, y: 0 }).top;

var pxSmall = Render.setViewportWidth(360, true);
var smallCardH = pxSmall.cardH;
var smallY55 = Render.positionToPixels({ x: 0, y: 55 }).top
  - Render.positionToPixels({ x: 0, y: 0 }).top;

check('桌面牌比手机牌大（前提成立）', bigCardH > smallCardH,
  bigCardH + ' vs ' + smallCardH);
check('一格的高度随屏幕缩小', smallY55 < bigY55,
  '手机 ' + smallY55.toFixed(1) + 'px，桌面 ' + bigY55.toFixed(1) + 'px');
// 一格要装下一张牌加它的说明区——这是纵向刻度存在的意义
check('手机上一格装得下一张牌 + 说明区', smallY55 >= smallCardH,
  '一格 ' + smallY55.toFixed(1) + 'px，牌高 ' + smallCardH);
check('桌面上也装得下', bigY55 >= bigCardH,
  '一格 ' + bigY55.toFixed(1) + 'px，牌高 ' + bigCardH);

// 恢复这一节之前的视口
Render.setViewportWidth(savedVw, savedTouch);

/*
 * 异常输入下不能静默出错。
 *
 * 这两条守的是「没有报错、但页面明显不对」的情形——比抛异常更难查：
 *
 *   1. 视口宽度传进 NaN/undefined。不校验的话 baseWidth、cardW、pxPerUnit
 *      会一路变成 NaN，写进 CSS 变量的就是 "NaNpx"（浏览器忽略），
 *      所有卡片退回 CSS 回退尺寸，页面看着像完全没适配，控制台却一片干净。
 *   2. 牌位坐标传进 NaN。算出的 left/top 是 NaN，那张牌被定位到容器外看不见。
 *
 * 期望行为：前者退回一个可用的视口宽度，后者直接抛错当场暴露。
 */
[NaN, undefined, null, 0, -100, Infinity, 'abc'].forEach(function (bad) {
  var m2 = Render.setViewportWidth(bad, true);
  check('视口宽度传 ' + String(bad) + ' 时不会崩塌',
    isFinite(m2.cardW) && m2.cardW > 0,
    'cardW=' + m2.cardW);
});
// 复位到正常视口，免得后面章节受影响
Render.setViewportWidth(1024, false);

[null, undefined, {}, { x: NaN, y: 0 }, { x: 0, y: NaN }, { x: 'a', y: 1 }]
  .forEach(function (bad) {
    var threw = false;
    try {
      Render.positionToPixels(bad);
    } catch (e) {
      threw = true;
    }
    check('非法坐标 ' + JSON.stringify(bad) + ' 会抛错而不是悄悄返回 NaN', threw);
  });

// 合法坐标当然不能受影响
var okPx = Render.positionToPixels({ x: 50, y: 8 });
check('合法坐标照常折算', isFinite(okPx.left) && isFinite(okPx.top),
  JSON.stringify(okPx));

// mergeBonus
var mergeBase = drawAuto({ spreadKey: 'three-time' });
var mergeExtras = Engine.extraCards(mergeBase, 3);
var merged = Render.mergeBonus(mergeBase, mergeExtras);

eq('合并后共 6 张', merged.cards.length, 6);
eq('原牌阵张数不变', mergeBase.cards.length, 3);
eq('合并视图标注了补充牌数量', merged.bonusCount, 3);
check('mergeBonus 不修改原结果', mergeBase.cards.length === 3 && !mergeBase.bonusCount);
check('原牌阵的牌没有被标成补充牌', merged.cards.slice(0, 3).every(function (c) {
  return !c.isBonus;
}));
check('追加的牌被标成补充牌', merged.cards.slice(3).every(function (c) { return c.isBonus; }));
eq('补充牌命名从 1 开始', merged.cards[3].position.title, '补充牌 1');
eq('补充牌 2 的命名', merged.cards[4].position.title, '补充牌 2');
check('补充牌的 asks 明确告诉模型这是用户主动追加的',
  merged.cards[3].position.asks.indexOf('主动要求') >= 0 &&
  merged.cards[3].position.asks.indexOf('不要把它当成牌阵里的一个独立牌位') >= 0);
check('补充牌的 index 接在原牌阵之后', merged.cards[3].index === 3);

// 三张牌阵在 y=45，补充牌应当排在它下方
var baseLowest = Math.max.apply(null, mergeBase.cards.map(function (c) { return c.position.y; }));
check('补充牌排在三张牌阵下方', merged.cards.slice(3).every(function (c) {
  return c.position.y > baseLowest;
}), '底座 y=' + baseLowest + '，补充牌 y=' +
  merged.cards.slice(3).map(function (c) { return c.position.y; }).join(','));

// 没有补充牌时应当原样返回（不复制，省开销）
check('没有补充牌时 mergeBonus 原样返回', Render.mergeBonus(mergeBase, []) === mergeBase);
check('补充牌为空数组时也原样返回', Render.mergeBonus(mergeBase, null) === mergeBase);

// 牌桌尺寸要能容下补充牌
var mergedSize = Render.tableSize(merged);
var baseSize = Render.tableSize(mergeBase);
check('有补充牌时牌桌更高', mergedSize.height > baseSize.height,
  baseSize.height + ' → ' + mergedSize.height);

/*
 * 桌高必须真的装得下最低那张牌（牌心 + 半张牌 + 说明区）。
 *
 * 这三个数**不能写死**。原来用的是 `83 + 40`——那是桌面尺寸（半张牌高 83、
 * 说明区 40），而牌高随屏幕变：手机上是 44.5 + 38。写死之后这几条断言
 * 在手机上会算出一个比桌高还大的需求，必然失败；它们之所以一直全绿，
 * 只是因为 verify.js 从头到尾跑在桌面默认尺寸下。而 verify.js 里没有任何
 * 一处会跨视口跑——**换个屏幕尺寸就发现的错，测试却抓不到**。
 *
 * 现在按当前 metrics 算，并且**逐个视口各验一遍**。
 */
var SIZE_VIEWPORTS = [
  { vw: 360, touch: true, name: '手机 360' },
  { vw: 430, touch: true, name: '手机 430' },
  { vw: 768, touch: true, name: '平板 768' },
  { vw: 1024, touch: false, name: '桌面 1024' }
];

// 记下进入这一节之前的视口，跑完恢复
var savedVw = Render.metrics().viewport;
var savedTouch = Render.metrics().isTouch;

SIZE_VIEWPORTS.forEach(function (vp) {
  Render.setViewportWidth(vp.vw, vp.touch);
  var m = Render.metrics();
  var need = m.cardH / 2 + m.captionBlockH;

  var size = Render.tableSize(Render.mergeBonus(
    drawAuto({ spreadKey: 'three-time' }),
    []
  ));
  var low = 0;
  Render.mergeBonus(drawAuto({ spreadKey: 'three-time' }), []).cards
    .forEach(function (c) {
      var t = Render.positionToPixels(c.position).top;
      if (t > low) low = t;
    });

  check(vp.name + '：桌高装得下最低那张牌（牌心 + 半牌 + 说明区）',
    low + need <= size.height,
    '需要 ' + (low + need).toFixed(1) + '，桌高 ' + size.height);

  // 留白上界用相对量：桌高减去内容，不该超过「一行说明区」那么多
  check(vp.name + '：桌底留白不过量',
    size.height - (low + need) <= m.captionBlockH,
    '多出 ' + (size.height - (low + need)).toFixed(1) +
    'px（说明区 ' + m.captionBlockH.toFixed(1) + 'px）');
});

// 补很多张时，桌子要逐行加高（跨视口）
SIZE_VIEWPORTS.forEach(function (vp) {
  Render.setViewportWidth(vp.vw, vp.touch);
  var m = Render.metrics();
  var need = m.cardH / 2 + m.captionBlockH;

  var base = drawAuto({ spreadKey: 'single' });
  var fat = Render.mergeBonus(base, Engine.extraCards(base, 15));
  eq(vp.name + '：补 15 张共 16 张', fat.cards.length, 16);

  var fatSize = Render.tableSize(fat);
  check(vp.name + '：补 15 张后桌子明显更高', fatSize.height > Render.tableSize(base).height,
    Render.tableSize(base).height + ' → ' + fatSize.height);

  var fatLow = 0;
  fat.cards.forEach(function (c) {
    var t = Render.positionToPixels(c.position).top;
    if (t > fatLow) fatLow = t;
  });
  check(vp.name + '：补 15 张时最低那张牌仍装得下',
    fatLow + need <= fatSize.height,
    '需要 ' + (fatLow + need).toFixed(1) + '，桌高 ' + fatSize.height);
});

// 恢复原视口，后面的章节依赖它
Render.setViewportWidth(savedVw, savedTouch);

/* ================================================================== *
 * 5. 引文核对（对抗性测试）
 * ================================================================== */

section('引文核对 · 对抗性');

var wheel = Cards.get('major-10'); // 命运之轮
var sampleSource = wheel.up;

check('原文片段能匹配', LLM.quoteMatches(sampleSource.slice(0, 20), sampleSource));
check('去掉标点后仍能匹配',
  LLM.quoteMatches('一个不由你单方面决定的转折点到了', sampleSource));
check('插入空格后仍能匹配',
  LLM.quoteMatches('一个 不由你 单方面决定 的转折点到了', sampleSource));
check('省略号差异能容忍',
  LLM.quoteMatches('一个不由你单方面决定的转折点到了，通常向好。', sampleSource));

// 以下都必须失败
check('改词后不匹配', !LLM.quoteMatches('一个不由你单方面决定的变化点到了', sampleSource));
check('拼接两段不匹配',
  !LLM.quoteMatches('一个不由你单方面决定的转折点到了事情开始松动', sampleSource));
check('语序颠倒不匹配',
  !LLM.quoteMatches('通常向好，一个不由你单方面决定的转折点到了', sampleSource));
check('凭空创作不匹配', !LLM.quoteMatches('命运的车轮正在为你转动，转机即将出现', sampleSource));
check('过于简短的引文不通过',
  !LLM.quoteMatches('一个不', sampleSource));
check('空引文不通过', !LLM.quoteMatches('', sampleSource));
check('只有标点不通过', !LLM.quoteMatches('，。、', sampleSource));
check('非字符串不通过', !LLM.quoteMatches(null, sampleSource));

// 逆位牌义应当用逆位原文来核对
var reversedQuote = wheel.rev.slice(0, 15);
check('逆位原文能匹配逆位牌义', LLM.quoteMatches(reversedQuote, wheel.rev));
check('逆位引文匹配不到正位牌义（除非文字重合）',
  LLM.quoteMatches('循环没有打破，同一类事情又来一次', wheel.rev));
check('正位引文在逆位里找不到时判定为假',
  !LLM.quoteMatches('顺势比用力更有效，别硬推', wheel.rev) ||
  wheel.rev.indexOf('顺势比用力更有效，别硬推') >= 0);

// 全牌库遍历：每张牌的正位与逆位原文，取中间一段都应当能自匹配
var selfMatchFailures = [];
Cards.deck.forEach(function (card) {
  [[card.up, 'up'], [card.rev, 'rev']].forEach(function (pair) {
    var text = pair[0];
    var middle = text.slice(Math.floor(text.length / 3), Math.floor(text.length / 3) + 15);
    if (!LLM.quoteMatches(middle, text)) selfMatchFailures.push(card.id + '/' + pair[1]);
  });
});
eq('全牌库 156 段牌义的自匹配全部通过', selfMatchFailures.length, 0);

/* ================================================================== *
 * 6. 返回解析容错
 * ================================================================== */

section('返回解析容错');

var goodJson = '{"overview":"测试","cards":[],"synthesis":"x","actions":[],"watchOut":"y"}';
eq('直接解析纯 JSON', LLM.parseJsonLoose(goodJson).overview, '测试');
eq('解析带 ```json 围栏的返回',
  LLM.parseJsonLoose('```json\n' + goodJson + '\n```').overview, '测试');
eq('解析带 ``` 围栏的返回',
  LLM.parseJsonLoose('```\n' + goodJson + '\n```').overview, '测试');
eq('解析带前置说明的返回',
  LLM.parseJsonLoose('好的，这是解读：\n' + goodJson).overview, '测试');
eq('解析带后置说明的返回',
  LLM.parseJsonLoose(goodJson + '\n希望有帮助！').overview, '测试');
eq('解析嵌套对象', LLM.parseJsonLoose('{"a":{"b":{"c":1}}}').a.b.c, 1);

// 字符串里出现花括号不能干扰配平
eq('字符串内的花括号不影响配平',
  LLM.parseJsonLoose('{"text":"这里有 { 和 } 两个符号"}').text, '这里有 { 和 } 两个符号');
eq('转义引号不影响配平',
  LLM.parseJsonLoose('{"text":"他说\\"你好\\""}').text, '他说"你好"');

throws('空返回会报错', function () { LLM.parseJsonLoose(''); }, /空内容/);
throws('非 JSON 会报错', function () { LLM.parseJsonLoose('这不是 JSON'); }, /JSON/);
throws('截断的 JSON 会报错', function () { LLM.parseJsonLoose('{"overview":"没写完'); }, /JSON/);
eq('extractFirstObject 能取出配平对象',
  LLM.extractFirstObject('前缀 {"a":1} 后缀'), '{"a":1}');
eq('extractFirstObject 对不配平返回 null',
  LLM.extractFirstObject('{"a":1'), null);

/* ================================================================== *
 * 7. 解读结果规范化
 * ================================================================== */

section('解读结果规范化');

function buildResult(spreadKey) {
  return drawAuto({ spreadKey: spreadKey, question: '规范化测试' });
}

var normResult = buildResult('three-time');
var goodReading = {
  primer: '你卡住的不是表面那件事，而是既要又要。',
  overview: '总览内容',
  cards: normResult.cards.map(function (item, i) {
    return {
      index: i + 1,
      position: item.position.title,
      quote: item.card.up.slice(2, 20),
      reading: '第 ' + (i + 1) + ' 个牌位的解读',
      action: '可以做的一件事'
    };
  }),
  synthesis: '综合解读',
  actions: ['行动一', '行动二', '行动三'],
  watchOut: '不确定之处'
};

var normalized = LLM.normalizeReading(goodReading, normResult);
eq('牌位数与抽牌一致', normalized.reading.cards.length, 3);
eq('没有发现问题', normalized.issues.length, 0, JSON.stringify(normalized.issues));
eq('引文全部核对通过', normalized.quoteStats.ok, 3);
eq('引文核对总数', normalized.quoteStats.total, 3);
eq('行动清单保留', normalized.reading.actions.length, 3);
eq('牌位名对齐', normalized.reading.cards[0].position, normResult.cards[0].position.title);

/*
 * 引文摘自「传统建议」而不是「牌义原文」时，要能分辨出来。
 *
 * 提示词里牌义原文和传统建议是并排给的（formatSpreadForPrompt 两样都给），
 * 模型偶尔会摘错段落。这类引文**一字不差**，只是引错了地方——说成
 * 「模型记串了牌」是冤枉，用户会因此怀疑一整段本来准确的解读。
 *
 * 测试需要的是一张「建议」和「牌义」不重叠的牌，抽到什么牌是随机的，
 * 所以重抽到满足条件为止，并把「抽到了没有」也做成一条断言——
 * 万一以后牌库改动让这个条件永远不成立，这里会红，而不是悄悄少测两项。
 */
var adviceResult = null;
var adviceItem = -1;
var adviceQuote = '';
for (var adviceTry = 0; adviceTry < 8 && adviceItem < 0; adviceTry++) {
  var candidate = drawAuto({ spreadKey: 'three-time', question: '摘错段落测试' });
  for (var ci = 0; ci < candidate.cards.length; ci++) {
    var cc = candidate.cards[ci].card;
    var head = cc.advice.slice(0, 18);
    if (head.length >= 12 && cc.up.indexOf(head) < 0 && cc.rev.indexOf(head) < 0) {
      adviceResult = candidate;
      adviceItem = ci;
      adviceQuote = head;
      break;
    }
  }
}
adviceResult = adviceResult || drawAuto({ spreadKey: 'three-time', question: '摘错段落测试' });
check('找到一张「建议」与「牌义」不重叠的牌用于测试', adviceItem >= 0);

if (adviceItem >= 0) {
  var advicePayload = {
    verdict: '能。',
    cards: adviceResult.cards.map(function (item, i) {
      return {
        index: i + 1,
        position: item.position.title,
        // 只有目标牌位摘错段落，其余留空，避免干扰
        quote: i === adviceItem ? adviceQuote : '',
        reading: '第 ' + (i + 1) + ' 个牌位的解读'
      };
    }),
    actions: ['行动一', '行动二', '行动三']
  };
  var adviceNorm = LLM.normalizeReading(advicePayload, adviceResult);
  var adviceRecord = adviceNorm.reading.cards[adviceItem];
  check('摘错段落的引文不算核对通过', adviceRecord.quoteOk === false,
    'quoteOk=' + adviceRecord.quoteOk);
  check('摘错段落的引文标为「出自建议」', adviceRecord.quoteFromAdvice === true,
    'fromAdvice=' + adviceRecord.quoteFromAdvice + ' quote=' + adviceQuote);
}

/*
 * 解读记录里要带上**这张牌本身的含义**，而且是按当前朝向的那一份。
 *
 * 界面上每张牌先显示「这张牌的意思（正位/逆位）」再显示「针对你的问题」——
 * 用户明确要求过这个顺序。meaning 来自本地牌库而不是模型，
 * 所以模型记错牌也不影响这一块的正确性（这正是引文核对要防的那类错误）。
 */
check('解读记录带上了牌本身的含义',
  Boolean(normalized.reading.cards[0].meaning) &&
  normalized.reading.cards[0].meaning.text.length > 10,
  JSON.stringify(normalized.reading.cards[0].meaning && normalized.reading.cards[0].meaning.text));
eq('带的牌义是当前朝向那一份（正位取 up、逆位取 rev）',
  normalized.reading.cards[0].meaning.text, normResult.cards[0].meaning.text);
check('牌义关键词也带上了',
  Array.isArray(normalized.reading.cards[0].meaning.keywords) &&
  normalized.reading.cards[0].meaning.keywords.length > 0);

// 模型少给一个牌位
var missingCard = JSON.parse(JSON.stringify(goodReading));
missingCard.cards.splice(1, 1);
var missingNorm = LLM.normalizeReading(missingCard, normResult);
eq('缺牌位时仍然输出 3 条（按本地牌位对齐）', missingNorm.reading.cards.length, 3);
check('缺牌位会被记入问题', missingNorm.issues.some(function (t) { return /缺少第 2 个牌位/.test(t); }),
  JSON.stringify(missingNorm.issues));
eq('缺失的那条解读为空', missingNorm.reading.cards[1].reading, '');

// 模型顺序搞乱
var shuffledReading = JSON.parse(JSON.stringify(goodReading));
shuffledReading.cards.reverse();
var shuffledNorm = LLM.normalizeReading(shuffledReading, normResult);
eq('顺序错乱时仍按 index 归位', shuffledNorm.reading.cards[0].reading, '第 1 个牌位的解读');

// 牌位名写错
var wrongName = JSON.parse(JSON.stringify(goodReading));
wrongName.cards[0].position = '未来的走向';
var wrongNorm = LLM.normalizeReading(wrongName, normResult);
check('牌位名不一致会被标出', wrongNorm.reading.cards[0].positionMismatch);
check('牌位名不一致记入问题', wrongNorm.issues.some(function (t) { return /牌位名不一致/.test(t); }));

// 引文编造
var fakeQuote = JSON.parse(JSON.stringify(goodReading));
fakeQuote.cards[0].quote = '命运之轮已经开始转动，你会在近期遇到重要的人';
var fakeNorm = LLM.normalizeReading(fakeQuote, normResult);
eq('编造引文时核对不通过', fakeNorm.quoteStats.ok, 2);
check('编造的引文被标记', fakeNorm.reading.cards[0].quoteOk === false);

/*
 * 引文用了另一张牌的原文。
 *
 * 这里必须**动态**挑一张与第 1 个牌位不同的牌，不能写死某一张。
 * 写死会踩到随机性：如果抽出来的第 1 张恰好就是它，引用就变成合法的，
 * 测试自己会偶发失败。这是个真实的坑——这条断言曾经写死「高塔」，
 * 于是大约 1/78 的概率误报。
 */
var crossQuote = JSON.parse(JSON.stringify(goodReading));
var firstCardId = normResult.cards[0].card.id;
var otherCard = null;
Cards.deck.forEach(function (card) {
  if (!otherCard && card.id !== firstCardId) otherCard = card;
});
crossQuote.cards[0].quote = otherCard.up.slice(2, 20);
var crossNorm = LLM.normalizeReading(crossQuote, normResult);
check('引用他牌原文会被判为不通过', crossNorm.reading.cards[0].quoteOk === false,
  '引用的是「' + otherCard.name + '」，第 1 个牌位是「' +
  normResult.cards[0].card.name + '」');

/*
 * 缺字段时的行为。
 *
 * 字段结构从六个减到三个（verdict / cards / actions），所以这里检查的字段名
 * 也跟着换。**不再检查 watchOut / overview / synthesis** —— 它们已经不存在了，
 * 缺了不是问题。
 */
var bareReading = LLM.normalizeReading({}, normResult);
check('空对象不抛错', bareReading.reading.cards.length === 3);
check('缺 verdict 记入问题', bareReading.issues.some(function (t) { return /verdict/.test(t); }));
check('缺 actions 记入问题', bareReading.issues.some(function (t) { return /actions/.test(t); }));
check('空对象时 verdict 是空串（不是 undefined）',
  bareReading.reading.verdict === '', JSON.stringify(bareReading.reading.verdict));

// actions 写成换行字符串
var stringActions = JSON.parse(JSON.stringify(goodReading));
stringActions.actions = '第一步\n第二步\n第三步';
eq('actions 为字符串时按行拆分', LLM.normalizeReading(stringActions, normResult).reading.actions.length, 3);

// actions 数组里有空值
var dirtyActions = JSON.parse(JSON.stringify(goodReading));
dirtyActions.actions = ['有用的', '', null, '  '];
eq('actions 里的空值被过滤', LLM.normalizeReading(dirtyActions, normResult).reading.actions.length, 1);

throws('非对象返回会报错', function () { LLM.normalizeReading('字符串', normResult); }, /JSON 对象/);

/* ================================================================== *
 * 8. 接口地址处理
 * ================================================================== */

section('接口地址处理');

eq('补全 /v1',
  LLM.endpointOf('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
eq('已有 /v1 不重复添加',
  LLM.endpointOf('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
eq('去掉尾部斜杠',
  LLM.endpointOf('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
eq('支持 /v2 等其他版本',
  LLM.endpointOf('https://example.com/v2'), 'https://example.com/v2/chat/completions');
eq('支持本机地址',
  LLM.endpointOf('http://localhost:11434'), 'http://localhost:11434/v1/chat/completions');
eq('支持带端口的自定义路径',
  LLM.endpointOf('http://127.0.0.1:8080/api'), 'http://127.0.0.1:8080/api/v1/chat/completions');

throws('空地址报错', function () { LLM.endpointOf(''); }, /接口地址/);
throws('缺协议头报错', function () { LLM.endpointOf('api.deepseek.com'); }, /http/);

/* ================================================================== *
 * 9. DOM 渲染（用最小 DOM 替身验证布局与安全）
 * ================================================================== */

section('DOM 渲染 · 布局与安全');

var doc = createFakeDocument();
globalThis.document = doc;

function makeResult(spreadKey) {
  return drawAuto({ spreadKey: spreadKey, question: '渲染测试' });
}

// 9.1 牌桌尺寸：牌位必须落在桌面范围内
['single', 'three-time', 'three-choice', 'cross-five', 'relationship', 'celtic-cross']
  .forEach(function (key) {
    var result = makeResult(key);
    var size = Render.tableSize(result);
    var id = 'surface-' + key;
    var surface = doc.createElement('div');
    surface.id = id;
    Render.renderTable(surface, result, { onCardClick: function () {} });

    /*
     * 牌桌宽度必须**正好等于基准宽**。
     *
     * 这一条守着一个很显眼的偏移：早先 tableSize 会按「最右侧牌的边缘 + 14」
     * 去撑宽，而基准宽是容器可用宽度——两者不一致时牌桌就比容器窄，
     * 块级元素默认左对齐，右侧多出一截空白，看着就是「整块靠左」。
     *
     * 相等还保证了一件事：x 坐标是相对基准宽的百分比，牌桌宽度等于基准宽，
     * 坐标才精确落在牌桌上，内容才会居中。
     */
    eq(key + ' 牌桌宽度等于基准宽', size.width, Render.metrics().baseWidth);

    eq(key + ' 渲染出 ' + result.cards.length + ' 个牌位', surface.children.length, result.cards.length);
    // 桌面高度由内容决定：单张牌阵只要 259px，凯尔特十字要 900px 以上。
    // 所以下限按「装得下最低那张牌 + 它的牌位名」来验，而不是写死一个数。
    var lowest = 0;
    result.cards.forEach(function (item) {
      var top = Render.positionToPixels(item.position).top;
      if (top > lowest) lowest = top;
    });
    check(key + ' 桌面尺寸合理', size.width >= 880 && size.height >= lowest + 83 + 40,
      size.width + 'x' + size.height + '（最低牌心 ' + lowest.toFixed(0) + '）');
  });

/*
 * 9.2 牌位横向不越界。
 *
 * 这里**只验横向**，纵向的越界在本文件里验不了——原因是循环依赖：
 * tableSize 的高度定义就是「最低那张牌的中心 + 说明区 + 16」，
 * 也就是说桌高跟着最低的牌走。拿桌高去判「牌是不是在桌内」，
 * 无论把 y 写到多大都恒为 false，等于没验。
 *
 * （纵向的排版正确性由 verify-layout.js 负责：那里用真实渲染出的元素矩形
 *   两两比对，不依赖桌高，因而是有效的。）
 *
 * 横向不循环：tableSize 的宽度是 baseWidth（固定值，不随内容变），
 * 所以「牌的矩形是否落在宽度内」是真检查。
 *
 * 历史教训：这一节原来写的是 `cy = size.padTop + (pos.y / 100) * size.span`，
 * 而 tableSize 从来没返回过 `span`（取到 undefined），pos.y 也不是百分比。
 * cy 恒为 NaN，NaN 的比较一律为 false，于是「没有越界的牌位」这条断言
 * **永远通过**——看着有 12 条断言，实际一条都没验。
 * 所以下面同时断言「判定确实逐个跑过」，避免再出现「条件恒假 → 空集合 → 通过」。
 */
Spreads.all.forEach(function (spread) {
  var size = Render.tableSize(makeResult(spread.key));
  var m = Render.metrics();
  var halfW = m.cardW / 2;

  var checked = 0;
  var over = spread.positions.filter(function (pos) {
    var px = Render.positionToPixels(pos);
    checked++;
    return px.left - halfW < 0 || px.left + halfW > size.width;
  });

  eq(spread.key + ' 的越界判定覆盖了每个牌位', checked, spread.positions.length);
  eq(spread.key + ' 没有横向越界的牌位', over.length, 0,
    over.map(function (p) { return p.title; }).join('、'));
});

// 9.2b 桌高要装得下最低那个牌位的说明区（牌名 + 朝向标签）
Spreads.all.forEach(function (spread) {
  var size = Render.tableSize(makeResult(spread.key));
  var m = Render.metrics();

  var lowestBottom = 0;
  spread.positions.forEach(function (pos) {
    var px = Render.positionToPixels(pos);
    var bottom = px.top + m.cardH / 2 + m.captionBlockH;
    if (bottom > lowestBottom) lowestBottom = bottom;
  });

  check(spread.key + ' 的桌高装得下最低的牌位名',
    lowestBottom <= size.height,
    '说明区底 ' + lowestBottom.toFixed(0) + '，桌高 ' + size.height);
});

// 9.3 牌面内容
var oneResult = makeResult('single');
var oneSurface = doc.createElement('div');
Render.renderTable(oneSurface, oneResult, { onCardClick: function () {} });
var slot = oneSurface.children[0];
check('牌位带位置样式', slot.style.left === oneResult.cards[0].position.x + '%');
check('牌位带纵向位置', /px$/.test(slot.style.top));
check('牌位渲染了牌面', slot.textContent.indexOf(oneResult.cards[0].card.name) >= 0);
check('牌位渲染了朝向标签', slot.textContent.indexOf(oneResult.cards[0].orientation) >= 0);
eq('单张牌阵的牌位名', slot.textContent.indexOf('此刻的核心') >= 0, true);

// 9.4 逆位类名
var revResult = makeResult('single');
revResult.cards[0].reversed = true;
revResult.cards[0].orientation = '逆位';
var revSurface = doc.createElement('div');
Render.renderTable(revSurface, revResult, { onCardClick: function () {} });
check('逆位牌带 is-reversed 类', revSurface.children[0].className.indexOf('is-reversed') >= 0);

// 9.5 XSS：模型返回里的脚本不能变成元素
var xssPayload = {
  reading: {
    /*
     * 每个「会被渲染出来的字段」都塞一段恶意文本。
     *
     * 字段结构改成 verdict / gist / reading / actions 之后，这里也要跟着换——
     * 旧数据里塞在 overview / synthesis / watchOut 上的恶意文本现在根本不会被
     * 渲染（那几个字段已经不给用户看了），测试就变成了空转：
     * 断言「恶意文本原样保留」时找不到它，不是因为转义对了，而是因为它没被渲染。
     */
    verdict: '<img src=x onerror=alert(1)>',
    cards: [{
      index: 1, position: '此刻的核心',
      quote: '<script>alert(2)</script>',
      gist: '<em>斜体摘要</em>',
      reading: '<b>加粗</b>',
      quoteOk: false, orientation: '正位', cardName: '愚者'
    }],
    actions: ['<a href="javascript:alert(4)">点我</a>']
  },
  result: oneResult,
  quoteStats: { ok: 0, total: 1 },
  issues: ['<img src=x onerror=alert(5)>'],
  usage: null
};

var readingContainer = doc.createElement('div');
Render.renderReading(readingContainer, xssPayload, {});

var dangerous = ['img', 'script', 'b', 'em', 'iframe', 'svg', 'a', 'style'];
var foundElements = [];
(function walk(node) {
  (node.children || []).forEach(function (child) {
    if (dangerous.indexOf(child.tagName.toLowerCase()) >= 0) foundElements.push(child.tagName);
    walk(child);
  });
})(readingContainer);
eq('模型返回里的 HTML 标签没有变成元素', foundElements.length, 0);

var flat = flatten(readingContainer);
check('结论里的恶意文本被当作文本原样保留',
  flat.indexOf('<img src=x onerror=alert(1)>') >= 0, flat.slice(0, 120));
check('引文里的脚本标签以文本形式出现',
  flat.indexOf('<script>alert(2)</script>') >= 0);
check('摘要里的标签也是文本',
  flat.indexOf('<em>斜体摘要</em>') >= 0);
check('解读正文里的标签也是文本',
  flat.indexOf('<b>加粗</b>') >= 0);
check('行动里的 javascript: 链接是文本不是可点的元素',
  flat.indexOf('<a href="javascript:alert(4)">点我</a>') >= 0 && foundElements.length === 0);

function flatten(node) {
  var out = node.textContent || '';
  (node.children || []).forEach(function (child) { out += flatten(child); });
  return out;
}

// 9.6 引文核对结果要体现在文案上：通过与否必须给出不同的话。
// 同一个 payload 只翻 quoteOk 一个开关，两种文案应当互斥出现。
var passPayload = JSON.parse(JSON.stringify(xssPayload));
passPayload.reading.cards[0].quoteOk = true;
passPayload.quoteStats = { ok: 1, total: 1 };
var passContainer = doc.createElement('div');
Render.renderReading(passContainer, passPayload, {});
var passText = flatten(passContainer);
check('核对通过时显示「已核对」', passText.indexOf('已核对') >= 0);
check('核对通过时不出现过不了的字样', passText.indexOf('未通过核对') < 0);

var failPayload = JSON.parse(JSON.stringify(xssPayload));
failPayload.reading.cards[0].quoteOk = false;
failPayload.quoteStats = { ok: 0, total: 1 };
var failContainer = doc.createElement('div');
Render.renderReading(failContainer, failPayload, {});
var failText = flatten(failContainer);
check('核对不通过时显示提示', failText.indexOf('未通过核对') >= 0);
check('核对不通过时不出现「已核对」', failText.indexOf('已核对') < 0);
check('核对条给出比例', failText.indexOf('引文核对 0/1') >= 0);

/*
 * 9.6b 「模型一条引文都没给」是另一种情况，文案必须区分开。
 *
 * quoteStats.checked 是**真正给了引文的牌位数**，可能小于 total。
 * checked === 0 意味着页面上一个标红都没有（牌面只在有引文时才渲染引文块），
 * 这时如果说「标红的牌位说明引用的原文对不上」，就是让用户去找不存在的东西，
 * 而且把「模型偷懒没给引用」误报成「模型编造引用」——后者是更严重的指控。
 */
var noQuotePayload = JSON.parse(JSON.stringify(xssPayload));
noQuotePayload.quoteStats = { ok: 0, total: 3, checked: 0 };
var noQuoteContainer = doc.createElement('div');
Render.renderReading(noQuoteContainer, noQuotePayload, {});
var noQuoteText = flatten(noQuoteContainer);

check('一条引文都没给时明确说「没有给出引文」',
  noQuoteText.indexOf('没有给出引文') >= 0, noQuoteText.slice(0, 120));
check('一条引文都没给时不提「标红」（页面上并没有标红）',
  noQuoteText.indexOf('标红') < 0, noQuoteText.slice(0, 120));

// 部分给了引文时，要说明有几个牌位没给
var partialPayload = JSON.parse(JSON.stringify(xssPayload));
partialPayload.quoteStats = { ok: 1, total: 3, checked: 2 };
var partialContainer = doc.createElement('div');
Render.renderReading(partialContainer, partialPayload, {});
var partialText = flatten(partialContainer);
check('部分给引文时按「给了的」算比例', partialText.indexOf('引文核对 1/2') >= 0,
  partialText.slice(0, 120));
check('部分给引文时说明有几个牌位没给',
  partialText.indexOf('1 个牌位未给引文') >= 0, partialText.slice(0, 120));

// 9.7 历史记录渲染
var historyContainer = doc.createElement('div');
Render.renderHistory(historyContainer, [], {});
check('空历史显示提示', flatten(historyContainer).indexOf('还没有记录') >= 0);

Render.renderHistory(historyContainer, [{
  id: 'abcd1234', at: new Date().toISOString(), question: '历史问题',
  spreadName: '单张牌', deckLabel: '完整 78 张',
  cards: [{ positionTitle: '此刻的核心', cardName: '愚者', orientation: '正位' }]
}], {
  onRestore: function () {}, onExport: function () {}, onDelete: function () {}
});
eq('历史记录渲染出一条', historyContainer.children.length, 1);
check('历史记录显示问题', flatten(historyContainer).indexOf('历史问题') >= 0);
check('历史记录显示牌名', flatten(historyContainer).indexOf('愚者正位') >= 0);

// 9.8 牌义弹窗渲染
var detailContainer = doc.createElement('div');
Render.renderCardDetail(detailContainer, {
  card: Cards.get('major-18'),
  reversed: true,
  orientation: '逆位',
  position: { title: '现状', asks: '这件事目前的真实样子。' }
});
var detailText = flatten(detailContainer);
check('牌义弹窗含牌名', detailText.indexOf('月亮') >= 0);
check('牌义弹窗含逆位牌义', detailText.indexOf(Cards.get('major-18').rev.slice(0, 10)) >= 0);
check('牌义弹窗同时给出另一朝向', detailText.indexOf('另一种朝向') >= 0);

// 9.9 示例问题
var exampleContainer = doc.createElement('div');
Render.renderExamples(exampleContainer, function () {});
eq('示例问题渲染完整', exampleContainer.children.length, Render.examples.length);

/* ================================================================== *
 * 10. 导出文本
 * ================================================================== */

section('导出文本');

require(path.join(BASE, 'app.js'));
var App = Tarot.App;

var exportResult = drawAuto({ spreadKey: 'three-time', question: '导出测试的问题' });
var exportText = App.buildExportText(exportResult, null);

check('导出包含问题', exportText.indexOf('导出测试的问题') >= 0);
check('导出包含牌阵名', exportText.indexOf('三张牌') >= 0);
check('导出包含抽牌编号', exportText.indexOf(exportResult.id) >= 0);
check('导出包含随机源说明', exportText.indexOf('拒绝采样') >= 0);
check('导出包含免责说明', exportText.indexOf('不预测未来') >= 0);
exportResult.cards.forEach(function (item) {
  check('导出包含牌位 ' + item.position.title, exportText.indexOf(item.position.title) >= 0);
  check('导出包含牌名 ' + item.card.name, exportText.indexOf(item.card.name) >= 0);
});
check('没有解读时明确说明', exportText.indexOf('没有生成 AI 解读') >= 0);

var withReadingText = App.buildExportText(exportResult, {
  reading: normalized.reading,
  quoteStats: { ok: 2, total: 3 },
  issues: ['缺少第 2 个牌位（现在）的解读'],
  usage: { total_tokens: 1234 }
});
check('导出包含引文核对结果', withReadingText.indexOf('引文核对：2/3') >= 0);
check('导出包含结论', withReadingText.indexOf('【结论】') >= 0);
check('导出包含校验问题', withReadingText.indexOf('校验发现的问题') >= 0);

/*
 * 导出的**段落顺序**必须和界面一致。
 *
 * 这两条以前完全没有——所有导出断言都是 indexOf，位置无关。
 * 结果就是顺序改过两次（结论→行动→每张牌 改成 结论→每张牌→行动），
 * 导出这边一次都没跟上，直到有人逐字比对才发现。
 *
 * 界面顺序由 renderReading 定：结论 → 每张牌 → 行动 → 元信息。
 * 元信息（引文核对）必须排在最后，不能跑到结论前面去。
 */
(function () {
  function at(marker) { return withReadingText.indexOf(marker); }
  var iVerdict = at('【结论】');
  var iCards = at('【每张牌说了什么】');
  var iActions = at('【可以去做的事】');
  var iQuote = at('引文核对：');

  check('导出段序：结论在最前', iVerdict >= 0 && iVerdict < iCards && iVerdict < iActions,
    '结论@' + iVerdict + ' 每张牌@' + iCards + ' 行动@' + iActions);
  check('导出段序：每张牌排在行动之前', iCards >= 0 && iCards < iActions,
    '每张牌@' + iCards + ' 行动@' + iActions);
  check('导出段序：引文核对排在最后（和界面元信息的位置一致）',
    iQuote > iVerdict && iQuote > iCards && iQuote > iActions,
    '引文核对@' + iQuote + '，结论@' + iVerdict + ' 每张牌@' + iCards + ' 行动@' + iActions);

  /*
   * 牌义不能在导出里出现两次。
   *
   * 「抽到的牌」那一段本来就逐张列了关键词/牌义/传统建议；解读那一段
   * 再加一份的话，整份导出有近一半篇幅是重复的（实测凯尔特十字里
   * 两段牌义占了 46.8%）。
   */
  var meaningCount = (withReadingText.match(/   牌义：/g) || []).length;
  var meaningCount2 = (withReadingText.match(/   这张牌的意思（/g) || []).length;
  check('牌义只印一次', meaningCount > 0 && meaningCount2 === 0,
    '「牌义：」出现 ' + meaningCount + ' 次，「这张牌的意思（」出现 ' + meaningCount2 + ' 次');
})();

// 历史记录还原
var record = {
  id: 'deadbeefdeadbeef', at: new Date().toISOString(), question: '还原测试',
  spreadKey: 'celtic-cross', spreadName: '凯尔特十字', deckKey: 'full', deckLabel: '完整 78 张',
  cards: exportResult.cards.map(function (item) {
    return {
      cardId: item.cardId, cardName: item.card.name, reversed: item.reversed,
      orientation: item.orientation, positionTitle: item.position.title
    };
  })
};
var restored = App.rehydrate({
  id: 'deadbeefdeadbeef', at: new Date().toISOString(), question: '还原测试',
  spreadKey: 'three-time', spreadName: '三张牌 · 时间流', deckKey: 'full', deckLabel: '完整 78 张',
  cards: exportResult.cards.map(function (item) {
    return {
      cardId: item.cardId, cardName: item.card.name, reversed: item.reversed,
      orientation: item.orientation, positionTitle: item.position.title
    };
  })
});
eq('还原后牌数一致', restored.cards.length, 3);
eq('还原后牌义从本地牌库重新取', restored.cards[0].meaning.text,
  Cards.meaning(Cards.get(restored.cards[0].cardId), restored.cards[0].reversed).text);
check('还原后牌位带 asks', typeof restored.cards[0].position.asks === 'string' &&
  restored.cards[0].position.asks.length > 0);
check('还原后仍能导出', App.buildExportText(restored, null).indexOf('还原测试') >= 0);

// 文件名
var filename = App.filenameFor(exportResult);
check('文件名以 .txt 结尾', /\.txt$/.test(filename), filename);
check('文件名含日期', /\d{8}-\d{4}/.test(filename), filename);

/* ================================================================== *
 * 11. 提示词完整性
 * ================================================================== */

section('提示词完整性');

var promptResult = drawAuto({ spreadKey: 'celtic-cross', question: '提示词测试问题' });
var system = LLM.buildSystemPrompt();
var user = LLM.buildUserPrompt(promptResult);

check('system 提示词要求只输出 JSON', system.indexOf('只输出 JSON') >= 0);
check('system 提示词要求精确引用', system.indexOf('原样摘取') >= 0);
check('system 提示词禁止复述牌义', system.indexOf('不要复述牌义') >= 0);
check('system 提示词声明塔罗无预测力', system.indexOf('没有预测力') >= 0);
/*
 * 这里原来是「不许断言任何第三方（对方、同事、家人）的想法、感情」。
 *
 * 那句话本身没错，但被模型字面执行时就是另一回事：用户问「他们互相喜欢吗」，
 * 系统提示词等于禁止回答，模型只好把话题换回提问者自己——这正是用户在
 * m03120 报的那个 bug。所以要求改成正面的：可以答别人的事，只是要把话
 * 留在「牌面显示 / 看上去」的层面，不许说成事实。
 *
 * 保留一条断言盯住这个意图，只是盯的句子换了。
 */
check('system 提示词要求把对别人的判断写成「牌面显示」而非事实',
  system.indexOf('都要写成「牌面显示」') >= 0);

/*
 * 字段规格：只要求三个字段。
 *
 * 这一条同时也是一道防回退的闸——如果谁把 primer / synthesis / watchOut
 * 又加回 prompt，这里会红，提醒他那些字段正是「读起来累」的来源。
 */
check('system 提示词包含三个字段的规格',
  system.indexOf('"verdict"') >= 0 &&
  system.indexOf('"cards"') >= 0 &&
  system.indexOf('"actions"') >= 0);
check('system 提示词不再要求 primer / synthesis / watchOut',
  system.indexOf('"primer"') < 0 &&
  system.indexOf('"synthesis"') < 0 &&
  system.indexOf('"watchOut"') < 0);
check('system 提示词要求每张牌给一句话摘要（gist）',
  system.indexOf('"gist"') >= 0);

check('user 提示词包含问题', user.indexOf('提示词测试问题') >= 0);
eq('user 提示词包含全部牌位', promptResult.cards.filter(function (item) {
  return user.indexOf('【牌位 ' + (promptResult.cards.indexOf(item) + 1) + '：' + item.position.title + '】') >= 0;
}).length, 10);
check('user 提示词包含每张牌的牌义原文', promptResult.cards.every(function (item) {
  return user.indexOf(item.meaning.text) >= 0;
}));
check('user 提示词写明牌数', user.indexOf('共 10 个牌位') >= 0);

// 补充牌要出现在提示词里，并且明确标注是用户主动追加的
var bonusPromptBase = drawAuto({ spreadKey: 'three-choice', question: '补充牌提示词测试' });
var bonusPromptCards = Engine.extraCards(bonusPromptBase, 2);
var bonusPromptResult = Render.mergeBonus(bonusPromptBase, bonusPromptCards);
var bonusUser = LLM.buildUserPrompt(bonusPromptResult);

check('提示词包含补充牌', bonusUser.indexOf('补充牌 1') >= 0 && bonusUser.indexOf('补充牌 2') >= 0);
check('提示词里的牌数与合并后一致',
  bonusUser.indexOf('共 5 个牌位') >= 0, '应为 3 张牌阵 + 2 张补充');
check('补充牌的牌义原文也在提示词里', bonusPromptCards.every(function (item) {
  return bonusUser.indexOf(item.meaning.text) >= 0;
}));
check('补充牌的牌位说明写明是用户主动追加的',
  bonusUser.indexOf('主动要求再补一张') >= 0);
check('牌面清单也包含补充牌', LLM.formatSpreadForPrompt(bonusPromptResult)
  .indexOf('补充牌 1') >= 0);

// 提示词里给出的牌义必须与牌库一致（防止模板与实际数据脱节）
var spreadText = LLM.formatSpreadForPrompt(promptResult);
check('牌面清单包含正逆位', promptResult.cards.every(function (item) {
  return spreadText.indexOf(item.card.name + '（' + item.card.en + '，' + item.card.suitLabel + '） ' +
    item.orientation) >= 0;
}));

/* ================================================================== *
 * 12. 完整 HTTP 调用（本地 mock 服务，真跑 fetch）
 * ================================================================== */

section('完整链路 · 本地 mock 服务');

var http = require('http');

function startMockServer(handler) {
  return new Promise(function (resolve) {
    var server = http.createServer(handler);
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, port: server.address().port });
    });
  });
}

function runLiveTests() {
  var liveResult = drawAuto({ spreadKey: 'three-choice', question: '我该不该接受这个 offer？' });

  // 服务端返回一份完全合规的解读，引文取自真实牌义
  var goodPayload = {
    /*
     * mock 服务返回的是**新结构**（verdict / cards / actions），
     * 也就是当前 prompt 实际要求模型产出的形状——
     * 这条端到端链路要测的是用户真正会走的路径。
     *
     * 旧结构（primer / overview / synthesis / watchOut / 每张牌的 action）
     * 的兼容性单独在下面测，因为历史记录里存的还是那个形状。
     */
    verdict: '这份 offer 值得认真考虑，但你还缺一个关键信息。',
    cards: liveResult.cards.map(function (item, i) {
      return {
        index: i + 1,
        position: item.position.title,
        quote: item.meaning.text.slice(1, 22),
        gist: '第 ' + (i + 1) + ' 张牌的一句话摘要，提到 offer。',
        reading: '这是第 ' + (i + 1) + ' 个牌位的解读内容，针对 offer 的问题给出具体分析。'
      };
    }),
    actions: ['先问清薪资构成', '列出三个必须满足的条件', '给自己三天时间']
  };

  var requests = [];

  return startMockServer(function (req, res) {
    var body = '';
    req.on('data', function (chunk) { body += chunk; });
    req.on('end', function () {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(goodPayload) } }],
        usage: { prompt_tokens: 1200, completion_tokens: 600, total_tokens: 1800 }
      }));
    });
  }).then(function (mock) {
    var config = {
      baseUrl: 'http://127.0.0.1:' + mock.port + '/v1',
      model: 'mock-model',
      apiKey: 'sk-test-key',
      temperature: 0.8
    };

    return LLM.interpret({ result: liveResult, config: config }).then(function (payload) {
      eq('HTTP 请求发到了正确的路径', requests[0].url, '/v1/chat/completions');
      eq('请求带上了 Authorization', requests[0].headers.authorization, 'Bearer sk-test-key');
      eq('请求体里的模型名', requests[0].body.model, 'mock-model');
      eq('请求了两条消息', requests[0].body.messages.length, 2);
      eq('第一条是 system', requests[0].body.messages[0].role, 'system');
      eq('第二条是 user', requests[0].body.messages[1].role, 'user');
      check('user 消息里含抽到的牌', requests[0].body.messages[1].content.indexOf(liveResult.cards[0].card.name) >= 0);
      eq('请求体包含温度', requests[0].body.temperature, 0.8);
      eq('请求要求 JSON 输出', requests[0].body.response_format.type, 'json_object');
      eq('请求未开启流式', requests[0].body.stream, false);
      /*
       * 必须显式指定 max_tokens。
       *
       * 不指定时输出上限由服务端决定，长牌阵很容易在中途被砍断；
       * 而截断的 JSON 解析失败后，用户看到的是「模型格式不对」，
       * 于是去换模型，换完还是不行。
       */
      eq('请求显式指定了 max_tokens', requests[0].body.max_tokens, 4096);

      eq('解析出 3 个牌位', payload.reading.cards.length, 3);
      eq('引文核对全通过', payload.quoteStats.ok, 3);
      eq('没有校验问题', payload.issues.length, 0, JSON.stringify(payload.issues));
      eq('用量被带回', payload.usage.total_tokens, 1800);
      eq('结论文本正确', payload.reading.verdict, goodPayload.verdict);
      eq('行动清单 3 条', payload.reading.actions.length, 3);
      eq('牌位名取自本地牌阵', payload.reading.cards[0].position, liveResult.cards[0].position.title);
      eq('每张牌带上了一句话摘要', payload.reading.cards[0].gist, goodPayload.cards[0].gist);

      /*
       * 开放问题走完整链路：确认 payload 里拿到的是 open 通道，
       * 而不是一个误导性的低分。这条cover的是「提示词改了但检查没跟上」
       * 这类不一致——两半必须同时成立，用户才不会又看到一次「解读不合格」。
       */
      var openLive = drawAuto({ spreadKey: 'three-choice', question: '我今天会发生些什么' });
      var openPayload = {
        primer: '你可能没在等一件具体的事，而是想知道今天该把注意力放在哪。',
        overview: '这三张牌没有指向某件将要发生的事，它们描述的是你此刻的状态。',
        cards: openLive.cards.map(function (item, i) {
          return {
            index: i + 1,
            position: item.position.title,
            quote: item.meaning.text.slice(1, 22),
            reading: '第 ' + (i + 1) + ' 个牌位说的是你现在的处境与注意力所在。',
            action: '今天可以做的一件小事 ' + (i + 1)
          };
        }),
        synthesis: '三张牌合起来看，今天值得留意的是你自己的节奏。',
        actions: ['先做完一件', '留半小时不被打断', '把犹豫写下来'],
        watchOut: '你的真实状态只有你自己知道。'
      };
      return startMockServer(function (req, res) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify(openPayload) } }]
        }));
      }).then(function (openMock) {
        return LLM.interpret({
          result: openLive,
          config: { baseUrl: 'http://127.0.0.1:' + openMock.port + '/v1', model: 'm', apiKey: 'k' }
        }).then(function (result) {
          openMock.server.close();
          eq('开放问题端到端走 open 通道', result.specificity.level, 'open');
          check('开放问题端到端不给分数', result.specificity.score === null,
            String(result.specificity.score));
          eq('开放问题端到端评为 good', result.specificity.openLevel, 'good');
          eq('开放问题不发散牌位', result.specificity.loose.length, 0);
          eq('开放问题端到端没有校验问题', result.issues.length, 0,
            JSON.stringify(result.issues));
          });
        });
      }).then(function () {

      // 401 错误处理
      return startMockServer(function (req, res) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Authentication Fails' } }));
      }).then(function (bad) {
        return LLM.interpret({
          result: liveResult,
          config: { baseUrl: 'http://127.0.0.1:' + bad.port + '/v1', model: 'm', apiKey: 'bad' }
        }).then(function () {
          check('401 应当报错', false, '居然成功了');
        }).catch(function (error) {
          check('401 被翻译成可操作的提示', /401/.test(error.message) && /API Key/.test(error.message),
            error.message);
          bad.server.close();
        });
      }).then(function () {
        // 429 错误处理
        return startMockServer(function (req, res) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'rate limited' } }));
        }).then(function (limited) {
          return LLM.interpret({
            result: liveResult,
            config: { baseUrl: 'http://127.0.0.1:' + limited.port + '/v1', model: 'm', apiKey: 'k' }
          }).then(function () {
            check('429 应当报错', false, '居然成功了');
          }).catch(function (error) {
            check('429 提示限流', /429/.test(error.message) && /频繁|额度/.test(error.message), error.message);
            limited.server.close();
          });
        });
      }).then(function () {
        /*
         * 截断，而且**断在能救回来的位置**（verdict 已完整）。
         *
         * 这是用户实际遇到的形状：模型返回的 JSON 开头完全正确，
         *   {"verdict": "倾向于「能」…", "cards": [{"index": 1, "position": "此刻的核心",
         *    "quote": "开始松绑，看清了那个「好处」其实不值。", "quote_note": "此字
         * 只在末尾被砍断。旧代码在这里整次失败，还报「模型没有返回可解析的
         * JSON」——把长度问题误报成格式问题，用户按提示换了模型也照样不行。
         *
         * 现在应该：把写完的部分救回来，并明确标注这次不完整。
         */
        return startMockServer(function (req, res) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              message: {
                content: '{"verdict": "倾向于能，但前提是你主动放宽标准。", "cards": ' +
                  '[{"index": 1, "position": "此刻的核心", "quote": "开始看清并做出取舍。", ' +
                  '"quote_note": "此字'
              },
              finish_reason: 'length'
            }],
            usage: { total_tokens: 4000 }
          }));
        }).then(function (cut) {
          return LLM.interpret({
            result: liveResult,
            config: { baseUrl: 'http://127.0.0.1:' + cut.port + '/v1', model: 'm', apiKey: 'k' }
          }).then(function (result) {
            check('截断但 verdict 完整时救得回来',
              /倾向于能/.test(result.reading.verdict), result.reading.verdict);
            check('救回来的第一张牌带着那句完整的引文',
              /开始看清/.test(result.reading.cards[0].quote), result.reading.cards[0].quote);
            check('明确标注这次回复被截断过',
              result.issues.some(function (t) { return /截断/.test(t); }),
              JSON.stringify(result.issues));
            check('返回值记下了 salvaged 与 truncated',
              result.salvaged === true && result.truncated === true);
            cut.server.close();
          });
        });
      }).then(function () {
        /*
         * 截断得太靠前（连 verdict 都没写完）：救不回来，必须报错，
         * 而且要说清原因不是格式。
         */
        return startMockServer(function (req, res) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              message: { content: '{"verdict": "倾向' },
              finish_reason: 'length'
            }],
            usage: { total_tokens: 4000 }
          }));
        }).then(function (tiny) {
          return LLM.interpret({
            result: liveResult,
            config: { baseUrl: 'http://127.0.0.1:' + tiny.port + '/v1', model: 'm', apiKey: 'k' }
          }).then(function () {
            check('断得太靠前时应当报错', false, '居然成功了');
          }).catch(function (error) {
            check('断得太靠前时报「截断」而不是「不是 JSON」',
              /截断/.test(error.message) && !/没有返回可解析的 JSON/.test(error.message),
              error.message);
            check('截断的提示说清了换个模型也不解决问题',
              /换个模型也一样/.test(error.message), error.message);
            tiny.server.close();
          });
        });
      }).then(function () {
        // 服务端返回的不是 JSON
        return startMockServer(function (req, res) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html>502 Bad Gateway</html>');
        }).then(function (garbage) {
          return LLM.interpret({
            result: liveResult,
            config: { baseUrl: 'http://127.0.0.1:' + garbage.port + '/v1', model: 'm' }
          }).then(function () {
            check('非 JSON 返回应当报错', false, '居然成功了');
          }).catch(function (error) {
            check('非 JSON 返回给出地址检查提示', /不是 JSON|地址/.test(error.message), error.message);
            garbage.server.close();
          });
        });
      }).then(function () {
        // 模型返回带围栏和前缀的 JSON
        return startMockServer(function (req, res) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{
              message: {
                content: '好的，这是解读：\n```json\n' + JSON.stringify(goodPayload) + '\n```\n希望有帮助！'
              }
            }]
          }));
        }).then(function (fenced) {
          return LLM.interpret({
            result: liveResult,
            config: { baseUrl: 'http://127.0.0.1:' + fenced.port + '/v1', model: 'm' }
          }).then(function (payload) {
            eq('带围栏的返回也能解析', payload.reading.cards.length, 3);
            eq('带围栏时引文仍全部通过', payload.quoteStats.ok, 3);
            fenced.server.close();
          });
        });
      }).then(function () {
        // 模型返回编造的引文
        var badQuotePayload = JSON.parse(JSON.stringify(goodPayload));
        badQuotePayload.cards[0].quote = '命运已经为你安排好了一切，静待花开即可';
        return startMockServer(function (req, res) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { content: JSON.stringify(badQuotePayload) } }]
          }));
        }).then(function (fake) {
          return LLM.interpret({
            result: liveResult,
            config: { baseUrl: 'http://127.0.0.1:' + fake.port + '/v1', model: 'm' }
          }).then(function (payload) {
            eq('编造引文时只有 2 条通过', payload.quoteStats.ok, 2);
            check('编造引文的牌位被标记', payload.reading.cards[0].quoteOk === false);
            fake.server.close();
          });
        });
      }).then(function () {
        // 连通性测试
        return startMockServer(function (req, res) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ model: 'mock-model', choices: [{ message: { content: '可用' } }] }));
        }).then(function (ping) {
          return LLM.testConnection({
            baseUrl: 'http://127.0.0.1:' + ping.port + '/v1', model: 'mock-model'
          }).then(function (outcome) {
            check('连通性测试成功', outcome.ok === true);
            check('连通性测试带回模型返回', outcome.message.indexOf('可用') >= 0, outcome.message);
            ping.server.close();
          });
        });
      }).then(function () {
        // 接口不支持 response_format 时应当去掉该参数自动重试
        var attempts = [];
        return startMockServer(function (req, res) {
          var body = '';
          req.on('data', function (chunk) { body += chunk; });
          req.on('end', function () {
            var parsed = JSON.parse(body);
            attempts.push(Boolean(parsed.response_format));
            if (parsed.response_format) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: { message: 'Unsupported parameter: response_format' }
              }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              choices: [{ message: { content: JSON.stringify(goodPayload) } }]
            }));
          });
        }).then(function (picky) {
          return LLM.interpret({
            result: liveResult,
            config: { baseUrl: 'http://127.0.0.1:' + picky.port + '/v1', model: 'm', apiKey: 'k' }
          }).then(function (payload) {
            eq('不支持 response_format 时共请求 2 次', attempts.length, 2);
            eq('第一次带了 response_format', attempts[0], true);
            eq('第二次去掉了 response_format', attempts[1], false);
            eq('降级重试后解读正常', payload.reading.cards.length, 3);
            eq('降级重试后引文仍全部通过', payload.quoteStats.ok, 3);
            picky.server.close();
          });
        });
      }).then(function () {
        // 400 但原因与 response_format 无关时，不应盲目重试
        var retried = 0;
        return startMockServer(function (req, res) {
          retried += 1;
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'temperature 超出取值范围' } }));
        }).then(function (strict) {
          return LLM.interpret({
            result: liveResult,
            config: { baseUrl: 'http://127.0.0.1:' + strict.port + '/v1', model: 'm', apiKey: 'k' }
          }).then(function () {
            check('无关的 400 应当直接报错', false, '居然成功了');
          }).catch(function (error) {
            eq('无关的 400 只请求一次', retried, 1);
            check('错误信息带上原始详情', /temperature 超出取值范围/.test(error.message), error.message);
            strict.server.close();
          });
        });
      }).then(function () {
        mock.server.close();
      });
    });
  });
}

/* ================================================================== *
 * 假 DOM：只实现渲染层真正用到的那部分
 * ================================================================== */

/*
 * 被测代码（js/*.js）真正会用到的选择器。
 *
 * 假 DOM 没有选择器引擎，但这几个必须放行——否则 render.js 的
 * measureAvailableWidth 拿不到容器，初始化会在这里崩掉。
 * 它们返回「找不到」，render.js 会退到 estimateAvailableWidth 那条推算路径，
 * 这是精简环境下的预期行为（真实浏览器里由 verify-browser.js 用真 DOM 覆盖）。
 *
 * 维护方式：被测代码里新增选择器调用时，跑一次测试就会在 querySelector 那里
 * 抛错并报出是哪个选择器，把它加到这里即可。
 * 反过来，测试里写别的选择器会被拦住——那正是这个白名单要防的假通过。
 */
var PRODUCTION_SELECTORS = [
  '.table-wrap',   // render.js measureAvailableWidth
  '.fan-wrap'      // 同上，备选容器
];

function createFakeDocument() {
  function FakeNode(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = new FakeStyle();
    this.attributes = {};
    this.listeners = {};
    this._text = '';
    // 用普通字段冒充 className，render.js 只做读写拼接，不需要 DOMTokenList
    this.className = '';
    this.hidden = false;
    this.value = '';
    this.disabled = false;
    this.tabIndex = 0;
  }

  FakeNode.prototype.appendChild = function (child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  };

  FakeNode.prototype.removeChild = function (child) {
    var index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  };

  FakeNode.prototype.setAttribute = function (name, value) {
    this.attributes[name] = String(value);
  };

  FakeNode.prototype.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  };

  FakeNode.prototype.addEventListener = function (type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  };

  FakeNode.prototype.focus = function () {};
  FakeNode.prototype.scrollIntoView = function () {};

  Object.defineProperty(FakeNode.prototype, 'firstChild', {
    get: function () { return this.children.length ? this.children[0] : null; }
  });

  // textContent 要能读能写。写是替换全部文本（并清掉子节点），
  // 读是把自身文本和所有子节点的文本拼起来——这正是浏览器里的语义。
  Object.defineProperty(FakeNode.prototype, 'textContent', {
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

  function FakeStyle() {
    this._props = {};
  }
  FakeStyle.prototype.setProperty = function (name, value) { this._props[name] = value; };
  FakeStyle.prototype.getPropertyValue = function (name) {
    return Object.prototype.hasOwnProperty.call(this._props, name) ? this._props[name] : '';
  };

  return {
    createElement: function (tag) { return new FakeNode(tag); },
    createTextNode: function (text) {
      var node = new FakeNode('#text');
      node._text = String(text);
      return node;
    },
    getElementById: function () { return null; },

    /*
     * 选择器：**白名单放行，其余一律抛错**。
     *
     * 这是个很阴的坑：替身没有选择器引擎，如果一律返回 `[]`，那么
     * `document.querySelectorAll('.foo').length === 0` 这类断言会**静默通过**
     * ——看起来验过了，其实什么都没查，写的人得不到任何提示。
     *
     * 但也不能一律抛错：**被测代码自己会调选择器**——render.js 的
     * measureAvailableWidth 要查 `.table-wrap` / `.fan-wrap`。全部抛错的话，
     * 初始化会在 applyMetrics 里崩掉（这个坑当场踩到了）。
     *
     * 所以：被测代码真正用到的那几个放行（返回「找不到」，让它退到推算路径），
     * 其余抛错。以后有人在测试里写别的选择器，第一次跑就当场失败。
     */
    querySelector: function (sel) {
      if (PRODUCTION_SELECTORS.indexOf(sel) >= 0) return null;
      throw new Error('这个 DOM 替身不支持选择器 ' + JSON.stringify(sel) + '。' +
        '测试里请改用 createElement 的返回值直接断言，' +
        '或把这条测试放到 verify-browser.js（那边是真 domino，支持完整选择器）。' +
        '（故意抛错而不是返回 null——返回 null 会让断言静默假通过。）');
    },
    querySelectorAll: function (sel) {
      if (PRODUCTION_SELECTORS.indexOf(sel) >= 0) return [];
      throw new Error('这个 DOM 替身不支持选择器 ' + JSON.stringify(sel) + '。' +
        '测试里请改用 createElement 的返回值直接断言，' +
        '或把这条测试放到 verify-browser.js（那边是真 domino，支持完整选择器）。' +
        '（故意抛错而不是返回空数组——返回空数组会让断言静默假通过。）');
    },

    addEventListener: function () {},
    body: new FakeNode('body'),
    readyState: 'complete'
  };
}

/* ================================================================== *
 * 汇总
 *
 * 断言数基线。
 *
 * 本文件里有多处 `if (xxx) { ...若干条断言... }` 的守卫块（例如
 * 「从 styles.css 读出各层内边距」那一节），条件不成立时整块被跳过，
 * 而套件仍然打印「全部通过」——只是断言数悄悄变少，没人会注意到。
 * 本项目已经踩过一次：verify-browser.js 里 8 条断言静默失效，
 * 是靠「测试数怎么没变」才发现的。
 *
 * 所以最后核对一次总数。**加了新断言就把这个数改大**；
 * 它变小，就说明有东西被跳过了。
 * ================================================================== */

var MIN_EXPECTED_ASSERTIONS = 829;

var startedAt = Date.now();

runLiveTests().then(function () {
  var elapsed = Date.now() - startedAt;

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
    console.log('全部通过：' + passed + ' 项断言，用时 ' + elapsed + ' ms');
    console.log('='.repeat(64));
    process.exit(0);
  } else {
    console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项：');
    failures.forEach(function (item) {
      console.log('  [' + item.group + '] ' + item.label + (item.detail ? '  → ' + item.detail : ''));
    });
    console.log('='.repeat(64));
    process.exit(1);
  }
}).catch(function (error) {
  console.error('\n验证脚本自身出错：', error && error.stack ? error.stack : error);
  process.exit(2);
});
