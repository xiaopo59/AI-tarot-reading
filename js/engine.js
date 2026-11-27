/*
 * engine.js —— 洗牌与抽牌引擎
 *
 * 这个文件的职责只有一个：从 78 张牌里，用真随机抽出牌阵需要的那些牌，
 * 并为每张牌独立决定正位或逆位。它不做任何解读，也不做任何加权。
 *
 * 几个刻意的设计决定：
 *
 * 1) 每次抽牌都重新洗一副完整的 78 张牌，抽完即弃。牌序不缓存、不复用，
 *    所以「上一次抽到什么」对这一次没有任何影响。
 *
 * 2) 同一个牌阵里不放回：不会出现「过去和未来是同一张牌」这种自相矛盾。
 *
 * 3) 正位/逆位与抽到哪张牌相互独立，各 50%。平均每次抽牌约有一半是逆位，
 *    这是韦特体系的常规做法。
 *
 * 4) 牌阵需要几张就抽几张。这里没有「先洗三遍」「切牌」之类的步骤——
 *    那些是仪式，不影响随机性；随机性 100% 来自 crypto。
 *
 * 5) 抽牌结果里带一份审计记录（audit），记录本次消耗的原始随机字数量与
 *    拒绝次数。它的用途是：如果你怀疑牌被动过手脚，可以据此核对。
 */
