/*
 * spreads.js —— 牌阵定义
 *
 * 每个牌阵由若干「牌位」组成，每个牌位有三样东西：
 *   title  牌位名（显示在牌下方，也写进给 AI 的提示词）
 *   asks   这个位置在问什么（最重要的字段：AI 靠它定位解读角度）
 *   x / y  在牌桌上的坐标，用于摆放卡牌
 *
 * 坐标是相对的：x 是横向百分比（0-100，对应 900px 基准宽），
 * y 是纵向单位（1 单位 = 2.2px，见 render.js 的 PX_PER_UNIT）。
 *
 * 排版有两条硬约束，写坐标时必须满足，否则牌会互相压住：
 *
 *   纵向：两张牌的中心至少要差 60 个单位
 *         推导：设两张牌的牌心相差 Δ 像素。上面那张的牌位名（画在牌下方）
 *         底边在 Δ + 83 + 46，下面那张的牌面顶边在 Δ - 83。要两者不重叠，
 *         需要 (Δ + 83 + 46) ≤ (Δ - 83) + 212，即 Δ ≥ 129px。
 *         而 1 单位 = 2.2px（render.js 的 PX_PER_UNIT），所以 Δ ≥ 59 单位，取 60。
 *   横向：如果纵向没拉开，x 至少要差 12 个百分点（108px）
 *
 * 这两条由 validate() 和 verify.js 自动检查，改坐标后跑一次就知道有没有问题。
 */
