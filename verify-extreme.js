/*
 * 极端情况测试。
 *
 * 这个文件专门回答一个问题：**接口返回各种烂数据时，会不会崩、会不会误导用户。**
 *
 * 之所以单独成篇，是因为这些情况在正常使用中很少见、但一旦出现代价很大——
 * 用户拿到的要么是一句看不懂的报错，要么（更糟）一个看起来正常的错误结论。
 * 用户实际踩过的两个坑都在这类里：
 *
 *   1. 输出撞上长度上限被截断，却被报成「模型格式能力不行」，
 *      于是他去换模型，换完照样失败。
 *   2. 抢救机制上线前的版本，截断会让整次解读作废——
 *      哪怕 verdict 和前面几张牌已经完整写好了。
 *
 * 判定标准只有两条，对所有情况都适用：
 *   · 不许抛未捕获的异常（脚本直接崩掉）
 *   · 结果必须**有意义**：要么抢救成功并明确标注不完整，
 *     要么报一条说清原因、且不把人往错误方向引的错误
 *
 *     node verify-extreme.js
 */
'use strict';

var fs = require('fs');
var http = require('http');
var path = require('path');

var ROOT = __dirname;

/* 按与其它测试相同的方式加载被测代码（双环境 IIFE） */
[
  'random.js', 'cards-major.js', 'cards-minor.js', 'cards.js',
  'spreads.js', 'engine.js', 'render.js', 'llm.js'
].forEach(function (f) {
  require(path.join(ROOT, 'js', f));
});

var Tarot = globalThis.Tarot;
var LLM = Tarot.LLM;

/* ------------------------------------------------------------------ *
 * 断言脚手架
 * ------------------------------------------------------------------ */

var passed = 0;
var failed = 0;
var failures = [];
var sectionName = '';

/*
 * 断言数基线。
 *
 * 和另外几个套件同样的道理：文件里有多处按数据生成的断言，
 * 一旦某个循环没跑起来（数组被改空、条件不成立），套件会照样打印
 * 「全部通过」，只是数字悄悄变小。基线让这种情况变成一条红色报错。
 *
 * 加了新断言就把这个数字改大。
 */
var MIN_EXPECTED_ASSERTIONS = 129;

function section(name) {
  sectionName = name;
  console.log('');
  console.log('── ' + name + ' ' + new Array(Math.max(0, 62 - name.length)).join('─'));
}

function check(label, ok, detail) {
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(sectionName + ' :: ' + label + (detail ? '  → ' + detail : ''));
    console.log('  ✗ ' + label + (detail ? '  → ' + detail : ''));
  }
}

/* ------------------------------------------------------------------ *
 * 假的模型服务：按脚本回答
 * ------------------------------------------------------------------ */

var BODY_TEXT = fs.readFileSync(path.join(ROOT, 'js', 'llm.js'), 'utf8');

/** 起一个只会按给定内容回应的 HTTP 服务 */
function serve(handler) {
  return new Promise(function (resolve) {
    var server = http.createServer(handler);
    server.listen(0, '127.0.0.1', function () {
      var port = server.address().port;
      resolve({
        server: server,
        port: port,
        config: { baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'm', apiKey: 'k' },
        close: function () { server.close(); }
      });
    });
  });
}

/** 用一段文本作为模型回复（可选 finish_reason） */
function replyWith(content, finishReason) {
  return serve(function (req, res) {
    req.on('data', function () {});
    req.on('end', function () {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: { role: 'assistant', content: content },
          finish_reason: finishReason || 'stop'
        }],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 }
      }));
    });
  });
}

/** 用任意原始响应体回应（用来模拟 HTTP 层异常） */
function rawReply(status, body, contentType) {
  return serve(function (req, res) {
    req.on('data', function () {});
    req.on('end', function () {
      res.writeHead(status, { 'Content-Type': contentType || 'application/json' });
      res.end(body);
    });
  });
}

/* ------------------------------------------------------------------ *
 * 跑一次完整链路，把结果归一成两种形状
 * ------------------------------------------------------------------ */

var liveResult = null;

/**
 * 跑一次解读，永不抛错。
 * @returns {Promise<{ok:boolean, result?:Object, error?:Error}>}
 */
function attempt(server) {
  return LLM.interpret({ result: liveResult, config: server.config })
    .then(function (result) { return { ok: true, result: result }; })
    .catch(function (error) { return { ok: false, error: error }; });
}