(function (root) {
  'use strict';

  var Tarot = root.Tarot = root.Tarot || {};
  var RNG = Tarot.RNG;

  var DECKS = {
    full: {
      key: 'full',
      label: '完整 78 张',
      desc: '大阿卡纳 22 张 + 小阿卡纳 56 张，标准韦特牌',
      size: 78
    },
    major: {
      key: 'major',
      label: '只用大阿卡纳 22 张',
      desc: '只用 22 张大牌，问题更偏向人生课题与重大转折',
      size: 22
    }
  };

  /**
   * 取指定牌库的牌列表。
   * @param {string} deckKey
   * @returns {Array}
   */
  function deckFor(deckKey) {
    var all = Tarot.Cards.deck;
    if (deckKey === 'major') {
      return all.filter(function (card) { return card.suit === 'major'; });
    }
    return all.slice();
  }

  /**
   * 洗牌，并把整副牌摊成扇形等用户来挑。
   *
   * 这是「自己抽牌」模式的第一步。它做两件事，而且是**两次独立的洗牌**：
   *
   *   牌序（deckOrder）—— 桌面上最终会出现哪些牌
   *   扇形顺序（fanOrder）—— 这些牌在扇形里从左到右怎么摆
   *
   * 分两次很关键。如果扇形顺序就是牌序，那么「第 1 张」永远对应牌序里的第一张，
   * 用户点哪儿其实都一样，「自己选」就成了假的。分成两次之后，78 张牌出现在
   * 78 个位置上的 78! 种组合等概率，用户选哪个位置是**真实的随机输入**——
   * 随机性一部分来自 crypto，一部分来自人的选择。
   *
   * 正逆位不在这里定：它在用户点下每张牌的瞬间才掷一次，这样「翻牌」这个动作
   * 在时间上也是真实的。
   *
   * 审计从这里开始，一直到 finalizeDraw 才收尾——因为一次「抽牌」在用户看来
   * 是「洗牌 + 挑完所有牌」这一整段动作。
   *
   * @param {Object} options
   * @param {string} options.spreadKey  牌阵 key
   * @param {string} [options.question] 用户的问题（只做记录，不参与随机）
   * @param {string} [options.deckKey]  牌库：'full' | 'major'
   * @returns {Object} 抽牌会话
   */
  function prepareFan(options) {
    options = options || {};
    if (!RNG.available()) {
      RNG.randomBelow(1); // 触发统一的报错信息
    }

    var spread = Tarot.Spreads.get(options.spreadKey);
    if (!spread) {
      throw new Error('没有这个牌阵：' + options.spreadKey);
    }

    var deckKey = options.deckKey === 'major' ? 'major' : 'full';
    var pool = deckFor(deckKey);

    /*
     * 抽几张。不传就用牌阵的牌位数——这也是界面上实际走的那条路径：
     * 牌阵有几个牌位就抽几张。
     *
     * 保留这个参数是为了让引擎自己支持任意张数：将来若要加「自定义张数」，
     * 这一层不用重做。调用方也可以通过 session.positions 给出自己的牌位定义。
     */
    var wanted = Math.floor(options.count);
    if (!isFinite(wanted) || wanted < 1) wanted = spread.positions.length;

    if (wanted > pool.length) {
      throw new Error('要抽 ' + wanted + ' 张，但牌库只有 ' + pool.length + ' 张');
    }

    RNG.startAudit();

    var deckOrder = RNG.shuffle(pool.slice()).map(function (card) { return card.id; });
    var fanOrder = RNG.shuffle(deckOrder.slice());

    return {
      spreadKey: spread.key,
      deckKey: deckKey,
      question: (options.question || '').trim(),
      deckOrder: deckOrder,
      fanOrder: fanOrder,
      picks: [],
      needed: wanted
    };
  }

  /**
   * 用户从扇形里挑走一张。
   *
   * 挑的是**位置**不是牌：调用方给出扇形里的第几个位置，由这里取出那个位置上的牌。
   * 正逆位在这一刻独立掷一次 50%。
   *
   * @param {Object} session prepareFan() 的返回值
   * @param {number} fanIndex 扇形里的位置（0 起）
   * @returns {Object} 这次挑到的牌
   */
  function takeFromFan(session, fanIndex) {
    if (!session || !Array.isArray(session.fanOrder)) {
      throw new Error('这次抽牌没有待挑的牌，请先洗牌。');
    }
    var index = Math.floor(fanIndex);
    if (!isFinite(index) || index < 0 || index >= session.fanOrder.length) {
      throw new Error('牌区里没有第 ' + fanIndex + ' 个位置');
    }

    var cardId = session.fanOrder[index];
    var card = Tarot.Cards.get(cardId);
    if (!card) {
      throw new Error('牌区里的这张牌不存在：' + cardId);
    }
    if (session.picks.some(function (p) { return p.cardId === cardId; })) {
      throw new Error('这张牌已经被挑走了');
    }

    // 正逆位与「挑的是哪张牌」无关，各 50%
    var reversed = RNG.randomBool();

    var pick = {
      fanIndex: index,
      cardId: cardId,
      card: card,
      reversed: reversed,
      orientation: reversed ? '逆位' : '正位',
      meaning: Tarot.Cards.meaning(card, reversed)
    };
    session.picks.push(pick);

    // 扇形里少了一张，重新摊开时剩下的按原顺序补位
    session.fanOrder = session.fanOrder.filter(function (id) { return id !== cardId; });

    return pick;
  }

  /**
   * 给「没有牌阵定义可用」的牌位现算一个坐标。
   *
   * 什么情况下会走到这里：调用方给 prepareFan 传了 count，而 count 大于牌阵
   * 自己的牌位数（引擎文档支持这条路，verify.js 里也在跑）。这时多出来的牌
   * 没有内置牌位，只能用兜底坐标。
   *
   * 兜底坐标**必须按序号散开**。原来所有溢出牌位都写死 {x:50, y:45}，
   * 于是它们 100% 重合——两张牌画在完全相同的像素位置上，肉眼只看得见一张。
   * 而且 y=45 不在 8+55k 的刻度上，会打破全局的行距节奏。
   *
   * 现在按一行三张、逐行往下排，和牌阵用同一套刻度：
   *   x 取 14 / 50 / 86（每行都关于中线对称，与本项目其它牌阵同一规则）
   *   y 从 8 起，每行 +55（牌阵坐标的网格步长）
   *
   * @param {number} index 第几张（0 起）
   * @returns {{title: string, asks: string, x: number, y: number}}
   */
  function flowPosition(index) {
    var PER_ROW = 3;
    var COL_X = [14, 50, 86];
    return {
      title: '第 ' + (index + 1) + ' 张',
      asks: '结合牌面说明它与用户问题的关系。',
      x: COL_X[index % PER_ROW],
      y: 8 + Math.floor(index / PER_ROW) * 55
    };
  }

  /**
   * 把挑好的牌收成一次完整的抽牌结果。
   *
   * @param {Object} session prepareFan() 的返回值
   * @param {Array} [session.picks] 已经挑好的牌
   * @returns {Object} 与旧版 draw() 结构一致的结果
   */
  function finalizeDraw(session) {
    if (!session || !Array.isArray(session.picks)) {
      throw new Error('没有可以收尾的抽牌');
    }

    var spread = Tarot.Spreads.get(session.spreadKey);
    if (!spread) {
      throw new Error('没有这个牌阵：' + session.spreadKey);
    }
    if (session.picks.length === 0) {
      throw new Error('还没有挑任何牌');
    }

    // 防御：同一张牌不能出现两次（正常情况下 takeFromFan 已经拦住了）
    var seen = {};
    var cards = session.picks.map(function (pick, index) {
      if (seen[pick.cardId]) {
        throw new Error('同一张牌被挑了两次：' + pick.cardId);
      }
      seen[pick.cardId] = true;

      // 牌位优先用调用方给的（用户选的张数可能和牌阵的牌位数不一致，
      // 这时牌位是另外算出来的）。只有张数正好对上时才用牌阵自己的定义。
      var custom = session.positions && session.positions[index];
      var builtin = spread.positions[index];
      var position = custom || builtin || flowPosition(index);

      var item = {
        index: index,
        cardId: pick.cardId,
        card: pick.card,
        reversed: pick.reversed,
        orientation: pick.orientation,
        position: {
          title: position.title,
          asks: position.asks,
          x: position.x,
          y: position.y
        },
        meaning: pick.meaning
      };
      return item;
    });

    var drawnIds = cards.map(function (item) { return item.cardId; });

    return {
      id: RNG.randomHex(8),
      at: new Date().toISOString(),
      question: session.question,
      spreadKey: spread.key,
      spreadName: spread.name,
      spreadSubtitle: spread.subtitle,
      deckKey: session.deckKey,
      deckLabel: DECKS[session.deckKey].label,
      cards: cards,
      // 审计到这里才收尾：它覆盖的是「洗牌 + 挑完所有牌」这一整段动作
      audit: RNG.auditLine(),
      rng: 'crypto.getRandomValues + Fisher-Yates + 拒绝采样；选牌位置由用户决定',

      // 「追加牌」需要的两个状态，语义要分清，否则很容易读错：
      //   drawnIds  桌上已经有的牌（不含顺序含义，只表示「这些已经用掉了」）
      //   remaining 还没抽出来的牌，按洗好的顺序排列，追加时从前往后取
      // 两者加起来正好是整副牌（第二项被取用时会同步移除），
      // 所以「还剩几张」= remaining.length，不会出现负数这种自相矛盾的结果。
      drawnIds: drawnIds,
      remaining: session.deckOrder.filter(function (id) {
        return drawnIds.indexOf(id) < 0;
      })
    };
  }

  /**
   * 追加抽牌。
   *
   * 从**同一副已经洗好的牌**里继续不放回地抽——这是这个功能唯一说得通的做法：
   * 桌面上已经有「命运之轮」了，追加时又抽出一张「命运之轮」，那次解读就没法看。
   *
   * 正逆位仍然是每次独立掷 50%，熵全部来自 crypto。
   *
   * @param {Object} result draw() 的返回值
   * @param {number} count 要追加几张
   * @returns {Array} 新增的牌（不含原有的）
   */
  function extraCards(result, count) {
    if (!result || !Array.isArray(result.remaining)) {
      throw new Error('这次抽牌没有保存剩余牌序，无法追加。请重新抽一次。');
    }
    var wanted = Math.floor(count);
    if (!isFinite(wanted) || wanted < 1) {
      throw new Error('追加张数必须是不小于 1 的整数');
    }
    if (result.remaining.length === 0) {
      throw new Error('这副牌已经抽完了，没有可以追加的牌。');
    }

    var take = Math.min(wanted, result.remaining.length);

    RNG.startAudit();
    var picked = RNG.sample(result.remaining, take).map(function (id) {
      var card = Tarot.Cards.get(id);
      var reversed = RNG.randomBool();
      return {
        cardId: card.id,
        card: card,
        reversed: reversed,
        orientation: reversed ? '逆位' : '正位',
        meaning: Tarot.Cards.meaning(card, reversed)
      };
    });
    var audit = RNG.auditLine();

    // 从剩余牌里移走这几张，并把它们记进已抽集合。
    // 这样连续追加多次也不会重复，而且 remaining.length 始终等于真实剩余量。
    var tookIds = {};
    picked.forEach(function (item) {
      tookIds[item.cardId] = true;
      result.drawnIds.push(item.cardId);
    });
    result.remaining = result.remaining.filter(function (id) {
      return !tookIds[id];
    });

    result.audit = result.audit + '；追加 ' + picked.length + ' 张：' + audit;

    return picked;
  }

  /**
   * 把抽牌结果拍成一段纯文本，用于喂给 AI 或复制保存。
   * 格式刻意做得规整，方便模型逐条对齐牌位。
   *
   * @param {Object} result draw() 的返回值
   * @param {Object} [opts]
   * @param {boolean} [opts.withMeaning] 是否附上牌义原文，默认 true
   * @returns {string}
   */
  function toText(result, opts) {
    opts = opts || {};
    var withMeaning = opts.withMeaning !== false;
    var lines = [];

    lines.push('【牌阵】' + result.spreadName + '（' + result.spreadSubtitle + '）');
    lines.push('【牌库】' + result.deckLabel);
    lines.push('【问题】' + (result.question || '（用户没有填写具体问题）'));
    lines.push('');
    lines.push('【抽到的牌】');

    result.cards.forEach(function (item, i) {
      lines.push((i + 1) + '. ' + item.position.title + '：' +
        item.card.name + '（' + item.card.en + '） ' + item.orientation);
      if (withMeaning) {
        lines.push('   关键词：' + item.meaning.keywords.join('、'));
        lines.push('   牌义：' + item.meaning.text);
      }
    });

    if (opts.bonus && opts.bonus.length) {
      lines.push('');
      lines.push('【用户主动追加的牌】');
      opts.bonus.forEach(function (item) {
        lines.push('· ' + item.position.title + '：' +
          item.card.name + '（' + item.card.en + '） ' + item.orientation);
        if (withMeaning) {
          lines.push('   关键词：' + item.meaning.keywords.join('、'));
          lines.push('   牌义：' + item.meaning.text);
        }
      });
    }

    return lines.join('\n');
  }

  Tarot.Engine = {
    decks: DECKS,
    deckFor: deckFor,
    prepareFan: prepareFan,
    takeFromFan: takeFromFan,
    finalizeDraw: finalizeDraw,
    extraCards: extraCards,
    toText: toText
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Tarot.Engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