(function (root) {
  'use strict';

  var Tarot = root.Tarot = root.Tarot || {};

  var SPREADS = [
    {
      key: 'single',
      name: '单张牌',
      subtitle: '一张看清当下',
      blurb: '适合一个具体的小问题，或者你只想要一句直话。',
      tokenHint: '短',
      positions: [
        {
          title: '此刻的核心',
          asks: '针对这个问题，当下最需要被看见的是什么？牌面给出的是现状的本质与方向，不是预测。',
          x: 50, y: 8
        }
      ]
    },
    {
      key: 'three-time',
      name: '三张牌 · 时间流',
      subtitle: '过去 → 现在 → 未来',
      blurb: '看一件事怎么走到今天，又可能往哪走。适合有前因后果的问题。',
      tokenHint: '中',
      positions: [
        {
          title: '过去',
          asks: '已经发生且仍在影响这件事的因素。它是怎么把局面推到今天的？',
          x: 22, y: 8
        },
        {
          title: '现在',
          asks: '此刻真实的处境是什么？包括你现在的状态和这件事当前的样子。',
          x: 50, y: 8
        },
        {
          title: '未来',
          asks: '如果延续当前的方向，事情会往哪里去？注意这是趋势而非注定。',
          x: 78, y: 8
        }
      ]
    },
    {
      key: 'three-choice',
      name: '三张牌 · 现状行动结果',
      subtitle: '是什么 → 怎么做 → 会怎样',
      blurb: '最实用的一种。当你已经知道问题，需要的是具体动作。',
      tokenHint: '中',
      positions: [
        {
          title: '现状',
          asks: '这件事的客观处境，以及你手上真正可用的资源与限制。',
          x: 22, y: 8
        },
        {
          title: '行动',
          asks: '你现在最值得做的一件事是什么？要具体到可以执行。',
          x: 50, y: 8
        },
        {
          title: '结果',
          asks: '如果照这个行动去做，事情会朝什么方向发展？',
          x: 78, y: 8
        }
      ]
    },
    {
      key: 'cross-five',
      name: '五张牌 · 小十字',
      subtitle: '比三张多一层：阻碍与环境',
      blurb: '三张牌看不清的时候用这个，多出来的两个位置专门看阻力从哪来。',
      tokenHint: '中长',
      /*
       * 横向坐标一律让**每行都关于中线（x=50）对称**。
       *
       * 早先这里是 x=24/66 与 16/44/72——两行的中心分别落在 45 和 44，
       * 整副牌看着偏左。单张和三张牌阵没问题（22/50/78 本来就是对称的），
       * 多行牌阵就露出来了。
       *
       * 行内间距由牌位名的宽度决定：手机上牌位名约 64px、牌桌 302px，
       * 所以相邻两列至少要差 22 个百分点才不压字。下面按 36 取，留足余量。
       */
      positions: [
        {
          title: '现状',
          asks: '这件事目前的真实样子。',
          x: 14, y: 8
        },
        {
          title: '阻碍',
          asks: '横在中间、让事情推不动的是什么？可能是外部条件，也可能是你自己的某个模式。',
          x: 50, y: 8
        },
        {
          title: '根基',
          asks: '你没意识到的深层原因或过去的积累，它支撑着现在的局面。',
          x: 86, y: 8
        },
        {
          title: '环境',
          asks: '你之外的因素：别人的态度、时机、大环境。哪些不在你控制之内？',
          x: 32, y: 63
        },
        {
          title: '走向',
          asks: '综合以上，这件事会朝哪里走？给出方向而不是结论。',
          x: 68, y: 63
        }
      ]
    },
    {
      key: 'relationship',
      name: '关系牌阵',
      subtitle: '六张看清两个人的互动',
      blurb: '专门用于两个人之间：双方各自的状态、对彼此的期待、以及关系的走向。',
      tokenHint: '中长',
      /*
       * 两行三张，每行都关于中线对称。
       *
       * 早先它是两列三行（x=14/52），整副牌的中心落在 33——偏左 17 个百分点，
       * 是几个牌阵里最歪的一个。改成三列之后，你和对方的状态、期待并排对照，
       * 六张牌也铺得更开。
       */
      positions: [
        {
          title: '你的状态',
          asks: '你带着什么进入这段关系？包括你现在的感受和未说出口的部分。',
          x: 14, y: 8
        },
        {
          title: '对方状态',
          asks: '对方目前的处境与状态。注意区分事实和你的推测。',
          x: 50, y: 8
        },
        {
          title: '关系现状',
          asks: '你们之间此刻真实的互动模式是什么？',
          x: 86, y: 8
        },
        {
          title: '你的期待',
          asks: '你真正想要的是什么？往往和嘴上说的不一样。',
          x: 14, y: 63
        },
        {
          title: '对方期待',
          asks: '对方想从这段关系里得到什么？牌面只能提示，不能替他/她回答。',
          x: 50, y: 63
        },
        {
          title: '可能走向',
          asks: '如果双方都保持现在的方式，关系会走向哪里？',
          x: 86, y: 63
        }
      ]
    },
    {
      key: 'celtic-cross',
      name: '凯尔特十字',
      subtitle: '十张 · 经典全局牌阵',
      blurb: '最完整的经典牌阵，适合复杂处境。解读最长，也最需要你耐心读。',
      tokenHint: '长',
      positions: [
        {
          title: '现状',
          asks: '当前处境的核心。',
          x: 14, y: 8
        },
        {
          title: '横阻',
          asks: '横穿现状的力量：直接的阻碍，或与现状对抗的因素。',
          x: 50, y: 8
        },
        {
          title: '根基',
          asks: '潜意识的动因，或这件事扎根的深层基础。',
          x: 86, y: 8
        },
        {
          title: '近期过去',
          asks: '刚刚过去、正在离开的影响。',
          x: 14, y: 63
        },
        {
          title: '目标或理想',
          asks: '你意识里想要的结果，或这件事可能达到的高度。',
          x: 50, y: 63
        },
        {
          title: '近期未来',
          asks: '接下来不久会出现的事情。',
          x: 86, y: 63
        },
        {
          title: '你的态度',
          asks: '你自己在这件事里的姿态、心态与做法。',
          x: 14, y: 118
        },
        {
          title: '环境与他人',
          asks: '别人的影响、外部条件、不在你控制内的因素。',
          x: 50, y: 118
        },
        {
          title: '希望与恐惧',
          asks: '你既期待又害怕的那个东西——这两者常常是同一件事。',
          x: 86, y: 118
        },
        {
          title: '最终走向',
          asks: '综合全部牌位，事情最终的走向。它是趋势的汇总，不是判决。',
          x: 50, y: 173
        }
      ]
    }
  ];

  var BY_KEY = {};
  SPREADS.forEach(function (spread) { BY_KEY[spread.key] = spread; });

  /**
   * 按 key 取牌阵。
   * @param {string} key
   * @returns {Object|undefined}
   */
  function get(key) {
    return BY_KEY[key];
  }

  /**
   * 牌阵自检。
   *
   * 这里查的是排版硬约束——牌与牌之间够不够开。它比「坐标有没有写」重要得多：
   * 坐标全都在范围内、但两张牌叠在一起，用户看到的就是糊成一团。
   *
   * 约束来自牌的实际尺寸（render.js 里的 CARD_W / CARD_H / PX_PER_UNIT）：
   *   纵向：两张牌中心至少差 MIN_DY 个单位，否则上面那张的牌位名会被下面那张压住
   *   横向：x 至少差 MIN_DX 个百分点，否则牌面本身会重叠
   *
   * @returns {{ok: boolean, errors: Array<string>}}
   */
  /*
   * 排版阈值。
   *
   * 横向阈值固定 12 个百分点（牌宽 104 加余量，桌面基准）。
   *
   * 纵向阈值**不能固定**——它取决于牌有多高，而牌高随屏幕变：
   *   桌面 牌高 166 → 需要约 98 个单位
   *   手机 牌高  89 → 需要约 55 个单位
   *
   * 早先写死 98（按桌面算的），于是手机上牌阵被撑得很松——两张牌之间空出
   * 200 多像素，用户看到的画面是「两个小框飘在大片空白里」。所以改成由
   * render.js 按当前尺寸算好、通过 setMinDy 传进来。
   */
  var MIN_DX = 12;

  /** 当前生效的纵向阈值。默认对应桌面尺寸，浏览器里由 render.js 更新 */
  var minDy = 98;

  /**
   * 更新纵向阈值。render.js 在算出当前尺寸后调用。
   * @param {number} value 单位数
   * @returns {number} 生效后的值
   */
  function setMinDy(value) {
    var n = Number(value);
    if (isFinite(n) && n > 0) minDy = n;
    return minDy;
  }

  function getMinDy() { return minDy; }

  /*
   * 横向阈值同样**不能固定**，理由和纵向一样，只是方向相反：
   *
   * 它要保证的是「同一行的两张牌，牌位名不会互相压住」。牌位名宽约是牌宽的
   * 1.15 倍，换算成「占牌桌宽的百分点」时——
   *   桌面 牌位名 120px / 牌桌 900px ≈ 13.3 个百分点
   *   手机 牌位名  64px / 牌桌 302px ≈ 21.2 个百分点
   * 牌越小，这个比例反而越大。
   *
   * 写死 12 的后果是：窄屏上一行里 x 差 12~21 的两张牌其实已经压在一起了，
   * 而自检返回 ok:true——**这道防线在窄屏是失效的**。
   * （纵向上 verify-layout.js 会拿实测尺寸反查阈值，横向上原本没有对应检查。）
   *
   * 现有牌阵同一行的最小 x 差是 28，所以还没真的爆出来，但它是隐患。
   */
  var minDx = 14;

  /**
   * 更新横向阈值。render.js 在算出当前尺寸后调用。
   * @param {number} value 占牌桌宽的百分点
   * @returns {number} 生效后的值
   */
  function setMinDx(value) {
    var n = Number(value);
    if (isFinite(n) && n > 0) minDx = n;
    return minDx;
  }

  function getMinDx() { return minDx; }

  /**
   * 牌阵自检。
   *
   * 这里查的是排版硬约束——牌与牌之间够不够开。它比「坐标有没有写」重要得多：
   * 坐标全都在范围内、但两张牌叠在一起，用户看到的就是糊成一团。
   *
   * @returns {{ok: boolean, errors: Array<string>}}
   */
  function validate() {
    var errors = [];
    var seen = {};

    SPREADS.forEach(function (spread) {
      if (seen[spread.key]) errors.push('牌阵 key 重复：' + spread.key);
      seen[spread.key] = true;

      if (!spread.positions || spread.positions.length === 0) {
        errors.push(spread.key + ' 没有牌位');
        return;
      }

      var titles = {};
      spread.positions.forEach(function (pos, i) {
        var where = spread.key + ' 第 ' + (i + 1) + ' 位';
        if (!pos.title) errors.push(where + ' 缺少 title');
        if (!pos.asks) errors.push(where + ' 缺少 asks');
        if (titles[pos.title]) errors.push(where + ' 的牌位名「' + pos.title + '」重复');
        titles[pos.title] = true;

        if (typeof pos.x !== 'number' || typeof pos.y !== 'number') {
          errors.push(where + ' 缺少坐标');
          return;
        }
        // 横向要留得下整张牌（牌宽 104px ≈ 11.6 个百分点，两侧各留一点）
        if (pos.x < 6 || pos.x > 88) {
          errors.push(where + ' 的 x=' + pos.x + ' 超出可用横向范围（6-88）');
        }
        if (pos.y < 0 || pos.y > 320) {
          errors.push(where + ' 的 y=' + pos.y + ' 超出可用纵向范围（0-320）');
        }
      });

      // 两两检查：不够开就报出来，并写清差多少
      for (var a = 0; a < spread.positions.length; a++) {
        for (var b = a + 1; b < spread.positions.length; b++) {
          var pa = spread.positions[a];
          var pb = spread.positions[b];
          if (typeof pa.x !== 'number' || typeof pb.x !== 'number') continue;

          var dy = Math.abs(pa.y - pb.y);
          var dx = Math.abs(pa.x - pb.x);

          // 纵向够开就没事；纵向不够就必须靠横向错开
          if (dy >= minDy) continue;
          if (dx >= minDx) continue;

          errors.push(spread.key + ' 的「' + pa.title + '」与「' + pb.title +
            '」会叠在一起（纵向差 ' + dy + ' 需 ≥' + minDy +
            '，横向差 ' + dx + ' 需 ≥' + minDx.toFixed(1) + '）');
        }
      }
    });

    return { ok: errors.length === 0, errors: errors };
  }

  Tarot.Spreads = {
    all: SPREADS,
    get: get,
    validate: validate,
    /** 默认牌阵 */
    defaultKey: 'single',
    /**
     * 纵向阈值：两张牌的牌心至少差这么多单位，牌面与牌位名才不会互相压住。
     *
     * 它是**动态**的——由 render.js 按当前牌的像素尺寸算好传进来，
     * 因为牌高随屏幕变（桌面 166、手机 89）。用 setMinDy 更新、minDy 读取。
     *
     * verify-layout.js 会拿实测尺寸反过来核对这个值：阈值一旦偏小，
     * validate() 就会放过真实的压盖，那条测试就是防线。
     */
    setMinDy: setMinDy,
    /**
     * 横向阈值：同一行两张牌至少差这么多**百分点**，牌位名才不会互相压住。
     *
     * 和纵向一样是动态的——由 render.js 按当前牌宽算出（牌位名宽约是牌宽的
     * 1.15 倍，而它占牌桌宽的比例在窄屏更大）。用 setMinDx 更新、minDx 读取。
     */
    setMinDx: setMinDx
  };

  // minDy / minDx 用取值器暴露：它们是变量，直接挂上去会永远停在初始值
  Object.defineProperty(Tarot.Spreads, 'minDy', {
    get: getMinDy,
    enumerable: true
  });

  Object.defineProperty(Tarot.Spreads, 'minDx', {
    get: getMinDx,
    enumerable: true
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = Tarot.Spreads;
})(typeof globalThis !== 'undefined' ? globalThis : this);
