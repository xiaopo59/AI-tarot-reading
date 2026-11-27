/*
 * check-live.js —— 用真实 API 跑一次完整链路
 *
 * 前面两个验证脚本（verify.js / verify-ui.js）都不联网，用的是本地 mock 服务。
 * 这个脚本是用来确认「你的 Key + 你的模型 + 真实网络」这一整条链路真的能跑通的。
 *
 *     PowerShell：
 *       $env:TAROT_KEY='你的Key'
 *       node check-live.js
 *       Remove-Item Env:\TAROT_KEY
 *
 * 可选环境变量：
 *   TAROT_KEY    API Key（本机 Ollama 可以不设）
 *   TAROT_URL    Base URL，默认 https://api.deepseek.com/v1
 *   TAROT_MODEL  模型名，默认 deepseek-chat
 *
 * 之所以用环境变量而不是命令行参数：命令行参数会留在 shell 历史里，
 * Key 会跟着一起留在那儿。
 *
 * 它会做三件事：
 *   1. 连通性测试——确认地址、Key、模型名三样都对
 *   2. 真抽一次牌，把牌面和问题发给模型，打印解读与引文核对结果
 *   3. 把完整结果导出成文本文件，方便你留档
 *
 * 费用约为 2 次调用（连通性 1 次 + 解读 1 次）。
 */
'use strict';

var path = require('path');
var fs = require('fs');

var BASE = path.join(__dirname, 'js');
['random.js', 'cards-major.js', 'cards-minor.js', 'cards.js', 'spreads.js', 'engine.js', 'llm.js']
  .forEach(function (file) { require(path.join(BASE, file)); });

var Tarot = globalThis.Tarot;

var config = {
  baseUrl: process.env.TAROT_URL || 'https://api.deepseek.com/v1',
  model: process.env.TAROT_MODEL || 'deepseek-chat',
  apiKey: process.env.TAROT_KEY || '',
  temperature: 0.8
};

function line(char) {
  return (char || '─').repeat(64);
}

/**
 * 走完整的「洗牌 → 挑牌 → 收尾」流程。
 *
 * 页面上的挑牌是用户在牌区里点出来的；命令行里没有人可点，所以固定挑第一个位置。
 * 随机性仍然全部来自 crypto——只是把「人选择哪个位置」这一步固定下来。
 */
function drawAuto(options) {
  var session = Tarot.Engine.prepareFan(options);
  for (var i = 0; i < session.needed; i++) {
    Tarot.Engine.takeFromFan(session, 0);
  }
  return Tarot.Engine.finalizeDraw(session);
}

function fail(message, error) {
  console.error('\n✗ ' + message);
  if (error && error.message) console.error('  ' + error.message);
  if (error && error.preview) console.error('  模型返回的开头：' + error.preview);
  process.exit(1);
}

console.log(line('='));
console.log('塔罗工具 · 真实 API 自检');
console.log(line('='));
console.log('接口地址：' + config.baseUrl);
console.log('模型：    ' + config.model);
console.log('API Key： ' + (config.apiKey
  ? config.apiKey.slice(0, 6) + '…（已设置，共 ' + config.apiKey.length + ' 字符）'
  : '（未设置——本机 Ollama 可以留空）'));
console.log('');

/* ------------------------------------------------------------------ *
 * 1. 连通性
 * ------------------------------------------------------------------ */

console.log(line());
console.log('第 1 步：连通性测试');
console.log(line());