/** 一段合法的完整回复，供各用例裁剪 */
function fullReply(extraField) {
  var cards = liveResult.cards.map(function (item, i) {
    var obj = {
      index: i + 1,
      position: item.position.title,
      quote: item.meaning.text.slice(1, 20),
      gist: '第 ' + (i + 1) + ' 张牌的一句话摘要。',
      reading: '第 ' + (i + 1) + ' 个牌位的解读内容，针对这个问题给出具体分析。'
    };
    // 模拟模型自己加字段（用户遇到过 quote_note）
    if (extraField) obj[extraField] = '模型自己加的一段说明文字';
    return obj;
  });
  return JSON.stringify({
    verdict: '直接回答这个问题的结论，第一句就给出明确判断。',
    cards: cards,
    actions: ['第一条具体行动', '第二条具体行动']
  });
}

/* ------------------------------------------------------------------ *
 * 开始
 * ------------------------------------------------------------------ */

console.log('极端情况测试');

// 用一个真实的六张牌局（含补充牌），接近用户实际最重的用法
(function prepare() {
  var session = Tarot.Engine.prepareFan({ spreadKey: 'single', question: '要不要换工作？' });

  // 系统先抽 1 张（牌阵需要的张数）
  for (var i = 0; i < session.needed; i++) {
    Tarot.Engine.takeFromFan(session, 0);
  }
  liveResult = Tarot.Engine.finalizeDraw(session);

  // 再追加 5 张补充牌，凑成用户截图里那种规模（6 张）
  var added = Tarot.Engine.extraCards(liveResult, 5);
  liveResult = Tarot.Render.mergeBonus(liveResult, added);
})();

console.log('  牌位数量：' + liveResult.cards.length + '（1 张主牌 + 5 张补充牌）');

var full = fullReply();

/* ================================================================== *
 * 1. 截断：把完整回复切在每一个有意义的位置上
 *
 * 这是用户实际踩的坑，也是抢救机制的边界。切的点覆盖了一个 JSON 回复
 * 从头到尾所有「可能被砍断的地方」——键名中间、值中间、分隔符上、
 * 转义符上，每一种都应该得到一个可理解的结果。
 * ================================================================== */

section('截断 · 逐个位置');

var TRUNCATIONS = [
  { at: 1, name: '只剩一个左花括号' },
  { at: 8, name: '键名中间（"verdi）' },
  { at: 20, name: 'verdict 值中间' },
  { text: '{"verdict": "答案写完了。"', at: null, name: 'verdict 刚闭合' },
  { text: '{"verdict": "答案写完了。",', at: null, name: 'verdict 后的逗号处' },
  { text: '{"verdict": "答案写完了。", "car', at: null, name: 'cards 键名中间' },
  { text: '{"verdict": "答案写完了。", "cards":', at: null, name: 'cards 冒号后' },
  { text: '{"verdict": "答案写完了。", "cards": [', at: null, name: '数组刚开' },
  { text: '{"verdict": "答案写完了。", "cards": [{', at: null, name: '第一个对象刚开' },
  {
    text: '{"verdict": "答案写完了。", "cards": [{"index": 1, "position": "此刻的核心",',
    at: null, name: 'position 后的逗号处'
  },
  {
    text: '{"verdict": "答案写完了。", "cards": [{"index": 1, "position": "此刻的核心", "quote": "休息不够',
    at: null, name: 'quote 值中间'
  },
  {
    text: '{"verdict": "答案写完了。", "cards": [{"index": 1, "position": "此刻的核心", "quote": "休息不够却硬撑。",',
    at: null, name: 'quote 闭合后'
  },
  {
    text: '{"verdict": "答案写完了。", "cards": [{"index": 1, "position": "此刻的核心", "quote": "休息不够却硬撑。", "gist": "是焦虑',
    at: null, name: 'gist 值中间'
  },
  {
    text: '{"verdict": "答案写完了。", "cards": [{"index": 1, "position": "此刻的核心", "quote": "休息不够却硬撑。", "gist": "是焦虑在挡住。", "reading": "详细解读',
    at: null, name: 'reading 值中间'
  },
  {
    text: '{"verdict": "答案写完了。", "cards": [{"index": 1, "position": "此刻的核心", "quote": "休息不够却硬撑。", "gist": "是焦虑在挡住。", "reading": "详细解读内容。"},',
    at: null, name: '第一张牌完整闭合后'
  },
  {
    text: '{"verdict": "答案写完了。", "cards": [{"index": 1, "position": "a", "quote": "q1", "gist": "g1", "reading": "r1"}, {"index": 2, "position": "b", "quote": "q2", "gist": "g2',
    at: null, name: '第二张牌中间'
  },
  {
    text: '{"verdict": "答案写完了。", "cards": [{"index": 1, "position": "a", "quote": "q1", "gist": "g1", "reading": "r1"}], "actions": ["第一',
    at: null, name: 'actions 值中间'
  },
  {
    text: '{"verdict": "答案写完了。", "cards": [{"index": 1, "position": "a", "quote": "q1", "gist": "g1", "reading": "r1"}], "actions": ["第一条"],',
    at: null, name: 'actions 闭合后'
  },
  {
    text: '{"verdict": "结尾有个反斜杠 \\',
    at: null, name: '结尾停在转义反斜杠上'
  },
  {
    text: '{"verdict": "结尾停在 Unicode 转义中间 \\u00',
    at: null, name: '结尾停在 Unicode 转义中间'
  }
];