Tarot.LLM.testConnection(config).then(function (outcome) {
  console.log('✓ ' + outcome.message);
  console.log('');

  /* ---------------------------------------------------------------- *
   * 2. 抽牌 + 真实解读
   * ---------------------------------------------------------------- */

  console.log(line());
  console.log('第 2 步：抽牌并请求真实解读');
  console.log(line());

  var question = process.env.TAROT_QUESTION ||
    '我现在的工作让我很疲惫，但又不确定要不要换。我该怎么考虑这件事？';

  var result = drawAuto({
    spreadKey: process.env.TAROT_SPREAD || 'three-choice',
    question: question,
    deckKey: 'full'
  });

  console.log('牌阵：' + result.spreadName);
  console.log('问题：' + result.question);
  console.log('抽牌编号：' + result.id);
  console.log('随机源审计：' + result.audit);
  console.log('');
  console.log('抽到的牌：');
  result.cards.forEach(function (item, i) {
    console.log('  ' + (i + 1) + '. ' + item.position.title + '：' +
      item.card.name + '（' + item.card.en + '） ' + item.orientation);
  });
  console.log('');
  console.log('正在请求模型（可能要 10-40 秒）…');
  console.log('');

  var startedAt = Date.now();

  return Tarot.LLM.interpret({ result: result, config: config }).then(function (payload) {
    var seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    console.log('✓ 解读返回（用时 ' + seconds + ' 秒）');
    console.log('');

    console.log(line());
    console.log('问题贴合度：' + payload.specificity.score + '/100（' +
      (payload.specificity.level === 'good' ? '解读与你的问题对得上'
        : payload.specificity.level === 'fair' ? '有部分内容比较泛' : '解读跟你的问题关系不大') + '）');
    console.log(line());
    if (payload.specificity.loose.length) {
      console.log('  以下牌位完全没提到你问题里的具体词，内容换个问题也成立：');
      payload.specificity.loose.forEach(function (item) {
        console.log('    · ' + item.position + '（' + item.cardName + '）');
      });
    } else {
      console.log('  每一条解读都落到了你问题里的具体事情上。');
    }
    console.log('  你问题里的具体词被回应了 ' + payload.specificity.termsUsed.length +
      '/' + payload.specificity.termTotal + ' 个' +
      (payload.specificity.termsUsed.length
        ? '：' + payload.specificity.termsUsed.join('、') : ''));
    console.log('');

    console.log(line());
    console.log('引文核对：' + payload.quoteStats.ok + '/' + payload.quoteStats.total);
    console.log(line());
    payload.reading.cards.forEach(function (item) {
      var tag = item.quoteOk ? '✓ 通过' : '✗ 未通过';
      console.log('  ' + item.index + '. ' + item.position + '　' + tag);
      if (item.quote) {
        console.log('     引用：「' + item.quote + '」');
      } else {
        console.log('     （模型没有给引文）');
      }
    });
    console.log('');
    console.log('引文核对的作用：把模型说的「原文」拿去和本地牌义逐字比对。');
    console.log('全部通过说明模型没有记串牌；出现未通过对不上，那一段解读要打折扣。');
    console.log('');

    console.log(line());
    console.log('结论');
    console.log(line());
    console.log(payload.reading.verdict || '（模型没有给出结论）');
    console.log('');

    if (payload.reading.actions.length) {
      console.log(line());
      console.log('可以去做的事');
      console.log(line());
      payload.reading.actions.forEach(function (text, i) {
        console.log('  ' + (i + 1) + '. ' + text);
      });
      console.log('');
    }

    console.log(line());
    console.log('每张牌说了什么');
    console.log(line());
    payload.reading.cards.forEach(function (item) {
      console.log('【' + item.index + '. ' + item.position + ' · ' + item.cardName + ' ' +
        item.orientation + '】');
      if (item.quote) {
        console.log('  引用：「' + item.quote + '」' + (item.quoteOk ? '（已核对）' : '（未通过核对）'));
      }
      // gist 是摘要，reading 是补充，两者内容相同时不重复打印
      if (item.gist) console.log('  ' + item.gist);
      if (item.reading && item.reading !== item.gist) {
        console.log('  ' + item.reading);
      }
      if (item.action) console.log('  可以做的事：' + item.action);
      console.log('');
    });

    if (payload.issues.length) {
      console.log(line('!'));
      console.log('校验发现 ' + payload.issues.length + ' 处问题：');
      payload.issues.forEach(function (text) { console.log('  · ' + text); });
      console.log('');
    }

    if (payload.usage) {
      console.log('本次用量：' + JSON.stringify(payload.usage));
    }

    /* -------------------------------------------------------------- *
     * 3. 导出
     * -------------------------------------------------------------- */

    var exported = path.join(__dirname, 'live-check-output.txt');
    var text = buildExport(result, payload);
    fs.writeFileSync(exported, text, 'utf8');

    console.log('');
    console.log(line('='));
    console.log('✓ 全链路通过。完整结果已写入：');
    console.log('  ' + exported);
    console.log(line('='));
  });
}).catch(function (error) {
  fail('链路未通过', error);
});

/* ------------------------------------------------------------------ *
 * 导出文本（与页面上的「导出为文本」保持同一格式）
 * ------------------------------------------------------------------ */

function buildExport(result, payload) {
  // app.js 里的 buildExportText 依赖 DOM，这里重新实现一份纯 Node 版本。
  // 两份格式保持一致：页面导出和命令行导出长得一样，便于对照。
  var lines = [];
  lines.push('塔罗牌抽取记录（真实 API 自检）');
  lines.push('='.repeat(40));
  lines.push('时间：' + new Date(result.at).toLocaleString('zh-CN'));
  lines.push('牌阵：' + result.spreadName + '（' + result.spreadSubtitle + '）');
  lines.push('牌库：' + result.deckLabel);
  lines.push('抽牌编号：' + result.id);
  lines.push('随机源：' + result.rng);
  lines.push(result.audit);
  lines.push('');
  lines.push('问题：' + (result.question || '（没有填写）'));
  lines.push('');
  lines.push('-'.repeat(40));
  lines.push('抽到的牌');
  lines.push('-'.repeat(40));

  result.cards.forEach(function (item, i) {
    lines.push('');
    lines.push((i + 1) + '. 【' + item.position.title + '】' +
      item.card.name + '（' + item.card.en + '） ' + item.orientation);
    lines.push('   此位在问：' + item.position.asks);
    lines.push('   关键词：' + item.meaning.keywords.join('、'));
    lines.push('   牌义：' + item.meaning.text);
    lines.push('   传统建议：' + item.meaning.advice);
  });

  lines.push('');
  lines.push('-'.repeat(40));
  lines.push('AI 解读');
  lines.push('-'.repeat(40));
  lines.push('引文核对：' + payload.quoteStats.ok + '/' + payload.quoteStats.total);
  if (payload.specificity) {
    // 开放问题没有分数（score 是 null），别打印「null/100」
    lines.push(payload.specificity.level === 'open'
      ? '问题贴合度：开放问题，不打分'
      : '问题贴合度：' + payload.specificity.score + '/100');
  }
  lines.push('');
  /*
   * 段序与页面导出一致：结论 → 每张牌 → 行动 → 元信息（贴合度、引文核对）。
   * 这个文件开头就写着「两份格式保持一致」，那就得真的保持——
   * 之前这里的顺序还是旧的（结论→行动→每张牌），也没有牌义块。
   */
  if (payload.reading.verdict) {
    lines.push('【结论】');
    lines.push(payload.reading.verdict);
    lines.push('');
  }
  if (payload.reading.cards.length) {
    lines.push('【每张牌说了什么】');
    payload.reading.cards.forEach(function (item) {
      lines.push(item.index + '. ' + item.position + ' · ' + item.cardName + item.orientation);
      /*
       * 命令行这边没有「抽到的牌」单独一段，所以牌义要在这儿列出来——
       * 和页面上「每张牌」区块显示牌义是一个道理（页面的导出有那一段，
       * 所以那边不重复）。
       */
      if (item.meaning && item.meaning.text) {
        if (item.meaning.keywords && item.meaning.keywords.length) {
          lines.push('   牌义关键词：' + item.meaning.keywords.join(' · '));
        }
        lines.push('   这张牌的意思（' + item.orientation + '）：' + item.meaning.text);
        if (item.meaning.advice) lines.push('   牌面本身的建议：' + item.meaning.advice);
      }
      if (item.gist) lines.push('   针对你的问题：' + item.gist);
      if (item.reading && item.reading !== item.gist) lines.push('   ' + item.reading);
      if (item.quote) {
        lines.push('   引用原文：「' + item.quote + '」' +
          (item.quoteOk ? '（已核对）' : '（未通过核对）'));
      }
      if (item.action) lines.push('   可以做的事：' + item.action);
    });
    lines.push('');
  }
  if (payload.reading.actions.length) {
    lines.push('【可以去做的事】');
    payload.reading.actions.forEach(function (text, i) {
      lines.push((i + 1) + '. ' + text);
    });
    lines.push('');
  }
  if (payload.issues.length) {
    lines.push('【校验发现的问题】');
    payload.issues.forEach(function (text) { lines.push('- ' + text); });
    lines.push('');
  }

  lines.push('');
  lines.push('-'.repeat(40));
  lines.push('说明：塔罗牌是随机抽出的，不预测未来。这份记录供自省参考，不能替代');
  lines.push('医疗、法律、投资等专业意见。');

  return lines.join('\n');
}