// 补上按固定下标切的两条
TRUNCATIONS[0].text = full.slice(0, TRUNCATIONS[0].at);
TRUNCATIONS[1].text = full.slice(0, TRUNCATIONS[1].at);
TRUNCATIONS[2].text = full.slice(0, TRUNCATIONS[2].at);

/** 上面这些片段的预期：verdict 是否完整可救 */
function expectSalvageable(text) {
  // verdict 的收尾（"答案写完了。" 或 "…明确判断。"）是否已经完整出现
  return /"verdict"\s*:\s*"[^"]*"/.test(text) &&
    /答案写完了。|明确判断。/.test(text);
}

(async function run() {
  for (var i = 0; i < TRUNCATIONS.length; i++) {
    var t = TRUNCATIONS[i];
    var srv = await replyWith(t.text, 'length');
    var out = await attempt(srv);
    srv.close();

    var salvageable = expectSalvageable(t.text);

    if (out.ok) {
      // 救回来了：必须标注不完整，否则用户会以为解读就这么多
      check('截断@' + t.name + ' → 抢救成功时标注了不完整',
        out.result.salvaged === true &&
        out.result.issues.some(function (x) { return /截断/.test(x); }),
        'salvaged=' + out.result.salvaged + ' issues=' + JSON.stringify(out.result.issues));
      check('截断@' + t.name + ' → 抢救只应发生在可救的情况',
        salvageable,
        '这个位置不该救回来，却成功了');
    } else {
      // 救不回来：错误必须说清是长度问题，不能引向「模型格式能力」
      check('截断@' + t.name + ' → 报错时说清了是截断',
        /截断/.test(out.error.message),
        out.error.message);
      check('截断@' + t.name + ' → 不再把长度问题说成模型格式问题',
        !/没有返回可解析的 JSON|指令跟随更好/.test(out.error.message),
        out.error.message);
      check('截断@' + t.name + ' → 可救的情况不应失败',
        !salvageable,
        '这个位置本该救回来，却报错了：' + out.error.message);
    }
  }

  /* ==================================================================
   * 2. 畸形 JSON：模型不按格式来
   * ================================================================== */

  section('畸形 JSON');

  var MALFORMED = [
    { name: '带 ```json 围栏', text: '```json\n' + full + '\n```', ok: true },
    { name: '前面有解释文字', text: '好的，这是解读：\n' + full, ok: true },
    { name: '后面有解释文字', text: full + '\n希望对你有帮助。', ok: true },
    { name: '前后都有废话', text: '好的：\n' + full + '\n以上。', ok: true },
    { name: '整段不是 JSON', text: '今天天气不错，我们聊聊别的吧。', ok: false },
    { name: '空字符串', text: '', ok: false },
    { name: '只有空白', text: '   \n\t  ', ok: false },
    { name: '纯 HTML', text: '<html><body>502 Bad Gateway</body></html>', ok: false },
    /*
     * 合法 JSON，但根本不是解读对象。
     *
     * 这类**不该报错**：JSON 是合法的，只是结构不对。正确做法是照常返回
     * 一份解读（字段留空）并把问题记进 issues，让用户看到「模型没给出结论」
     * 这种具体信息，而不是一句笼统的解析失败。
     */
    { name: 'JSON 数组而不是对象', text: '[1,2,3]', ok: true, expectIssues: true },
    { name: '合法 JSON 但缺所有字段', text: '{}', ok: true, expectIssues: true },
    { name: 'JSON 里全是无关字段', text: '{"hello": "world", "n": 42}', ok: true, expectIssues: true }
  ];

  for (var m = 0; m < MALFORMED.length; m++) {
    var item = MALFORMED[m];
    var msrv = await replyWith(item.text, 'stop');
    var mout = await attempt(msrv);
    msrv.close();

    check('畸形@' + item.name + ' → ' + (item.ok ? '应能处理' : '应报错且不崩'),
      item.ok ? mout.ok : !mout.ok,
      mout.ok ? '成功' : mout.error.message);

    if (mout.ok && item.expectIssues) {
      check('畸形@' + item.name + ' → 结构不对时明确记入问题',
        mout.result.issues.length > 0,
        JSON.stringify(mout.result.issues));
    }
    if (!mout.ok) {
      check('畸形@' + item.name + ' → 错误信息不为空',
        typeof mout.error.message === 'string' && mout.error.message.length > 0);
    }
  }

  /* ==================================================================
   * 3. 结构异常：JSON 合法但内容不对
   * ================================================================== */

  section('结构异常');

  var STRUCTS = [
    { name: 'cards 不是数组', payload: { verdict: 'v', cards: '不是数组', actions: ['a'] } },
    { name: 'cards 是空数组', payload: { verdict: 'v', cards: [], actions: ['a'] } },
    { name: 'cards 元素是 null', payload: { verdict: 'v', cards: [null, null], actions: ['a'] } },
    { name: 'cards 元素是字符串', payload: { verdict: 'v', cards: ['x', 'y'], actions: ['a'] } },
    { name: 'index 全是同一个值', payload: { verdict: 'v', cards: [{ index: 1, reading: 'r' }, { index: 1, reading: 'r' }], actions: ['a'] } },
    { name: 'index 是字符串', payload: { verdict: 'v', cards: [{ index: '1', reading: 'r' }], actions: ['a'] } },
    { name: 'index 从 0 开始', payload: { verdict: 'v', cards: [{ index: 0, reading: 'r' }], actions: ['a'] } },
    { name: 'reading 是数组', payload: { verdict: 'v', cards: [{ index: 1, reading: ['a', 'b'] }], actions: ['a'] } },
    { name: 'reading 是数字', payload: { verdict: 'v', cards: [{ index: 1, reading: 12345 }], actions: ['a'] } },
    { name: 'actions 是字符串', payload: { verdict: 'v', cards: [], actions: '一条\n两条' } },
    { name: 'actions 里有 null', payload: { verdict: 'v', cards: [], actions: [null, 'ok', null] } },
    { name: 'verdict 是数字', payload: { verdict: 12345, cards: [], actions: ['a'] } },
    { name: 'verdict 是 null', payload: { verdict: null, cards: [], actions: ['a'] } },
    { name: '字段名大小写不对', payload: { Verdict: 'v', Cards: [], Actions: ['a'] } },
    { name: '多给了一堆无关字段', payload: { verdict: 'v', cards: [], actions: ['a'], 备注: 'x', extra: { deep: [1, 2] } } }
  ];

  for (var s = 0; s < STRUCTS.length; s++) {
    var st = STRUCTS[s];
    var ssrv = await replyWith(JSON.stringify(st.payload), 'stop');
    var sout = await attempt(ssrv);
    ssrv.close();

    // 无论结构多离谱，都不能崩：要么成功要么给一条非空错误
    check('结构@' + st.name + ' → 不崩且结果有意义',
      (sout.ok && sout.result && sout.result.reading && Array.isArray(sout.result.reading.cards)) ||
      (!sout.ok && typeof sout.error.message === 'string' && sout.error.message.length > 0),
      sout.ok ? '成功但结构异常' : sout.error.message);

    if (sout.ok) {
      // 成功时，牌位数必须和本地抽的牌一致（本地是唯一依据）
      check('结构@' + st.name + ' → 牌位数与本地抽牌一致',
        sout.result.reading.cards.length === liveResult.cards.length,
        '期望 ' + liveResult.cards.length + '，实际 ' + sout.result.reading.cards.length);
    }
  }

  /* ==================================================================
   * 4. HTTP 层异常
   * ================================================================== */

  section('HTTP 层异常');

  var HTTP_CASES = [
    { name: '500', status: 500, body: JSON.stringify({ error: { message: 'internal' } }) },
    { name: '502', status: 502, body: '<html>Bad Gateway</html>', type: 'text/html' },
    { name: '503', status: 503, body: JSON.stringify({ error: { message: 'overloaded' } }) },
    { name: '404（地址写错）', status: 404, body: JSON.stringify({ error: { message: 'not found' } }) },
    { name: '400 非 JSON 抱怨', status: 400, body: JSON.stringify({ error: { message: 'bad request' } }) },
    { name: '200 但空 body', status: 200, body: '' },
    { name: '200 但是 HTML', status: 200, body: '<html>go away</html>', type: 'text/html' },
    { name: '200 但 choices 为空数组', status: 200, body: JSON.stringify({ choices: [] }) },
    { name: '200 但没有 choices 字段', status: 200, body: JSON.stringify({ ok: true }) },
    { name: '200 但 message 是 null', status: 200, body: JSON.stringify({ choices: [{ message: null }] }) },
    { name: '200 但 content 是 null', status: 200, body: JSON.stringify({ choices: [{ message: { content: null } }] }) }
  ];

  for (var h = 0; h < HTTP_CASES.length; h++) {
    var hc = HTTP_CASES[h];
    var hsrv = await rawReply(hc.status, hc.body, hc.type);
    var hout = await attempt(hsrv);
    hsrv.close();

    check('HTTP@' + hc.name + ' → 报错而不是崩溃',
      !hout.ok && typeof hout.error.message === 'string' && hout.error.message.length > 0,
      hout.ok ? '居然成功了' : hout.error.message);
  }

  /* ==================================================================
   * 5. 补充牌与超长输出
   *
   * 用户截图的用法：1 张主牌 + 5 张补充牌。补充牌也要逐张解读，
   * 输出量是单张牌阵的好几倍——这是最容易撞上长度上限的场景。
   * ================================================================== */

  section('补充牌与超长输出');

  // 正常回复：六张牌全给，应当完全成功
  var sixSrv = await replyWith(
    JSON.stringify({
      verdict: '结论。',
      cards: liveResult.cards.map(function (item, i) {
        return {
          index: i + 1,
          position: item.position.title,
          quote: item.meaning.text.slice(1, 20),
          gist: '第 ' + (i + 1) + ' 张摘要。',
          reading: '第 ' + (i + 1) + ' 张解读。'
        };
      }),
      actions: ['a', 'b']
    }), 'stop');
  var sixOut = await attempt(sixSrv);
  sixSrv.close();

  check('六张牌（含 5 张补充牌）能完整处理', sixOut.ok, sixOut.ok ? '' : sixOut.error.message);
  if (sixOut.ok) {
    check('六张牌全部拿到解读',
      sixOut.result.reading.cards.every(function (c) { return c.reading; }));
    check('补充牌被标记出来',
      sixOut.result.reading.cards.filter(function (c) { return c.isBonus; }).length === 5,
      '实际 ' + sixOut.result.reading.cards.filter(function (c) { return c.isBonus; }).length);
  }

  // 只写到第三张就被截断：应该救回前三张
  var halfCards = liveResult.cards.slice(0, 3).map(function (item, i) {
    return {
      index: i + 1,
      position: item.position.title,
      quote: item.meaning.text.slice(1, 20),
      gist: '第 ' + (i + 1) + ' 张摘要。',
      reading: '第 ' + (i + 1) + ' 张解读。'
    };
  });
  /*
   * 第四张断在 quote 值中间。
   *
   * position 必须用**真实的牌位名**——hardcode 一个别的名字会额外触发
   * 「牌位名不一致」那条 issue，于是测的就不是「纯粹的截断」了。
   */
  var halfText = '{"verdict": "结论写完了。", "cards": [' +
    halfCards.map(function (c) { return JSON.stringify(c); }).join(', ') +
    ', {"index": 4, "position": ' +
    JSON.stringify(liveResult.cards[3].position.title) +
    ', "quote": "写到一半';
  var halfSrv = await replyWith(halfText, 'length');
  var halfOut = await attempt(halfSrv);
  halfSrv.close();

  check('六张牌写到第四张被截断 → 抢救成功', halfOut.ok,
    halfOut.ok ? '' : halfOut.error.message);
  if (halfOut.ok) {
    check('抢救保留了完整的前三张',
      halfOut.result.reading.cards.slice(0, 3).every(function (c) { return c.reading; }),
      JSON.stringify(halfOut.result.reading.cards.map(function (c) { return Boolean(c.reading); })));
    check('被截断的那张没有编造内容',
      !halfOut.result.reading.cards[3].reading,
      halfOut.result.reading.cards[3].reading);
    check('明确告诉用户这次不完整',
      halfOut.result.issues.some(function (x) { return /截断/.test(x); }));

    /*
     * 截断的后果要合并成一条，不能每个缺失牌位各报一条。
     *
     * 六个牌位只写完三个，照实罗列就是「缺少第 4 个牌位的解读」
     * 「缺少第 5 个……」「缺少第 6 个……」外加「行动清单为空」——
     * 界面上显示「校验时发现 5 处问题」，用户以为出了很多错，其实只有一个原因。
     */
    check('截断的后果合并成一条，不是每个缺失牌位各一条',
      halfOut.result.issues.length === 1,
      '实际 ' + halfOut.result.issues.length + ' 条：' + JSON.stringify(halfOut.result.issues));
    check('合并后的那条说清了缺几个',
      /6 个牌位里只写完 3 个/.test(halfOut.result.issues[0] || ''),
      halfOut.result.issues[0]);
  }

  /* ==================================================================
   * 6. 极端输入
   * ================================================================== */

  section('极端输入');

  var WEIRD_QUESTIONS = [
    { name: '超长问题（5000 字）', q: new Array(5001).join('测') },
    { name: '全是换行', q: '\n\n\n\n\n' },
    { name: '只有标点', q: '？？？！！！……' },
    { name: 'emoji', q: '😀🎉🔮 我该怎么办？' },
    { name: '引号和反斜杠', q: '他说"你好"\\然后走了，我该怎么办？' },
    { name: 'JSON 片段注入', q: '{"verdict": "被注入了", "cards": []}' },
    { name: '控制字符', q: '问题\u0000里\u0007有控制符' },
    { name: 'RTL 文字', q: 'مرحبا 我该怎么办？' }
  ];

  for (var w = 0; w < WEIRD_QUESTIONS.length; w++) {
    var wq = WEIRD_QUESTIONS[w];
    var wsession = Tarot.Engine.prepareFan({ spreadKey: 'three-choice', question: wq.q });
    for (var wi = 0; wi < wsession.needed; wi++) {
      Tarot.Engine.takeFromFan(wsession, 0);
    }
    var wr;
    try {
      wr = Tarot.Engine.finalizeDraw(wsession);
    } catch (e) {
      check('输入@' + wq.name + ' → 抽牌阶段不崩', false, e.message);
      continue;
    }

    var wsrv = await replyWith(
      JSON.stringify({
        verdict: '结论。',
        cards: wr.cards.map(function (item, i) {
          return { index: i + 1, position: item.position.title, quote: item.meaning.text.slice(1, 20), gist: '摘要。', reading: '解读。' };
        }),
        actions: ['a']
      }), 'stop');
    var wout = await LLM.interpret({ result: wr, config: wsrv.config })
      .then(function (r) { return { ok: true, result: r }; })
      .catch(function (e) { return { ok: false, error: e }; });
    wsrv.close();

    check('输入@' + wq.name + ' → 全链路不崩', wout.ok, wout.ok ? '' : wout.error.message);
    if (wout.ok) {
      check('输入@' + wq.name + ' → 解读结构完整',
        Boolean(wout.result.reading.verdict) &&
        wout.result.reading.cards.length === wr.cards.length);
    }
  }

  /* ------------------------------------------------------------------ */

  console.log('');
  console.log(new Array(64).join('='));

  // 断言数不能少于基线：少了就说明某一段循环没跑起来
  if (passed + failed < MIN_EXPECTED_ASSERTIONS) {
    failed++;
    failures.push('断言数不足：只跑了 ' + (passed + failed) +
      ' 项，基线是 ' + MIN_EXPECTED_ASSERTIONS + ' 项。多半是某个循环没跑起来。');
  }

  if (failed === 0) {
    console.log('全部通过：' + passed + ' 项断言');
  } else {
    console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项：');
    failures.forEach(function (f) { console.log('  ' + f); });
  }
  console.log(new Array(64).join('='));
  process.exit(failed === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('测试脚本本身崩了：', e && e.stack ? e.stack : e);
  process.exit(2);
});
