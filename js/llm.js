/*
 * llm.js —— AI 解读层
 *
 * 这一层负责：组提示词 → 调用你配置的模型 → 校验返回内容。
 * 抽牌和牌义都在本地完成，只有「解读」这一步会联网。
 *
 * 设计上的两个重点：
 *
 * 1) 结构化返回。要求模型返回固定字段的 JSON（总览 / 逐牌解读 / 综合建议 /
 *    行动清单），而不是自由发挥的散文。字段固定才能在页面上分区渲染，
 *    也才能机械校验。
 *
 * 2) 引文核对。要求模型为每个牌位附上一句「引自牌义原文」的话，然后本地把
 *    这些引文拿去和真正抽到的牌的牌义逐字比对。对不上的会被标出来。
 *
 *    为什么值得做这件事：塔罗解读里最容易出现的错误不是结论不好，而是
 *    模型把某张牌的意思记串了——比如把「宝剑八」的自我设限说成「宝剑九」
 *    的焦虑。被要求引用原文后，这类错误会显著减少；而剩下的错误，本地的
 *    逐字核对能把它们抓出来。这和 crush-meter 里核对聊天原文是同一个思路：
 *    把「模型说了什么」和「原文里到底有什么」分开。
 */
(function (root) {
  'use strict';

  var Tarot = root.Tarot = root.Tarot || {};

  /* ------------------------------------------------------------------ *
   * 接口配置预设
   * ------------------------------------------------------------------ */

  var PROVIDERS = [
    {
      key: 'deepseek',
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      note: '中文解读质量好，价格低，指令跟随稳。推荐首选。'
    },
    {
      key: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      note: '需要能访问 OpenAI 的网络环境。'
    },
    {
      key: 'moonshot',
      label: 'Kimi（月之暗面）',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-8k',
      note: '中文长文解读顺，国内直连。'
    },
    {
      key: 'qwen',
      label: '通义千问',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      note: '阿里云百炼的 OpenAI 兼容入口。'
    },
    {
      key: 'ollama',
      label: 'Ollama（本机）',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b',
      note: '完全本地运行，牌面信息一步都不出你的电脑。质量看你本地模型。'
    },
    {
      key: 'custom',
      label: '自定义',
      baseUrl: '',
      model: '',
      note: '任何 OpenAI 兼容接口，填带 /v1 的地址。'
    }
  ];

  /* ------------------------------------------------------------------ *
   * 提示词
   * ------------------------------------------------------------------ */

  /**
   * 把抽牌结果编排成给模型的牌面清单。
   * 每条都带上牌位在问什么、牌的正逆位、关键词与完整牌义——
   * 牌义原文是模型唯一被允许引用的依据。
   *
   * @param {Object} result
   * @returns {string}
   */
  function formatSpreadForPrompt(result) {
    var lines = [];
    result.cards.forEach(function (item, i) {
      lines.push('【牌位 ' + (i + 1) + '：' + item.position.title + '】');
      lines.push('  这个牌位在问：' + item.position.asks);
      lines.push('  抽到的牌：' + item.card.name + '（' + item.card.en + '，' +
        item.card.suitLabel + '） ' + item.orientation);
      lines.push('  关键词：' + item.meaning.keywords.join('、'));
      lines.push('  牌义原文：' + item.meaning.text);
      lines.push('  传统建议：' + item.meaning.advice);
      lines.push('');
    });
    return lines.join('\n');
  }

  /**
   * 组装 system 提示词。
   *
   * 这里的每一条约束都对应一个具体的失败模式，不是客套话：
   *   - 「不要复述牌义」→ 否则模型会抄一遍牌义当成解读
   *   - 「必须引用原文」→ 防止把牌记串，也让本地能做引文核对
   *   - 「不要断言他人想法」→ 塔罗最容易被滥用成读心术
   *   - 「不要预测具体事件」→ 避免「你会在 3 月遇到贵人」这类无法证伪的输出
   *   - 「不要做医疗/法律/投资结论」→ 边界问题
   *
   * @returns {string}
   */
  function buildSystemPrompt() {
    return [
      '你是一位塔罗解读师。用户会给你一个真实的问题，以及他刚刚用真随机抽出的牌。',
      '',
      '你的任务是给出一个**他能用得上的答案**，不是一份完整的解读报告。',
      '',
      '## 最重要的三条',
      '',
      '1. **第一句必须能拿来做决定。**',
      '   他问「能不能 / 行不行 / 该不该 / 会不会 / 值不值」这类**是非题**时，',
      '   verdict 的第一句**只能是「能」或「不能」**（或「该」/「不该」、「会」/「不会」、',
      '   「值」/「不值」），一个词，句号。',
      '   **不许写「倾向于能」「可能可以」「大概率」「要看情况」「因人而异」**——',
      '   那些词等于没回答，他读完还是不知道该干嘛。',
      '   条件和理由从**第二句**开始写：「不能。因为……」比「倾向于不能，但要看你……」',
      '   有用得多。',
      '   他问「怎么办 / 为什么」这类开放题时，第一句给一个明确的方向（做什么），',
      '   不要先铺陈背景。',
      '2. **每句话都要有信息量。** 判断标准很简单：把这句话删掉，读者会损失什么吗？',
      '   不会，就不要写。「这段关系需要更多的沟通与理解」就是这种话——',
      '   删掉它什么也没丢，而且它套在任何一段关系上都成立。',
      '3. **不要复述牌义。** 牌义用户点一下牌面就能看到全文。',
      '   你只负责说它对这个问题的含义，以及它和别的牌怎么互相印证或冲突。',
      '',
      '## 硬性要求',
      '',
      '1. 严格按用户给出的 JSON 结构返回，只输出 JSON，不要加代码围栏、不要加解释文字。',
      '2. **每个牌位都必须给一句 quote**：从该牌下面的「牌义原文」那一行里',
      '   原样摘取 10 到 40 字的连续文字，一字不改。',
      '   **不要从「传统建议」那一行摘**——那是牌面给的建议，不是牌义，',
      '   摘了会被本地核对判为不通过（用户看到的是「标红」，以为你记错了牌）。',
      '   这是用来核对你有没有把牌记串的，不要改写、不要拼接、不要自己创作。',
      '3. **每张牌只讲它自己额外提供的东西。** gist 用一句话（不超过 30 字）说这张牌在',
      '   这个牌位说明了什么；reading 再补 1 到 2 句，只写 gist 没提到的部分。',
      '   **如果这张牌对结论没有额外贡献，reading 就写「与结论一致，没有额外提示」。**',
      '   十个牌位里有两三张是陪衬，这是正常的。硬给每张牌编一个独特含义，',
      '   只会把真正的重点稀释掉——那比留白更糟。',
      '4. verdict 和每条 gist 里都要出现用户问题里的具体词（问题下面会列出',
      '   「这件事涉及的具体方面」，那些词是用户自己用的）。',
      '   反例：「这段关系需要更多的沟通与理解」——删掉问题它照样成立，等于没说。',
      '   正例：「关于要不要接这个 offer：牌面显示你顾虑的不是能力，',
      '   而是它把你绑在现在的城市，这一点比薪资更该先谈清楚。」',
      '',
      '## 边界',
      '',
      '- 塔罗牌是随机抽的，它对未来没有预测力。你要做的是提供思考角度，不是预言。',
      '- 不要把自己的解读说成事实：谈任何人的想法、感情或将来会做什么时，',
      '  都要写成「牌面显示」「从牌上看」而不是「他就是这样」。',
      '  **但这不意味着可以回避问题。** 用户问的是别人的事（「他们互相喜欢吗」、',
      '  「他还会回来吗」），你就要正面回答那件事，只是把话留在「看上去 / 倾向于」',
      '  的层面——绝对不要因为被问的是第三方，就把话题换成「你自己怎么看这段关系」。',
      '  那是答错题，不是谨慎。',
      '- 不要给出具体的时间点、金额、姓名等无法证伪的细节。',
      '- 不要替用户做医疗、法律、投资上的决定。涉及这些时，建议他找对应专业的人。',
      '- 如果牌面整体偏负面，不要粉饰，但也不要制造恐慌；说清风险，给出可执行的应对。',
      '- 语气：平实、具体、像一个说真话的朋友。不要神秘化，不要「宇宙能量」这类说法，',
      '  不要用「亲爱的」称呼用户。',
      '',
      '## 输出格式',
      '',
      '严格返回这样一个 JSON 对象（不要有多余字段）：',
      '{',
      '  "verdict": "是非题：第一句是判断本身，一个词加句号，而且要用问句里的那个词——' +
        '问「该不该」答「该。/ 不该。」，问「喜欢吗」答「喜欢。/ 不喜欢。」。' +
        '开放题：第一句直接给方向，不要用「该 / 能 / 会 / 可以」这类词开头——' +
        '用户问的是「怎么办」，把它答成「该」等于答错题。' +
        '第二句起再说理由和条件。' +
        '这是整份解读里最重要的部分——很多人只会读这一段，' +
        '所以答案要放在这里，不要留到后面才说。",',
      '  "cards": [',
      '    {',
      '      "index": 1,',
      '      "position": "牌位名，原样照抄",',
      '      "quote": "从该牌牌义原文里原样摘取的 10-40 字",',
      '      "gist": "一句话，不超过 30 字：这张牌在这个牌位说明了什么。",',
      '      "reading": "1 到 2 句补充，只写 gist 没说到的。" +',
      '                 "没有额外信息就写：与结论一致，没有额外提示。"',
      '    }',
      '  ],',
      '  "actions": ["2 到 3 条具体行动，每条都要能落到可验证的动作上"]',
      '}',
      '',
      'cards 数组必须和用户的牌位数量一致，index 从 1 开始，顺序不能变。',
      'actions 只给 2 到 3 条——一个人真正会做的不会超过三条，凑数是负价值。'
    ].join('\n');
  }

  /**
   * 组装 user 提示词。
   *
   * 关键在「## 我的问题」这一节：不只给问题原文，还把拆解出来的要素一并列出
   * （在问哪件事、是不是一个二选一、顾虑是什么、有什么硬约束）。
   * 只丢一段原文的话，模型很容易把它读成一个「话题」然后泛泛而谈；
   * 把这些拆开摆出来，它就没法绕过去。
   *
   * @param {Object} result
   * @returns {string}
   */
  function buildUserPrompt(result) {
    var parts = [];
    var question = parseQuestion(result.question);

    parts.push('## 我的问题');
    if (question.isBlank) {
      parts.push('（我没有写具体问题，请按「我当下最需要知道什么」来解读。）');
    } else {
      parts.push('原话：' + question.raw);

      /*
       * 主体约束必须紧跟在原话后面。
       *
       * 它是读这句话的前提。放到后面的建议段就太晚了——模型那时已经按
       * 「问的是自己」把每张牌解释完，再要求它换主语只会换来一段自相矛盾
       * 的输出。塔罗解读的默认偏向就是把一切读成求问者的内心，不明确
       * 顶掉这个默认值，它就会一直生效。
       */
      if (question.hints.subject === 'third') {
        parts.push('');
        parts.push('**注意：这件事问的是他们（他 / 她），不是我。**');
        parts.push('我不是这件事里的任何一方，我只是在旁边问。');
        parts.push('每一条 reading 的主语都必须是他们——不要写成「你现在的状态」「你该注意的是」，' +
          '那等于偷偷把问题换成了另一个。');
        parts.push('只有在「可以去做的事」那一段才可以用「你」，那是在回答我该怎么办，' +
          '不是把牌面解释成我的心理。');
        parts.push('如果某张牌讲的确实是我在这件事里的位置，就明说' +
          '「这张讲的是你在旁边的处境」，不要不声不响地把主语换掉。');
      } else if (question.hints.subject === 'mixed') {
        parts.push('');
        parts.push('**注意：这件事里我和另一个人都在场。**');
        parts.push('每一条 reading 要说清主语是谁——哪部分是对方的状态，哪部分是我的。');
        parts.push('不要把对方的状态写成我的心理，也不要用「你们」把两个人的事糊成一团。');
      }

      if (question.isOpen) {
        /*
         * 开放式的问法。
         *
         * 这里必须给出**专门的解读指令**，而不是像早先那样只贴一句「问题比较笼统」。
         * 那句话既劝退了用户，也没告诉模型该怎么答好——两头不落。
         *
         * 开放问题的正确读法：它要的不是预测事件，而是「此刻最值得留意什么」。
         * 所以要求模型把牌读成一面镜子（此刻的处境与注意力），而不是一张日程表。
         */
        parts.push('');
        parts.push('这是一个**开放式的**问题：' +
          (question.hints.timeframe ? '范围是「' + question.hints.timeframe + '」，' : '') +
          '里面没有指向某件具体的事。开放问题不需要改写成具体问题——它的正常读法是这样的：');
        parts.push('- 把牌读成对「此刻处境」的映照，而不是对事件的预告。');
        parts.push('- 与其说会发生什么，不如指出**什么值得留意**：哪种心态、哪类事情、哪个已经存在的信号。');
        parts.push('- 结合牌位本身的含义去读（牌阵的每个位置本来就在问一个角度）。');
        parts.push('- 不要写「可能会有意外的消息」这类谁都能套的空话，也不要指定具体时间、地点、人名。');
        parts.push('- 行动建议仍然要给，落在「今天可以做的一件小事」这个尺度上。');
        parts.push('- **verdict 不要用「该」「能」「会」「可以」「值得」这类是非判断词开头**——' +
          '我问的是「怎么办」，不是「该不该」。把它读成是非题、回我一个「该。」，就是答错题。');
      } else {
        if (question.hints.about) {
          parts.push('');
          parts.push('这件事涉及的具体方面：' + question.terms.join('、'));
          parts.push('核心是：' + question.hints.about +
            '　←　每一条 reading 都必须出现上面这些词里的至少一个，并且真的在回应它');
        } else if (question.terms.length) {
          parts.push('');
          parts.push('这件事涉及的具体方面：' + question.terms.join('、'));
        }

        /*
         * 答案词的要求独立于 choice / verdict 的分类。
         *
         * 这两条开关各自的含义是「要不要说清支持哪一边」「是不是是非问」，
         * 而「第一句必须用哪个词」只跟问题实际用的判断词有关。早先把答案词
         * 挂在 choice 分支里，于是「需不需要找她谈一次」——它命中判断词表
         * （需要 / 不需要），但既不含「还是」也不以「吗」结尾，choice 和
         * verdict 都是 false——答案词的要求就整个丢失了，模型又回到自由发挥。
         *
         * 所以这里先按 verdictWord 单独处理；只有确实没有判断词时，
         * 才退回「说清支持哪一边」的通用说法。
         *
         * 这样也避免另一类冲突：若一个问题同时命中 choice 和 verdict
         * （「我要不要联系她，这样做可以吗」），两个分支都 push 会给出
         * 「要 / 不要」和「能 / 不能」两套互相矛盾的要求。
         */
        if (question.hints.verdictWord) {
          var word = question.hints.verdictWord;
          parts.push('');
          parts.push('这是一个**是非判断**的问题：我想知道这样做行不行、有没有用。');
          parts.push('**verdict 的第一句只能是「' + word.yes + '」或「' + word.no + '」**（一个词加句号）。');
          parts.push('不要写「倾向于' + word.yes + '」「可能' + word.yes + '」这类模棱两可的说法，' +
            '也不要用「看情况」「因人而异」把问题推回来——');
          parts.push('我要的是一个能直接拿去做决定的答案，不是一段权衡，也不要只写「要权衡」。');
          parts.push('第二句开始再说依据是哪张牌的哪一点。');
          parts.push('如果答案取决于某个条件，写成「' + word.yes + '。前提是……」或者「' + word.no + '。除非……」——');
          parts.push('**判断在前，条件在后**。');
        } else if (question.hints.yesNo) {
          /*
           * 是非问句，但判断词表抽不出答案词（「他喜欢我吗」）。
           *
           * 这时不能像 verdictWord 分支那样硬指定「必须是某个词」——猜错词比
           * 不指定更糟（问「喜欢吗」硬要「能 / 不能」是另一场答错题）。改成
           * 要求模型复用问句里的动词：答案词虽然抽不出来，但问题本身写着，
           * 模型照着用一个就行。
           */
          parts.push('');
          parts.push('这是一个**是非问句**：它有明确答案，只是没用到「该 / 能不能」这类判断词。');
          parts.push('**verdict 的第一句必须直接回答，并且复用我问句里的那个动词**——' +
            '我问「喜欢吗」就用「喜欢 / 不喜欢」，问「会回来吗」就用「会 / 不会」。');
          parts.push('不要把答案换成一个我不认识的判断词（我问「喜欢」，回一个「该」就是答错题）。');
          parts.push('也不要用「倾向于」「可能」「看情况」把问题推回来，' +
            '我要的是一个能直接拿去做决定的答案。');
        } else if (question.hints.choice) {
          parts.push('');
          parts.push('这是一个「要做选择」的问题。请在第一句就明确说往哪一边，' +
            '依据是什么；不要只说「要多权衡」。');
        }
        if (question.hints.stake) {
          parts.push('我提到的顾虑：' + question.hints.stake);
        }
        if (question.hints.constraints.length) {
          parts.push('我提到的具体条件：' + question.hints.constraints.join('、'));
        }
        if (question.isVague) {
          parts.push('');
          parts.push('注意：这个问题短到看不出在问什么。请先在 verdict 里说明你理解到的是什么，' +
            '并就那件事来解读，而不是给通用的建议。');
        }
      }
    }

    parts.push('');
    parts.push('## 我抽到的牌');
    parts.push('牌阵：' + result.spreadName + '（' + result.spreadSubtitle + '）');
    parts.push('牌库：' + result.deckLabel);
    parts.push('');
    parts.push(formatSpreadForPrompt(result));

    parts.push('## 补充说明');
    parts.push('这' + result.cards.length + '张牌是用系统加密随机源抽出的，正逆位在你点下每张牌的');
    parts.push('瞬间独立掷出，选牌位置由你决定，没有任何人为干预。');
    parts.push('请按上面的格式返回 JSON，共 ' + result.cards.length + ' 个牌位。');

    return parts.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 返回解析与校验
   * ------------------------------------------------------------------ */

  /**
   * 这个问题是不是在要一个「能 / 不能」的判断？
   *
   * 中文的是非问句在形式上很好认：句末的「吗 / 呢 / 吧」，或者「该不该」「能不能」
   * 「会不会」「可不可以」这类正反并列的助动词，或者「值不值得」「有没有用」。
   * 看到这些就说明用户在问一件**具体的事**，要的是明确判断——这类问题不该被
   * 归成开放式，哪怕词表一个词都没抽到。
   *
   * 一个真实的失败例子：「我现在继续和她打游戏可以增加好感吗」。它指向很具体
   * 的一件事（继续打游戏、增进好感），却因为词表里没有「游戏」「好感」而被
   * 判成开放问题，页面上写「这是个开放的问题」——完全读错了。
   *
   * @param {string} raw
   * @returns {boolean}
   */
  function asksForJudgment(raw) {
    // 「该不该 / 能不能 / 会不会 / 要不要 / 是不是 / 值不值得 / 有没有…」
    if (/该不该|该不该|应不应该|能不能|可不可以|会不会|要不要|是不是|有没有|值不值得|值不值|行不行|好不好|对不对|算不算|要不要|用不用|需不需要/.test(raw)) {
      return true;
    }
    // 「可以…吗」「能…吗」「会…吗」「值得…吗」——助动词与句末疑问词的组合
    if (/(可以|能|会|值得|有|是|要|该|需要|应该)[^。！？]{0,12}(吗|呢|吧)[？?。！!]*$/.test(raw)) {
      return true;
    }
    return false;
  }

  /**
   * 这个是非问句用的是哪一个判断词。
   *
   * 中文里「该 / 要 / 能 / 会 / 值得 / 是不是」这几组词语感很接近，但**答案词
   * 不能互换**：问「要不要破冰」答「该」是答错了题——形式上是个判断，跟问题
   * 对不上。真实发生过一次：用户问「要不要主动联系」，页面上第一句是「该。」，
   * 用户立刻指出「我问的是要不要，回了一个该」。
   *
   * 以前这里只有一个 verdict 布尔值，提示词里写死「第一句只能是「能」或「不能」」，
   * 于是所有是非问都被逼着往「能 / 不能」上靠。现在按问题实际用的词给出答案对。
   *
   * 顺序有讲究：更长的组合要先命中，否则「是不是该」会被「是不是」抢走，
   * 「有没有用」会被「有没有」抢走。
   *
   * @param {string} raw
   * @returns {{yes: string, no: string}|null}
   */
  function judgmentWordOf(raw) {
    /*
     * 顺序有讲究，因为一句话可能同时命中好几条，先命中的说了算。
     *
     * 「我需要辞职吗」里含「要辞职吗」，所以「需要」必须排在「要」前面，
     * 否则答案词会从「需要 / 不需要」被抢成「要 / 不要」。
     *
     * 「对不对」的答案是「对 / 不对」而不是「是 / 不是」——问「我做得对吗」
     * 回一个「是」在中文里就是答错了题。所以「对不对」和「是不是」拆成两条。
     *
     * 每条的第二种写法（「该…吗」「能…吗」「要…吗」…）是为了对齐
     * asksForJudgment 的正则：那边认「我能考上吗」是是非问句，这边就得能
     * 从中取出「能 / 不能」，否则分类对了但 prompt 里没有答案词要求。
     */
    /*
     * 先把「不是判断词的要」抹掉，再做匹配。
     *
     * 真实 bug：「她之前想要说的事是她被表白了吗」被抽成 {要, 不要}，
     * 模型于是答了「要。」——但问题问的是「是 / 不是」。
     * 「想要说」里的「要」属于「想要」，跟要不要做某件事毫无关系。
     *
     * 抹成等长全角空格而不是直接删，因为下面每条正则都带
     * 「[^。！？]{0,12}」的距离约束，删掉会让本来隔得远的两个字
     * 贴到一起，凭空命中。长度必须守恒。
     *
     * 「需要」故意不抹：它自己就是一条判断词（「我需要辞职吗」），
     * 而且排在「要」前面，会先命中。
     */
    var probe = raw.replace(/想要|主要|重要|要求|要是|只要|快要|将要|偏要|硬要/g,
      function (m) { return new Array(m.length + 1).join('\u3000'); });

    var table = [
      /*
       * 「是不是 X」里的 X 本身是判断动词时，答案词该由 X 定。
       *
       * 「是不是应该冷静」问的是「该不该冷静」，回一个「是。」读起来
       * 像在回答「是不是」，实际该答「该。」。这类问法的 X 被前面的
       * 「是不是」一口吞掉，答案词就降级成了「是 / 不是」。
       *
       * 只认这几个：它们跟在「是不是」后面时几乎不可能是名词的一部分。
       * 刻意不含单字「能」和「会」——「是不是能力不够」「是不是会员」
       * 里那个字都是名词的开头，认了反而会把「是 / 不是」问成「能 / 会」。
       * 「要」可以认，因为「要求」在上面已经抹成空格了。
       */
      { re: /该不该|应不应该|(?:应该|该)[^。！？]{0,12}(吗|呢|吧)[？?。！!]*$/, yes: '该', no: '不该' },
      { re: /需不需要|需要[^。！？]{0,12}(吗|呢|吧)[？?。！!]*$/, yes: '需要', no: '不需要' },
      { re: /要不要|用不用|要[^。！？]{0,12}(吗|呢|吧)[？?。！!]*$/, yes: '要', no: '不要' },
      { re: /有没有用|有用吗|有效吗|管用吗/, yes: '有用', no: '没用' },
      { re: /值不值得|值不值|值得[^。！？]{0,12}(吗|呢|吧)[？?。！!]*$/, yes: '值得', no: '不值得' },
      { re: /能不能|可不可以|(?:可以|能)[^。！？]{0,12}(吗|呢|吧)[？?。！!]*$/, yes: '能', no: '不能' },
      { re: /会不会|会[^。！？]{0,12}(吗|呢|吧)[？?。！!]*$/, yes: '会', no: '不会' },
      { re: /行不行|行[^。！？]{0,12}(吗|呢|吧)[？?。！!]*$/, yes: '行', no: '不行' },
      { re: /好不好|好[^。！？]{0,12}(吗|呢|吧)[？?。！!]*$/, yes: '好', no: '不好' },
      { re: /算不算|算[^。！？]{0,12}(吗|呢|吧)[？?。！!]*$/, yes: '算', no: '不算' },
      { re: /对不对|对[^。！？]{0,12}(吗|呢|吧)[？?。！!]*$/, yes: '对', no: '不对' },
      { re: /(?:是不是|是否)|是[^。！？]{0,12}(吗|呢|吧)[？?。！!]*$/, yes: '是', no: '不是' },
      { re: /有没有|有[^。！？]{0,12}(吗|呢|吧)[？?。！!]*$/, yes: '有', no: '没有' }
    ];
    for (var i = 0; i < table.length; i++) {
      if (table[i].re.test(probe)) return { yes: table[i].yes, no: table[i].no };
    }
    /*
     * 兜底：中文的「A 不 A」结构——「爱不爱」「去不去」「合不合适」
     * 「走不走得通」。这类问法比表里那几种更随意，但它们同样是在要一个
     * 判断，答案词也是现成的：A / 不 A。
     *
     * 必须放在最后，因为前面几条更精确：「需不需要」的答案是
     * 「需要 / 不需要」，不能被这条抢成「需 / 不需」。
     *
     * 只匹配「A不A」这个字形结构，所以「不管」「不但」「不过」「不仅」
     * 「差不多」「不好意思」都不会被误伤——它们要匹配得写成
     * 「管不管」「但不但」才行。
     */
    var abab = probe.match(/([\u4e00-\u9fa5])不\1/);
    if (abab) return { yes: abab[1], no: '不' + abab[1] };
    return null;
  }

  /**
   * 这个问题是不是在要「值得留意什么」这类内容？
   *
   * 这是开放问法的标志。它和第 2 条的判据会冲突，所以必须优先判断：
   * 「今天会发生什么吗」结尾是「吗」，形式上是非问句，但它问的其实是内容。
   *
   * @param {string} raw
   * @returns {boolean}
   */
  function wantsOpenReading(raw) {
    /*
     * 「怎么办」「该怎么做」必须在这里，否则会掉进下面两个坑：
     *
     *   「我该怎么办呢」→ asksForJudgment 的「(该)…(呢)$」正则命中，
     *   pointsAtSomething 变成 true，isOpen 被判成 false——一个标准的
     *   开放题被当成是非问，然后要求模型「复用我问句里的动词」。
     *
     * 加进词表后 wantsOpen 优先，这类问法直接走开放分支。
     */
    return /留意|注意点|该注意|值得注意|关注什么|会发生些什么|会发生什么|遇到什么|有什么值得|什么值得|会怎样|会怎么样|怎么样|如何发展|走向如何|运势|运气|怎么办|该怎么做|怎么做|如何是|该怎么/.test(raw);
  }

  /**
   * 把用户的问题拆开，找出模型必须正面回应的那些信息。
   *
   * 只把问题整段丢给模型是不够的——它会读成一个「话题」，然后围绕这个话题说
   * 一通放之四海皆准的话。真正让它没法泛泛而谈的办法，是把问题里的**具体要素**
   * 单独拎出来摆在它面前：在问哪件事、卡在什么选择上、顾虑是什么。
   *
   * 问题分三类，处理方式完全不同：
   *
   *   blank  留空。按「我当下最需要知道什么」来读。
   *   open   开放式的问法，比如「我今天会发生些什么」「这段时间该留意什么」。
   *          **这是完全正当的塔罗问法**，不是「问得不好」。它有明确的时段或
   *          范围，只是没有具体的事。要给它专门的解读指令，不能劝退用户。
   *   normal 指向具体的事，按常规方式拆解要素。
   *
   * 早先只有「具体 / 空泛」两分，把 open 和 blank 一起打成了「问题太笼统」并弹警告，
   * 等于告诉用户一个塔罗本来就该答的问题不该问。那是个判断错误，不是用户的问题。
   *
   * @param {string} text
   * @returns {{raw, isBlank, isOpen, isVague, kind, terms, hints}}
   */
  function parseQuestion(text) {
    var raw = String(text || '').trim();

    if (!raw) {
      return {
        raw: '', isBlank: true, isOpen: false, isVague: false, kind: 'blank', terms: [],
        hints: {
          choice: false, about: '', stake: '', constraints: [], timeframe: '',
          subject: 'self'
        }
      };
    }

    var terms = extractTerms(raw);

    // 时段：问题里提到的时间范围。开放问题往往就靠它撑起来。
    var timeframe = terms.filter(function (t) { return categoryOf(t) === 'time'; })[0] || '';

    /*
     * 是非问句要带上它实际用的判断词（要/不要、该/不该、能/不能…）。
     * 分类还是照旧（这类句子同时算 choice），但提示词需要知道答案该用哪个词。
     */
    var judgmentWord = judgmentWordOf(raw);

    /*
     * 主体：这件事问的是谁。
     *
     * 塔罗解读有一个很强的默认偏向——把一切都读成「求问者自己的内心」。
     * 于是问「他们互相喜欢吗」，模型会答成「你当下的关系状态是停滞的」。
     * 答案读起来像是给了判断，其实主语被悄悄换掉了，答的是另一个问题。
     *
     * 提示词里必须明确这件事问的是谁，否则模型没有理由不用它的默认值。
     *
     * 只做三分，因为再细的语义判断用正则做不可靠：
     *
     *   self   只出现提问者自己（默认，提示词里什么都不用加）
     *   mixed  同时出现「我」和第三方（「他喜欢我吗」）——两边都要说清
     *   third  只有第三方，提问者不在场（「他们互相喜欢吗」）
     *
     * 「其他」「吉他」「他处」里的「他」不是人称代词，先去掉再判，
     * 否则「吉他买哪个好」会被当成在问别人。
     *
     * 「我」同理有定语用法：「我朋友和她男朋友会分手吗」问的是那两个人，
     * 提问者只是认识他们；「他对我朋友有意思吗」问的也是他对朋友。
     * 「我」后面跟了亲属／社交关系名词时，它是定语不是主体，先摘掉再判。
     */
    var selfText = raw.replace(
      /我(?:们家|朋友|同事|家人|闺蜜|室友|对象|男朋友|女朋友|前任|对象|爸|妈|哥|姐|弟|妹|家|公司|老板|老师|同学|邻居|亲戚)/g, '');
    var mentionsSelf = /我/.test(selfText);
    var thirdText = raw.replace(/其他|吉他|他处|他日|他乡/g, '');
    var mentionsThird = /他们|她们|对方|那个人|这个人/.test(thirdText) ||
      /[他她]/.test(thirdText);
    var subject = mentionsThird ? (mentionsSelf ? 'mixed' : 'third') : 'self';

    var hints = {
      /*
       * 问句类型。两者要分开，因为它们需要的回答形状不同：
       *
       *   choice  二选一／多选一：「要不要辞职」「该不该接受」「A 还是 B」
       *           → 要说清牌面支持哪一边
       *   verdict 是非判断：「继续打游戏可以增加好感吗」「这样会有用吗」
       *           → 要给一个明确的判断，不能只说「要平衡」
       *
       * 早先只认 choice，于是「…可以增加好感吗」这类判断句在提示词里
       * 一点要求都没有，模型很容易回一段「感情需要双方努力」的废话。
       */
      choice: /该不该|应不应该|是不是该|要不要|还是|或是|选哪|哪个|二选一/.test(raw),
      verdict: /(可以|能|会|值得|应当|应该|需要)[^。！？]{0,10}(吗|吧)[？?。！!]*$/.test(raw) ||
        /值不值得|值不值|有没有用|有用吗|有效吗|管用吗|行不行|好不好|对不对|算不算/.test(raw) ||
        // 有判断词的都算判断句（含「A 不 A」兜底识别出来的那些）
        !!judgmentWord,
      /*
       * 「往哪一边」的具体词。空值表示问题没有明确的判断词（例如「A 还是 B」），
       * 提示词就只说「说清支持哪一边」，不指定词语。
       */
      verdictWord: judgmentWord,
      // 锚点：优先取「一件事 / 一个决定」，时间词只作兜底
      about: pickAnchor(terms),
      // 顾虑：出现「但 / 怕 / 担心 / 纠结」时把它们后面那截摘出来
      stake: (raw.match(/(?:但是|但|可又|只是|怕|担心|纠结|不确定|舍不得|放不下)([^。！？；;]{2,30})/) || [])[1] || '',
      constraints: (raw.match(/(?:\d+|[一二三四五六七八九十])\s*(?:个|天|周|月|年|次|万|千|百)/g) || []),
      timeframe: timeframe,
      /*
       * 「以吗 / 呢结尾、但判断词表一个都没命中」的兜底标记。
       *
       * 「他喜欢我吗」这种问法不含「该 / 能不能 / 会不会」任何一个词，
       * judgmentWordOf 抽不出答案词，上面 verdict 那三个条件也全不成立——
       * 于是提示词里对回答形状零要求，模型很容易回一段「感情需要双方努力」。
       * 可用户问的是一个能用「喜欢 / 不喜欢」回答的问题。
       *
       * 具体赋值放在 isOpen / isVague 算完之后（那时才知道该不该排除），
       * 这里先占位。
       */
      yesNo: false,
      // 这件事问的是谁：self / mixed / third（见上面 subject 的说明）
      subject: subject
    };

    var domainTerms = terms.filter(function (t) { return categoryOf(t) !== 'time'; });

    /*
     * 问题分类。
     *
     * 判定顺序很重要，因为它决定了「开放问题」和「具体问题」的边界：
     *
     *   1. 先看有没有明确的**开放意图**——问的是「该留意什么」这类内容，
     *      而不是对某件事的判断。命中就是开放问题，哪怕里面有是非问句的成分。
     *   2. 再看有没有**具体指向**：词表抽到了实词，或者句子本身是个指向明确的
     *      是非问句（「该不该…」「能不能…」「可以…吗」）。
     *   3. 两者都没有，才考虑是不是开放问题（有时间词或足够长）。
     *   4. 剩下的归为「短到看不出在问什么」。
     *
     * 第 2 条后半段是被一个真实问题补上的：「我现在继续和她打游戏可以增加好感吗」
     * 问的是很具体的一件事，但当时词表里没有「游戏」「好感」，一个实词都没抽到，
     * 于是被归成开放问题、页面上写「这是个开放的问题」——读错了用户的意图。
     *
     * 更广的问题还不止这一个：「我还该不该继续找她聊天」「要不要约她出来见面」
     * 同样被判成开放，而它们明明是要求判断的是非问句。
     * 所以判据不能只有词表——句子的形式本身就带着信息。
     */
    var wantsOpen = wantsOpenReading(raw);
    /*
     * 有判断词的也算「指向了具体的事」。
     *
     * 「他到底爱不爱我」「我们还合不合适」这类 A 不 A 的问法，实词表里往往
     * 一个都抽不到，asksForJudgment 也只认「吗 / 呢 / 吧」结尾，于是一路落到
     * 下面 isOpen 的第二个条件里，被判成开放问题——然后整段答案词的要求都被
     * 跳过，模型又回到「要综合看待」的老路上。
     *
     * 判断词是这里最可靠的信号：能解析出「爱 / 不爱」，就说明这句话要的是
     * 一个判断，不是「值得留意什么」。
     */
    var pointsAtSomething = domainTerms.length > 0 || asksForJudgment(raw) || Boolean(judgmentWord);

    /*
     * 以「吗」结尾就是是非问句，除非里面本来就有开放疑问词。
     *
     * 反例来源：「他们两个合适吗」「他跟那个人真的断了吗」「他们家里人同意吗」
     * ——「合适」「断了」「同意」都不在实词表里，asksForJudgment 也不认，
     * 于是一路落到下面 isOpen 的第二个条件，被判成开放问题。
     * 但「…吗」这个句末形式本身就说明它在等一个是或否。
     *
     * 只认「吗」不认「呢」：「我该怎么办呢」也是「呢」结尾，那是开放题。
     * 「怎么 / 如何 / 什么 / 为什么」这些词在场时也不按是非问处理。
     */
    var asksYesNoByForm = (/吗[？?。！!]*$/.test(raw) || /(?:是不是|是否)/.test(raw)) && !wantsOpen;

    /*
     * 是开放问题的两种情况：
     *   1. 明确在问「值得留意什么」（wantsOpen）——这种意图优先，即使句末带「吗」
     *   2. 没有指向任何具体的事，但有时间词或足够长，说明它在问一个范围
     *
     * 注意第 1 项是 wantsOpen 而不是 !wantsOpen——这里写反过一次：
     * 写成 !wantsOpen 之后，「我今天会发生些什么」反而被判成 normal，
     * 而「没有开放意图且没有具体指向」的问题才是开放问题，逻辑完全颠倒。
     */
    var isOpen = !asksYesNoByForm &&
      (wantsOpen || (!pointsAtSomething && (raw.length >= 5 || Boolean(timeframe))));

    // 真正需要提醒的只剩「短到问不出东西」这一类，比如「嗯」「怎么办」
    //
    // 但以「吗」收尾的短句不算：「他爱我吗」只有四个字、也抽不出实词，
    // 可它问得非常明确，要的就是「爱 / 不爱」。把它算进 vague 会让
    // 提示词走「问题太短，请补充」那一条，等于把是非问句当成了坏输入。
    var isVague = !isOpen && !pointsAtSomething && !wantsOpen && raw.length < 5 &&
      !/吗[？?。！!]*$/.test(raw);

    /*
     * 是非问句的兜底：以「吗 / 呢」收尾就是一个有明确答案的问题，即使
     * judgmentWordOf 一个词都没抽出来。
     *
     * 「他喜欢我吗」不属于判断词表里的任何一类，但它是非问句的事实没变。
     * 这里不指定答案词（抽不出来），只标记「这是是非问」，让提示词要求模型
     * 复用问句里的动词来回答，而不是换成「该 / 能」或者干脆给一段空话。
     *
     * 排除 open 和 vague：「最近运势怎么样」是开放问题，「然后呢」是问不出
     * 东西的短句，两者都不该被要求给一个是非答案。
     */
    if (!isOpen && !isVague && !hints.verdictWord && !hints.choice &&
        /吗[？?。！!]*$/.test(raw)) {
      hints.verdict = true;
      hints.yesNo = true;
    }

    var kind = isOpen ? 'open' : (isVague ? 'vague' : 'normal');

    return {
      raw: raw,
      isBlank: false,
      isOpen: isOpen,
      isVague: isVague,
      kind: kind,
      terms: terms,
      hints: hints
    };
  }

  /**
   * 领域词表：用户问题里值得被模型正面回应的具体词。
   *
   * 为什么不用「窗口切词」那种通用做法：中文没有分隔符，滑窗切出来的东西是
   * 「要接受这」「我和他现」这种碎片。拿碎片当判据有双重问题——它既没法读懂，
   * 也不可能被模型原样复现，于是贴合度检查会永远报「不合格」，反而失去意义。
   *
   * 换成词表匹配之后，判据是「用户说到的具体词有没有出现在解读里」。这是模型
   * 完全能做到的事（提示词里明确要求了），所以不合格就是真的没做到。
   *
   * 词表按领域分组，方便以后往里加。
   */
  var DOMAIN_TERMS = {
    // 关系
    relation: ['关系', '感情', '恋爱', '婚姻', '结婚', '离婚', '分手', '复合', '暧昧', '异地',
      '男朋友', '女朋友', '伴侣', '对象', '前任', '相亲', '表白', '追求', '冷战', '相处',
      '家人', '父母', '爸妈', '孩子', '婆婆', '婆媳', '亲戚', '朋友', '同事',
      '沟通', '信任', '边界', '承诺', '背叛', '出轨', '原谅', '安全感',
      /*
       * 互动与来往。
       *
       * 这一组是被一个真实问题补上的：「我现在继续和她打游戏可以增加好感吗」。
       * 问的是很具体的一件事（继续打游戏、增进好感），但因为词表里没有
       * 「游戏」「好感」这类日常词，一个实词都没抽到，于是被判成开放问题，
       * 页面上给出「这是个开放的问题」——完全读错了用户的意图。
       *
       * 教训：词表决定的不只是「抽出什么词」，它还决定了问题被归到哪一类。
       * 词表漏掉一整片日常词汇，就会有一整类具体问题被误判成开放式。
       */
      '游戏', '好感', '喜欢', '心动', '好感度', '聊天', '联系', '回复', '消息', '见面',
      '约会', '约', '表白过', '主动', '示好', '关心', '陪伴', '礼物', '惊喜', '追求中',
      '分手后', '和好', '误会', '吵架', '争执', '解释', '道歉', '原谅他', '原谅她',
      '在一起', '进展', '磨合', '距离', '冷淡', '热情', '付出', '回应'],
    // 工作学业
    work: ['工作', '职业', '事业', '跳槽', '辞职', '离职', '换工作', '转行', '创业', '换岗',
      'offer', '简历', '面试', '升职', '加薪', '绩效', '裁员', '失业', '副业', '兼职',
      '老板', '领导', '上司', '团队', '客户', '项目', '加班', '体制', '编制',
      '考试', '考研', '留学', '论文', '毕业', '专业', '学习', '实习', '读博'],
    // 财务与居住
    money: ['钱', '收入', '工资', '薪水', '存款', '房贷', '车贷', '债务', '负债', '积蓄',
      '投资', '理财', '股票', '基金', '买房', '租房', '搬家', '预算', '消费', '开销',
      '城市', '老家', '一线'],
    // 身心状态
    health: ['健康', '身体', '睡眠', '失眠', '焦虑', '抑郁', '情绪', '压力', '疲惫', '内耗',
      '倦怠', '生病', '看病', '体检', '康复', '运动', '减肥', '状态', '心态'],
    // 决定与处境（「在问什么」这一类）
    decision: ['选择', '决定', '机会', '风险', '代价', '取舍', '改变', '转型', '重新开始',
      '坚持', '放弃', '等待', '推进', '停滞', '瓶颈', '方向', '目标', '计划', '下一步',
      '纠结', '犹豫', '两难', '出路', '突破口', '继续', '停止', '值得', '值不值',
      '有没有用', '有用吗', '效果', '增加', '减少', '改善', '提升', '改变现状'],
    /*
     * 时间与时段。
     *
     * 这一类的存在有个具体原因：开放式的问法（「我今天会发生些什么」「这段时间
     * 该留意什么」）里往往只有时间词，是它们把问题撑了起来。早先的词表没有
     * 「今天」「明天」「这段时间」，于是这类完全正当的问法会被判成「没有具体内容」
     * 并弹出警告——那是在劝退用户问一个塔罗本来就该答的问题。
     */
    time: ['今天', '明天', '后天', '昨晚', '昨天', '这周', '本周', '下周', '这个月', '本月',
      '下个月', '这段时间', '近期', '最近', '今年', '明年', '未来', '接下来', '之后',
      '下半年', '年底', '现在', '当下', '目前', '长期', '短期', '时机', '尽快', '马上',
      '这一天', '当天', '过去']
  };

  /**
   * 抽锚点时的类别优先级。
   *
   * 两条规则：
   *   1. **时间词永不作为锚点。** 把「现在」当成锚点会让提示词里出现
   *      「核心是：现在　←　每条解读都必须出现这个词」这种废话。
   *   2. **涉及具体人或事的词优先于通用决策词。** 「继续」「改变」「值得」
   *      这类词几乎每句话里都有，拿它们当核心等于没给核心。真实例子：
   *      「我现在继续和她打游戏可以增加好感吗」，relation 里的「好感」才
   *      是用户在意的，而 decision 里的「继续」只是修饰语。
   */
  var ANCHOR_ORDER = ['relation', 'work', 'money', 'health', 'decision', 'time'];

  /** 词表拍平成一维，供匹配使用 */
  var ALL_DOMAIN_TERMS = (function () {
    var out = [];
    Object.keys(DOMAIN_TERMS).forEach(function (key) {
      DOMAIN_TERMS[key].forEach(function (term) { out.push(term); });
    });
    return out;
  })();

  /** 某个词属于哪一类 */
  function categoryOf(term) {
    var keys = Object.keys(DOMAIN_TERMS);
    for (var i = 0; i < keys.length; i++) {
      if (DOMAIN_TERMS[keys[i]].indexOf(term) >= 0) return keys[i];
    }
    return 'other';
  }

  /**
   * 抽取「值得被回应」的具体词。
   *
   * 两类来源：
   *   1. 词表里出现过的领域词
   *   2. 问题里的英文词（offer、KPI 这类常被直接写进中文句子里）
   *
   * @param {string} text
   * @returns {Array<string>} 按出现顺序去重后的词
   */
  function extractTerms(text) {
    var src = String(text || '');
    if (!src.trim()) return [];

    var found = [];
    var hitSpans = [];

    // 领域词：长的优先，避免「工作」和「换工作」同时命中时把短的那个也收进来
    ALL_DOMAIN_TERMS.slice().sort(function (a, b) { return b.length - a.length; })
      .forEach(function (term) {
        var at = src.indexOf(term);
        if (at < 0) return;

        for (var i = 0; i < hitSpans.length; i++) {
          var span = hitSpans[i];
          if (at >= span.start && at + term.length <= span.end) return;
        }
        hitSpans.push({ start: at, end: at + term.length, term: term });
      });

    hitSpans.sort(function (a, b) { return a.start - b.start; });
    hitSpans.forEach(function (span) { found.push(span.term); });

    // 英文词（含数字后缀，比如 offer、KPI、ChatGPT）
    var english = src.match(/[A-Za-z][A-Za-z0-9+#.-]{1,}/g) || [];
    english.forEach(function (word) {
      var lower = word.toLowerCase();
      if (found.indexOf(lower) < 0 && lower.length >= 2) found.push(lower);
    });

    return found;
  }

  /**
   * 从抽出的词里挑一个作为「在问什么」的锚点。
   *
   * 锚点会写进提示词（「核心是：X　←　每条 reading 都必须出现…」），所以它必须
   * 是一个**话题**。时间词不能当锚点——「核心是：今天」这种话对模型毫无用处，
   * 还会逼着每条解读去复述一个时间词。开放问题（「我今天会发生些什么」）里
   * 往往只有时间词，这时正确的答案是「没有锚点」，而不是拿时间词充数。
   *
   * @param {Array<string>} terms
   * @returns {string} 没挑到时返回空串
   */
  function pickAnchor(terms) {
    for (var i = 0; i < ANCHOR_ORDER.length; i++) {
      var want = ANCHOR_ORDER[i];
      if (want === 'time') continue;   // 时间词永不作为锚点
      for (var j = 0; j < terms.length; j++) {
        if (categoryOf(terms[j]) === want) return terms[j];
      }
    }
    return '';
  }

  /**
   * 开放问题的检查：有没有把牌读成「事件预告」。
   *
   * 开放问题（「我今天会发生些什么」）本来就没有具体词可供对照，所以常规的
   * 「词覆盖率」检查对它毫无意义——只会给出一个误导性的低分。它真正该防的是
   * 另一种失败：写成一张日程表。「今天可能会有意外的消息」「下午要留意某个人」
   * 这类句子听起来很像解读，其实无法证伪，也不是塔罗能给的东西。
   *
   * 做法是找那些典型的预告句式。它抓不到所有情况，但能抓住最常见的那几种。
   *
   * @param {Object} reading 规范化后的解读
   * @returns {{level: string, predictLike: Array<Object>, reviewed: number}}
   */
  function evaluateOpenReading(reading) {
    /*
     * 预告句式。分两类：
     *   1. 把事件说成将要发生的（会有 / 将会 / 即将 / 可能遇到 …）
     *   2. 指定了具体时段或人物的（今天下午 / 某个人 / 你的同事 …）
     * 只要同时沾上「未来时态」和「具体对象」，基本就是在写日程表。
     */
    var FUTURE = /(会|将|即将|可能|或许|也许|预计|将要)(有|发生|出现|收到|遇到|碰上|来|得|被)/;

    var predictLike = [];

    reading.cards.forEach(function (card) {
      var text = (card.reading || '') + ' ' + (card.action || '');
      var futureHit = FUTURE.test(text);
      var particularHit = /某个人|一个陌生人|你的同事|你的朋友|你的家人|你的伴侣|领导|上司|陌生人/.test(text);
      var momentHit = /(今天|明天|上午|下午|晚上)(会|将|要|可能)/.test(text);

      if (futureHit || particularHit || momentHit) {
        predictLike.push({
          index: card.index,
          position: card.position,
          card: card.cardName,
          reason: futureHit ? '用了「会/将 + 具体事件」的预告句式'
            : (momentHit ? '把时间点和事件绑在一起说' : '指向了具体的人')
        });
      }
    });

    var total = reading.cards.length || 1;
    var ratio = predictLike.length / total;
    var level = ratio === 0 ? 'good' : (ratio <= 0.34 ? 'fair' : 'poor');

    return { level: level, predictLike: predictLike, reviewed: total };
  }

  /**
   * 检查解读有没有真的扣住问题。
   *
   * 这是本地能对「答非所问」做的最直接的检验：把问题里的实词拿去每条解读里找，
   * 一条都不出现的牌位就标出来。塔罗牌给的象征本来就是通用的，模型很容易写成
   * 「这段关系需要沟通」这种换个问题也成立的话——这个检查专门抓这种。
   *
   * 坦诚地说，它只能测出「有没有提到」，测不出「说得对不对」。但它抓到的那类
   * 问题（完全没提到）恰恰是最常见的。
   *
   * @param {Object} reading 规范化后的解读
   * @param {Object} question parseQuestion() 的结果
   * @returns {{score: number, level: string, loose: Array<Object>, generic: Array<number>,
   *            termsUsed: Array<string>, termTotal: number}}
   */
  function evaluateSpecificity(reading, question) {
    // 问题留空时不做这个检查——没有可对照的东西
    if (!question || question.isBlank) {
      return { score: 100, level: 'skip', loose: [], generic: [], termsUsed: [], termTotal: 0 };
    }

    /*
     * 开放问题走另一套检查。
     *
     * 它的词表里只有时间词，「覆盖率」天然是 100% 或 0%，无论哪种都没有信息量，
     * 而「散牌位」也会全部命中（因为读法本来就不该复述那些词）。
     * 继续按常规打分只会显示一个吓人的低分，把一次正常的解读说成失败。
     */
    if (question.isOpen) {
      var open = evaluateOpenReading(reading);
      return {
        score: null,
        level: 'open',
        openLevel: open.level,
        predictLike: open.predictLike,
        loose: [],
        generic: [],
        termsUsed: question.terms,
        termTotal: question.terms.length
      };
    }

    var allTerms = question.terms.slice(0, 12);

    var termsUsed = allTerms.filter(function (term) {
      return reading.cards.some(function (card) {
        return (card.reading || '').indexOf(term) >= 0 ||
          (card.action || '').indexOf(term) >= 0;
      });
    });

    // 空话套话：出现这些说法基本可以断定这一段没有落到具体处境
    var GENERIC_PHRASES = [
      '需要沟通', '多沟通', '相信自己', '跟随内心', '顺其自然', '保持耐心',
      '放下执念', '一切都会好', '相信直觉', '接受现实', '调整心态',
      '宇宙', '能量场', '命中注定', '缘分到了', '自有安排'
    ];

    var loose = [];
    var generic = [];

    reading.cards.forEach(function (card) {
      var text = (card.reading || '') + ' ' + (card.action || '');
      var hits = allTerms.filter(function (term) { return text.indexOf(term) >= 0; });

      var genericHits = GENERIC_PHRASES.filter(function (phrase) {
        return text.indexOf(phrase) >= 0;
      });
      if (genericHits.length) generic.push(card.index);

      // 一条问题实词都没提到 → 这段几乎肯定可以套到任何问题上
      if (allTerms.length && hits.length === 0) {
        loose.push({ index: card.index, position: card.position, card: card.cardName });
      }
    });

    var total = reading.cards.length || 1;
    var looseRatio = loose.length / total;
    var coverage = allTerms.length ? termsUsed.length / allTerms.length : 1;

    /*
     * 打分：以「有多少牌位答非所问」为主，词覆盖率只作辅助。
     *
     * 为什么不能等权：词覆盖率天然偏低——问题里总有近义词和冗余词，模型不可能
     * 每一个都复述一遍，硬性要求全覆盖会把「一条散、两条具体」这种还不错的结果
     * 也打成不及格。而「有几条解读换个问题也成立」才是用户真正在抱怨的那件事，
     * 所以它占大头。
     *
     * 散牌位的惩罚取平方根而不是直接用比例：三条里散一条不该和三条全散差不多。
     *
     * 参考量级：
     *   三条全散、零覆盖   → 0   （poor）
     *   三条散一条         → 约 56（fair）
     *   三条全具体         → 约 84（good）
     */
    var score = Math.round((1 - Math.sqrt(looseRatio)) * 70 + coverage * 30);

    var level = score >= 80 ? 'good' : (score >= 50 ? 'fair' : 'poor');

    return {
      score: score,
      level: level,
      loose: loose,
      generic: generic,
      termsUsed: termsUsed,
      termTotal: allTerms.length
    };
  }

  /**
   * 从模型返回的文本里抠出 JSON 对象。
   *
   * 即使提示词说了「只输出 JSON」，模型仍可能加代码围栏、前后加一句
   * 「好的，这是解读：」，或者返回被截断的内容。这里逐层退让地尝试：
   *   1. 直接 JSON.parse
   *   2. 去掉 ```json 围栏再 parse
   *   3. 扫描出第一个括号配平的对象再 parse
   *
   * @param {string} text
   * @returns {Object} 解析结果
   * @throws {Error} 全部尝试失败时抛出，信息里带原文片段便于排查
   */
  function parseJsonLoose(text) {
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('模型返回了空内容。');
    }
    var raw = text.trim();

    try {
      return JSON.parse(raw);
    } catch (e) { /* 继续尝试 */ }

    var fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced && fenced[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch (e2) { /* 继续尝试 */ }
    }

    var extracted = extractFirstObject(raw);
    if (extracted) {
      try {
        return JSON.parse(extracted);
      } catch (e3) { /* 落到下面的报错 */ }
    }

    var err = new Error('模型没有返回可解析的 JSON。可以重试一次，或换一个指令跟随更好的模型（推荐 deepseek-chat）。');
    err.preview = raw.slice(0, 300);
    throw err;
  }

  /**
   * 判断截断发生在哪个字段里——用来告诉用户「哪一段是写到一半的」。
   *
   * 做法：从原文末尾往前找一个「"字段名": "」的形状。截断点就在字符串中间，
   * 所以它前面最近的键名就是正在写的那个字段。只看末尾一段（模型的字段值
   * 可能有几千字，但键名一定紧挨着截断处之前——中间不会有别的键）。
   *
   * @param {string} text
   * @returns {string|null} 字段名，判断不出返回 null
   */
  function cutFieldName(text) {
    if (typeof text !== 'string') return null;

    var tail = text.slice(-400);
    var best = null;
    var re = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"/g;
    var m;
    while ((m = re.exec(tail)) !== null) {
      // 取最后一个：它离截断处最近，就是正在写的那个字段
      best = m[1];
    }
    if (!best) return null;

    // 对用户说的话用中文名，认不出来的就原样给字段名
    var NAMES = {
      verdict: '结论',
      gist: '一句话摘要',
      reading: '解读正文',
      quote: '引用的牌义原文',
      position: '牌位名',
      actions: '行动清单'
    };
    return NAMES[best] || best;
  }

  /**
   * 抢救被截断的 JSON：把已经写完的部分尽量救回来。
   *
   * ── 为什么需要这个 ──
   *
   * 输出撞上长度上限时，回复会在某个值的中间被砍断。这时 JSON 不完整，
   * 普通解析必然失败，于是整次解读都作废——**哪怕 verdict 和前面几张牌
   * 已经完整写好了**。用户遇到的就是这种情况：
   *
   *   {"verdict": "倾向于「能」，但不能靠「等年底」等来。…",   ← 完整
   *    "cards": [{"index": 1, "position": "此刻的核心",
   *               "quote": "开始松绑，看清了那个「好处」其实不值。",  ← 完整
   *               "quote_note": "此字                          ← 断在这里
   *
   * 前面两段明明都能用，却因为末尾缺一个引号而全部丢弃。
   *
   * ── 做法 ──
   *
   * 不能简单地在末尾补括号——那样会留下半个字符串。所以先扫一遍，
   * 记下所有「安全截断点」（不在字符串内部，且正好在完整值之后的位置：
   * 字符串刚闭合处、逗号处），再从最后一个往前试：
   * 截到该点、补上缺失的闭合符号、尝试解析。
   * 第一个能解析成功的就是能救回来的最大部分。
   *
   * 只在确认是截断（finish_reason === 'length'）时调用——否则会掩盖
   * 真正的格式错误，那种情况该让用户看到原始报错。
   *
   * @param {string} text
   * @returns {Object|null} 抢救成功返回对象，救不回来返回 null
   */
  function salvageTruncatedJson(text) {
    if (typeof text !== 'string') return null;

    /*
     * 起点可能不止一个。
     *
     * 模型有时会在 JSON 前面写一句解说，而那句话里可能带花括号
     * （「按 {verdict, cards, actions} 的格式返回：」）。只认第一个 { 就会
     * 从错误的位置开始切，白白丢掉一次抢救机会——本该能救回来的内容
     * 变成「断得太靠前，没有可用的部分」，把用户引向「换个牌阵」这种错方向。
     */
    var starts = [];
    var at = text.indexOf('{');
    while (at >= 0 && starts.length < 8) {
      starts.push(at);
      at = text.indexOf('{', at + 1);
    }

    for (var s = 0; s < starts.length; s++) {
      var got = trySalvageBody(text.slice(starts[s]));
      if (got) return got;
    }
    return null;
  }

  /**
   * 对一段（可能被截断的）JSON 主体尝试抢救。
   *
   * @param {string} body 从某个 { 开始的内容
   * @returns {{data: Object, lastValueCut: boolean}|null}
   */
  function trySalvageBody(body) {
    /* 第一遍：找出所有安全截断点，按位置升序 */
    var points = [];
    var inString = false;
    var escaped = false;
    for (var i = 0; i < body.length; i++) {
      var ch = body[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') {
          inString = false;
          points.push(i + 1);   // 字符串刚闭合，可以在这里截
        }
      } else if (ch === '"') {
        inString = true;
      } else if (ch === ',') {
        points.push(i);         // 逗号处截断也安全（补全时会抹掉尾部逗号）
      }
    }

    /*
     * 文本末尾也是一个候选点，而且要**最先尝试**（points 从后往前试，
     * 所以它得排在最后）。
     *
     * 这一条曾经漏掉，代价不小：「字符串里的 inString 分支」以前永远走不到，
     * 于是最常见的截断形状——断在最后一张牌的 reading 中间——会把**整段
     * 已写好的 reading 丢掉**，而 closeJson 本来有能力把它补成合法 JSON。
     * 实测旧版在 33232 个候选里，那个分支生效 0 次。
     *
     * 代价是末尾那个字段会留下「写到一半」的值。所以要把 lastValueCut
     * 带出去，让上层明确告诉用户「这个字段是残的」，而不是假装它完整。
     */
    var endsMidString = inString;
    points.push(body.length);

    /*
     * 尝试次数上限。
     *
     * 候选点约等于「引号数 + 逗号数」，而每个候选都要解析一份接近全长的
     * 字符串，所以最坏是 O(候选数 × 长度)。正常规模（max_tokens 4096，
     * 几 KB）下最多几十次、几毫秒；但如果哪天模型吐回几百 KB，
     * 就会变成主线程上近一秒的同步解析。宁可放弃抢救，也不能把界面卡住。
     */
    var MAX_ATTEMPTS = 240;
    var attempts = 0;

    /* 第二遍：从后往前试，第一个能解析的就是能救回来的最大部分 */
    for (var p = points.length - 1; p >= 0; p--) {
      if (++attempts > MAX_ATTEMPTS) break;

      var cut = points[p];
      // 只有「在文本末尾、且正卡在字符串中间」才算留下了半截值
      var lastValueCut = endsMidString && cut === body.length;

      var candidate = closeJson(body.slice(0, cut));
      if (!candidate) continue;
      try {
        var data = JSON.parse(candidate);
        if (!worthSalvaging(data, lastValueCut, body)) continue;
        return { data: data, lastValueCut: lastValueCut };
      } catch (e) { /* 这个点不行，继续往前 */ }
    }
    return null;
  }

  /**
   * 救回来的东西值不值得给用户看。
   *
   * 「能解析」不等于「有用」。末尾那个候选点让抢救能捡回最后一个字段的
   * 前半段，但也带来一种很难看的结果：模型刚写到 `{"verdict": "倾向`
   * 就被砍断时，补全后语法完全合法，于是**两个字的残句被当成完整结论**
   * 展示出来——比直接说「断得太靠前」更糟，因为用户会以为模型就这水平。
   *
   * 判断标准很直接：救回来的东西得能让用户读到点什么。
   *   · 半截的结论（截断就发生在 verdict 里）→ 没有价值，后面全丢了
   *   · 空对象 → 没有价值
   *   · 结论完整、至少一张牌有解读 → 有价值
   *
   * @param {Object} data 解析出来的对象
   * @param {boolean} lastValueCut 是否留下了半截值
   * @param {string} body 原文（用来判断截断在哪个字段）
   * @returns {boolean}
   */
  function worthSalvaging(data, lastValueCut, body) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;

    /*
     * 截断发生在结论里 —— 结论是回复的第一个字段，它没写完就说明
     * 后面的牌位解读一张都没有。这种残句不该拿出来当答案。
     */
    if (lastValueCut && cutFieldName(body) === '结论') return false;

    var hasVerdict = typeof data.verdict === 'string' && data.verdict.length > 0;
    var hasAnyReading = Array.isArray(data.cards) && data.cards.some(function (c) {
      return c && typeof c === 'object' && typeof c.reading === 'string' && c.reading;
    });

    // 结论完整，或者至少有一张牌写出了解读——都比一个错误框有用
    return hasVerdict || hasAnyReading;
  }

  /**
   * 把一段不完整的 JSON 补成完整的。
   *
   * 做三件事：
   *   1. 字符串里的裸控制字符转义（模型偶尔不转义换行，那会让整段解析失败）
   *   2. 补上未闭合的字符串、数组、对象
   *   3. 抹掉截断处残留的逗号或冒号
   *
   * @param {string} text
   * @returns {string}
   */
  function closeJson(text) {
    var stack = [];
    var inString = false;
    var escaped = false;
    var out = '';

    for (var i = 0; i < text.length; i++) {
      var ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          out += ch;
        } else if (ch === '\\') {
          escaped = true;
          out += ch;
        } else if (ch === '"') {
          inString = false;
          out += ch;
        } else if (ch === '\n' || ch === '\r' || ch === '\t') {
          /*
           * 字符串里的裸控制字符是非法 JSON，而模型确实会这么写
           * （「第一行\n第二行」忘了转义）。不修它的话，整段从这个字段
           * 往后都解析不了——实测一个裸换行能让 120 张牌里只救回 3 张，
           * 而后面 117 张明明是完整合法的。
           */
          out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t';
        } else {
          out += ch;
        }
      } else if (ch === '"') {
        inString = true;
        out += ch;
      } else if (ch === '{') {
        stack.push('}');
        out += ch;
      } else if (ch === '[') {
        stack.push(']');
        out += ch;
      } else if (ch === '}' || ch === ']') {
        stack.pop();
        out += ch;
      } else {
        out += ch;
      }
    }

    if (inString) {
      /*
       * 收尾时字符串还没闭合，补一个引号。
       *
       * 但如果末尾正好是一个**裸反斜杠**（转义态悬空），直接补引号会被它
       * 转义掉，得到一个仍然没闭合的串（`{"a": "x\"}`）。这种情况下
       * 把那个反斜杠去掉再补——它本来也只是半截转义的一部分。
       */
      if (escaped) out = out.slice(0, -1);
      out += '"';
    }

    // 截断点常常落在一个 key 或逗号之后，这两种尾巴都要抹掉
    out = out.replace(/[,:]\s*$/, '');
    while (stack.length) out += stack.pop();
    return out;
  }

  /**
   * 扫描出文本里第一个括号配平且不在字符串内的 JSON 对象。
   * @param {string} text
   * @returns {string|null}
   */
  function extractFirstObject(text) {
    var start = text.indexOf('{');
    if (start < 0) return null;

    var depth = 0;
    var inString = false;
    var escaped = false;

    for (var i = start; i < text.length; i++) {
      var ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }

    return null; // 括号没配平，说明内容被截断了
  }

  /**
   * 引文核对。
   *
   * 把模型给的 quote 拿去和该牌真正的牌义原文（正位或逆位）比对。
   * 做法与 crush-meter 的引文校验一致：先做字符归一化，再找连续包含。
   * 归一化会抹掉空白、常见标点、繁简差异带来的干扰，但不会放过
   * 「把两句话拼起来」这类伪造——拼接后的字符串不会连续出现在原文里。
   *
   * @param {string} quote 模型给的引文
   * @param {string} source 牌义原文
   * @returns {boolean}
   */
  function quoteMatches(quote, source) {
    if (typeof quote !== 'string' || typeof source !== 'string') return false;
    var q = normalizeForQuote(quote);
    var s = normalizeForQuote(source);
    if (q.length < 4) return false;
    return s.indexOf(q) >= 0;
  }

  /**
   * 引文归一化：去掉空白与标点、统一全半角、繁转简的常见差异。
   * 目的是容忍格式差异，但不容忍内容差异。
   * @param {string} text
   * @returns {string}
   */
  function normalizeForQuote(text) {
    return String(text)
      .replace(/\s+/g, '')
      .replace(/[，。、；：！？「」『』“”‘’（）()《》〈〉·—…～~\-_,.;:!?"'`\[\]{}]/g, '')
      .replace(/[０-９ａ-ｚＡ-Ｚ]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
      })
      .toLowerCase();
  }

  /**
   * 校验并规范化模型的返回。
   *
   * 这里不做「失败就整个丢弃」的判断：模型漏一个字段是常见情况，
   * 把能用的部分留下、把缺的部分明确标出来，比让用户重跑一次更有用。
   *
   * @param {Object} parsed
   * @param {Object} result draw() 的结果
   * @returns {{reading: Object, issues: Array<string>, quoteStats: Object}}
   */
  function normalizeReading(parsed, result) {
    var issues = [];
    var question = parseQuestion(result.question);

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('模型返回的不是一个 JSON 对象。');
    }

    /*
     * 解读的字段结构。
     *
     * 新结构只有三个字段：verdict（直接回答）、cards（每张牌 gist + reading）、
     * actions（2-3 条行动）。
     *
     * 早先有六个：primer（复述你理解的处境）、overview（总览）、cards、
     * synthesis（把所有牌串起来）、actions、watchOut（最不确定的地方）。
     * 问题出在 primer / overview / synthesis 三者内容高度重叠——都是「整体说明」，
     * 而 watchOut 被 prompt 要求「不要写没有」，于是只能生成套话。
     * 结果是凯尔特十字一次要读 2800 字，重点被淹没。用户的原话是
     * 「看着好累好复杂，而且没什么参考价值」。
     *
     * **仍然兼容旧结构**：历史记录里存的是旧格式，模型也可能不严格遵守新 prompt。
     * 缺 verdict 时，按 overview → primer+synthesis 的顺序往回找。
     */
    var verdict = str(parsed.verdict);
    if (!verdict) {
      // 旧结构：overview 是最接近「直接回答」的那一段
      var legacy = [str(parsed.overview), str(parsed.primer), str(parsed.synthesis)]
        .filter(Boolean);
      if (legacy.length) verdict = legacy.join(' ');
    }

    var reading = {
      verdict: verdict,
      cards: [],
      actions: []
    };

    if (!reading.verdict) issues.push('缺少结论（verdict）——模型没有直接回答问题');

    /*
     * 是非题必须给一个能拿来做决定的答案。
     *
     * prompt 里已经写死了「第一句只能是能 / 不能」，但模型不一定听话——
     * 用户实际拿到过的开头是「倾向于「能」，但不能靠等年底等来」，
     * 读完仍然不知道该不该做。这里不拦截结果（解读照常显示），
     * 只明确标出来，免得用户把一段权衡当成答案。
     */
    if (reading.verdict && (question.hints.verdict || question.hints.choice)) {
      var head = reading.verdict.slice(0, 20);
      if (/倾向于|可能|大概率|大概|也许|或许|要看情况|因人而异|取决于/.test(head)) {
        var wanted = question.hints.verdictWord;
        var pair = wanted ? wanted.yes + ' / ' + wanted.no : '能 / 不能';
        issues.push('这个问题要的是一个明确判断（' + pair + '），' +
          '但结论开头是「' + head + '…」——更像一段权衡。可以重试一次。');
      }
      /*
       * 这里曾经还加过一条「开头必须出现答案词本身，否则算答错题」的检查，
       * 后来撤掉了。原因是它分不清同义词：「该不该接受」被答成「值得认真
       * 考虑」——「值得」和「该」在这个语境里几乎是同义的，判成答错题是冤枉。
       * 真要说清哪个词才对，得靠语义理解，正则做不到。
       *
       * 现在靠两头：prompt 里写死「第一句只能是「该」或「不该」」（模型照做的
       * 概率很高），以及用户看到不对可以点「重新解读一次」。骗人的检查不如没有。
       */
    }

    // 行动清单：兼容字符串与数组两种返回
    if (Array.isArray(parsed.actions)) {
      reading.actions = parsed.actions.map(str).filter(Boolean);
    } else if (typeof parsed.actions === 'string' && parsed.actions.trim()) {
      reading.actions = parsed.actions.split(/\n+/).map(str).filter(Boolean);
    }
    if (reading.actions.length === 0) issues.push('行动清单（actions）为空');
    if (reading.actions.length > 4) {
      // 凑数的行动会稀释重点，是负价值
      issues.push('行动给了 ' + reading.actions.length + ' 条，超出 2-4 条的建议范围');
    }

    // 逐牌位对齐：以本地抽到的牌为准，模型多给或漏给都不会错位
    var byIndex = {};
    if (Array.isArray(parsed.cards)) {
      parsed.cards.forEach(function (entry) {
        if (entry && typeof entry === 'object') {
          var idx = Number(entry.index);
          if (idx >= 1) byIndex[idx] = entry;
        }
      });
    } else {
      issues.push('逐牌解读（cards）不是数组');
    }

    var quoteOk = 0;
    var quoteTotal = 0;

    result.cards.forEach(function (item, i) {
      var idx = i + 1;
      var entry = byIndex[idx];

      var cardReading = entry ? str(entry.reading) : '';
      /*
       * gist：一句话摘要，折叠时只显示它。
       *
       * 新 prompt 直接要求模型给 gist。旧结构没有这个字段，那就从 reading 里
       * 取第一句当摘要——宁可摘要糙一点，也不要让折叠状态空着。
       */
      var gist = entry ? str(entry.gist) : '';
      if (!gist && cardReading) {
        var firstStop = cardReading.search(/[。！？]/);
        gist = firstStop >= 0 ? cardReading.slice(0, firstStop + 1) : cardReading;
        // 摘要太长就截断，折叠行放不下
        if (gist.length > 40) gist = gist.slice(0, 39) + '…';
      }

      var record = {
        index: idx,
        position: item.position.title,
        cardId: item.cardId,
        cardName: item.card.name,
        orientation: item.orientation,
        // 标出这是不是用户主动追加的补充牌，渲染层要据此加金色徽标
        isBonus: Boolean(item.isBonus),
        quote: entry ? str(entry.quote) : '',
        gist: gist,
        reading: cardReading,
        /*
         * 这张牌**本身**是什么意思——按当前朝向取的完整牌义。
         *
         * 模型给的 reading 是「这张牌对你这个问题说明什么」，但用户还得先知道
         * 「这张牌是什么」才能判断解读说得对不对。原来的界面上只有一句 quote
         * （从牌义里摘的 10-40 字），既不是完整牌义，也没标出关键词。
         *
         * meaning.text 已经按朝向取好了（正位取 card.up、逆位取 card.rev），
         * 所以「正位就解释正位、逆位就解释逆位」是数据层保证的，不用渲染层判断。
         */
        meaning: item.meaning || null,
        quoteOk: false,
        positionMismatch: false
      };

      if (!entry) {
        issues.push('缺少第 ' + idx + ' 个牌位（' + item.position.title + '）的解读');
      } else {
        if (!record.reading) issues.push('第 ' + idx + ' 个牌位（' + item.position.title + '）的解读为空');
        /*
         * 这里从前还检查「每张牌是否给了 action」，现在不检查了——
         * 新结构把行动合并成整体 2-3 条（见 reading.actions）。
         * 十个牌位配十条建议，多半是凑数，而凑数会稀释真正的重点。
         *
         * gist 缺失也不报错：normalizeReading 会从 reading 里截第一句补上，
         * 那是可接受的降级，不值得让用户看到一条校验问题。
         */

        // 牌位名对不上：模型可能把顺序搞乱了，明确提示
        if (entry.position && normalizeForQuote(String(entry.position)) !== normalizeForQuote(item.position.title)) {
          record.positionMismatch = true;
          issues.push('第 ' + idx + ' 个牌位名不一致：模型写的是「' + str(entry.position) +
            '」，应为「' + item.position.title + '」');
        }

        if (record.quote) {
          quoteTotal += 1;
          // 正位牌义里找一次，逆位牌义里也找一次——模型偶尔会引错朝向
          record.quoteOk = quoteMatches(record.quote, item.card.up) ||
            quoteMatches(record.quote, item.card.rev);

          /*
           * 引文对不上时，要分清两种完全不同的情况。
           *
           *   ① 摘的是「传统建议」——那句和牌义一起摆在模型面前
           *      （formatSpreadForPrompt 同时给了「牌义原文」和「传统建议」），
           *      模型摘错了段落。**它没有记错牌**，引文一字不差。
           *      用户实际遇到过：引文和「牌面本身的建议」完全相同，
           *      却被标成「模型可能记串了牌」。
           *
           *   ② 两处都找不到——那才是真的编造或记串了牌。
           *
           * 这个区分不是为了宽松，而是为了错误信息说得准：
           * 「你引用的是建议不是牌义」和「这张牌你记错了」指的不是同一件事，
           * 用户该做的反应也不一样。
           */
          if (!record.quoteOk) {
            record.quoteFromAdvice = quoteMatches(record.quote, item.card.advice);
          }
          if (record.quoteOk) quoteOk += 1;
        } else {
          issues.push('第 ' + idx + ' 个牌位（' + item.position.title + '）没有给引文');
        }
      }

      reading.cards.push(record);
    });

    return {
      reading: reading,
      issues: issues,
      quoteStats: { ok: quoteOk, total: result.cards.length, checked: quoteTotal },
      // 贴合度：解读有没有真的在回答用户问的那件事
      specificity: evaluateSpecificity(reading, question)
    };
  }

  function str(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
  }

  /* ------------------------------------------------------------------ *
   * 网络调用
   * ------------------------------------------------------------------ */

  /**
   * 规范化接口地址：允许用户填 https://api.deepseek.com 或 .../v1，
   * 统一补成 .../v1，再拼 /chat/completions。
   * @param {string} baseUrl
   * @returns {string}
   */
  function endpointOf(baseUrl) {
    var base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('还没有填写接口地址。');
    if (!/^https?:\/\//i.test(base)) {
      throw new Error('接口地址要以 http:// 或 https:// 开头。');
    }
    if (!/\/v\d+$/i.test(base)) base += '/v1';
    return base + '/chat/completions';
  }

  /**
   * 请求模型，返回解读结果。
   *
   * 会优先带上 response_format: json_object（DeepSeek / OpenAI / 通义等支持），
   * 让模型更稳地输出 JSON。如果对方接口不认这个参数而报了 400，会自动去掉它
   * 重试一次——解析层本来就能处理带围栏或带前缀的返回，所以去掉也不影响使用。
   *
   * @param {Object} options
   * @param {Object} options.result   draw() 的结果
   * @param {Object} options.config   {baseUrl, model, apiKey, temperature}
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{reading: Object, issues: Array<string>, quoteStats: Object, raw: string, usage: Object}>}
   */
  function interpret(options) {
    var result = options.result;
    var config = options.config || {};

    /*
     * 这里必须返回 rejected promise，**不能同步抛错**。
     *
     * 调用方（app.js 的 generateReading）是 `interpret({...}).then().catch()` 的
     * 写法，而且它在调用之前就把 state.busy 置成了 true、并在 .then/.catch 里才
     * 解锁。一旦这里同步抛出去，.then 和 .catch 都不会执行——busy 永远停在 true，
     * 所有按钮永久禁用，界面停在「正在解读…」，而且没有任何错误提示，
     * 改好设置再保存也不解锁（保存设置不触发按钮同步）。整页只能刷新。
     *
     * 实测最省事的触发方式：接口地址少写 http://（手填自定义服务商时很常见），
     * endpointOf 会抛「接口地址要以 http:// 或 https:// 开头」，
     * 而 isConfigured() 只判非空，拦不住它。
     *
     * 所以把整个函数体包进 try：任何同步异常都转成 rejected promise，
     * 让调用方的 .catch 拿到它、正常解锁并显示错误。
     */
    try {
      if (!config.model) throw new Error('还没有填写模型名。');
      if (!config.baseUrl) throw new Error('还没有填写接口地址。');

      return requestOnce(options, true).catch(function (error) {
        if (!error || !error.retryWithoutJsonFormat) throw error;
        return requestOnce(options, false);
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * 发一次请求。
   * @param {Object} options
   * @param {boolean} useJsonFormat 是否带 response_format
   * @returns {Promise<Object>}
   */
  function requestOnce(options, useJsonFormat) {
    var result = options.result;
    var config = options.config || {};
    var url = endpointOf(config.baseUrl);

    var body = {
      model: config.model,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserPrompt(result) }
      ],
      // 塔罗解读需要一点联想空间，但太高会让同一副牌每次说法差异过大
      temperature: typeof config.temperature === 'number' ? config.temperature : 0.8,
      stream: false,
      /*
       * 显式要足输出空间。
       *
       * 不写这个字段时，输出上限由服务端决定。长牌阵（凯尔特十字十张牌，
       * 每张牌都要 quote + gist + reading）很容易撞上默认上限，
       * 而一旦被砍断，返回的 JSON 就是不完整的——解析失败后用户看到的是
       * 「模型没有返回可解析的 JSON」，于是他去换模型，换完照样不行，
       * 因为真正的原因是长度，不是模型的格式能力。
       *
       * 4096 是绝大多数 OpenAI 兼容接口都接受的值。
       */
      max_tokens: 4096
    };
    if (useJsonFormat) body.response_format = { type: 'json_object' };

    var headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = 'Bearer ' + config.apiKey;

    return fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: options.signal
    }).then(function (response) {
      return response.text().then(function (text) {
        if (!response.ok) {
          throw describeHttpError(response.status, text, config, useJsonFormat);
        }
        var payload;
        try {
          payload = JSON.parse(text);
        } catch (e) {
          throw new Error('接口返回的不是 JSON，可能地址填错了（要指向 OpenAI 兼容的 /v1 接口）。');
        }
        if (!payload.choices || !payload.choices.length) {
          throw new Error('接口没有返回任何内容。' + (payload.error ? '错误：' + (payload.error.message || JSON.stringify(payload.error)) : ''));
        }
        var choice = payload.choices[0];
        var content = choice.message && choice.message.content;

        /*
         * finish_reason 是判断「模型说完了没有」的唯一可靠依据。
         *
         * 'length' 表示输出撞上了长度上限被砍断——这时 content 是不完整的，
         * 后面解析 JSON 必然失败。如果不看这个字段，用户拿到的错误是
         * 「模型没有返回可解析的 JSON」，那是在把长度问题说成格式问题：
         * 他会去换一个「指令跟随更好的模型」（错误提示里就是这么建议的），
         * 换完仍然失败，因为换个模型并不解决输出太长被截断这件事。
         */
        var finishReason = choice.finish_reason;

        var parsed;
        var salvaged = false;
        var lastValueCut = false;
        try {
          parsed = parseJsonLoose(content);
        } catch (parseError) {
          if (finishReason === 'length') {
            /*
             * 确认是截断，先尝试把写完的部分救回来。
             *
             * verdict 和前面几张牌往往已经完整了，为末尾一个缺失的引号
             * 把整次解读丢掉，对用户没有任何好处——他要的是能看的内容，
             * 不是一次格式正确的失败。
             */
            var got = salvageTruncatedJson(content);
            if (got) {
              parsed = got.data;
              lastValueCut = got.lastValueCut;
              salvaged = true;
            } else {
              throw new Error(
                '模型回复被截断（撞上输出长度上限，JSON 没写完），而且断得太靠前，' +
                '没有可用的部分。这不是模型格式能力的问题——换个模型也一样，' +
                '因为输出确实超长了。可以试试：换牌位更少的牌阵，' +
                '把问题写得更聚焦（牌位越多、问题越开放，需要的输出越长）。'
              );
            }
          } else if (content === null || content === undefined) {
            /*
             * 有些兼容接口在触顶或出错时返回 content: null。
             * 那不是「断得太靠前」，而是接口根本没给内容——两件事的
             * 排查方向完全不同，不能混成一句话。
             */
            throw new Error(
              '接口返回了空内容（choices[0].message.content 是空的）。' +
              '这通常是接口侧的问题：可以重试一次，或检查模型名是否可用。'
            );
          } else {
            throw parseError;
          }
        }

        var normalized = normalizeReading(parsed, result);

        /*
         * 抢救回来的解读要明确告诉用户它不完整。
         *
         * 但不能把截断的后果一条条摆出来。截断会让每个缺失的牌位各产生一条
         * 「缺少第 N 个牌位（某某）的解读」，六个牌位就是五条——加上
         * 「行动清单为空」，用户会看到「校验时发现 6 处问题」，以为出了很多错，
         * 其实只有一个原因。所以这里把由截断直接导致的那些条目合并成一条。
         */
        if (salvaged) {
          var total = normalized.reading.cards.length;
          var done = normalized.reading.cards.filter(function (c) {
            return c.reading;
          }).length;

          // 由截断直接导致的条目：缺失的牌位解读、缺引文、行动为空
          normalized.issues = normalized.issues.filter(function (text) {
            return !/缺少第 \d+ 个牌位|的解读为空|没有给引文|行动清单（actions）为空|行动给了/.test(text);
          });

          var summary;
          if (done < total) {
            summary = '这次回复被截断了：' + total + ' 个牌位里只写完 ' + done +
              ' 个，第 ' + (done + 1) + ' 到 ' + total + ' 个缺失。';
          } else if (lastValueCut) {
            // 六张都写到了，只是最后一张没写完——不能说「只写完 6 个」，那是自相矛盾
            summary = '这次回复被截断了：' + total + ' 个牌位都写到了，' +
              '但最后一张没写完。';
          } else {
            summary = '这次回复被截断了：' + total + ' 个牌位都写到了，' +
              '结尾（行动清单）缺失。';
          }

          /*
           * 最后那个字段是「写到一半」的，必须点名。
           *
           * 抢救会把断在字符串中间的值补成合法 JSON，于是那个字段看起来
           * 和完整的一模一样——用户可能把半句话当成模型的完整结论。
           * 说清是哪个字段，他才知道要打折看。
           */
          if (lastValueCut) {
            var cutName = cutFieldName(content);
            summary += cutName
              ? '最后写到的「' + cutName + '」只写到一半，不是完整的一段。'
              : '最后一段只写到一半，不是完整的。';
          }

          summary += '想要完整解读，可以换牌位更少的牌阵，或把问题写得更聚焦。';
          normalized.issues.unshift(summary);
        }

        return {
          reading: normalized.reading,
          issues: normalized.issues,
          quoteStats: normalized.quoteStats,
          specificity: normalized.specificity,
          raw: content,
          usage: payload.usage || null,
          // 记下来供界面和诊断使用
          finishReason: finishReason || null,
          truncated: finishReason === 'length',
          salvaged: salvaged
        };
      });
    });
  }

  /**
   * 把 HTTP 错误翻译成用户能照着修的话。
   *
   * 特例：有些 OpenAI 兼容接口不支持 response_format，会返回 400 并抱怨这个字段。
   * 这时给错误打上 retryWithoutJsonFormat 标记，让 interpret 去掉该参数重试一次，
   * 而不是把「你的接口不兼容」这种无从下手的错误丢给用户。
   *
   * @param {number} status
   * @param {string} text
   * @param {Object} config
   * @param {boolean} [useJsonFormat] 本次请求是否带了 response_format
   * @returns {Error}
   */
  function describeHttpError(status, text, config, useJsonFormat) {
    var detail = '';
    try {
      var payload = JSON.parse(text);
      if (payload && payload.error && payload.error.message) detail = payload.error.message;
    } catch (e) { /* 非 JSON 错误页，忽略 */ }
    if (!detail) detail = String(text || '').slice(0, 200);

    var err = new Error('');

    if (useJsonFormat && status === 400 && /response_format|json_object|json mode/i.test(detail)) {
      err.retryWithoutJsonFormat = true;
      err.message = '接口不支持 response_format 参数，正在去掉它重试…';
      return err;
    }

    var hint = '';
    if (status === 401) hint = 'API Key 不对或没填。';
    else if (status === 402) hint = '账户余额不足。';
    else if (status === 403) hint = '这个 Key 没有调用该模型的权限。';
    else if (status === 404) hint = '接口地址或模型名不对，检查 Base URL 是否带 /v1、模型名是否拼对。';
    else if (status === 429) hint = '请求太频繁或额度用尽，等一下再试。';
    else if (status >= 500) hint = '对方服务端出错，稍后重试。';

    err.message = '接口返回 ' + status + '。' + hint + (detail ? ' 详情：' + detail : '');
    return err;
  }

  /**
   * 连通性测试：发一条极短的请求，确认地址 / Key / 模型名都能用。
   * @param {Object} config
   * @returns {Promise<{ok: boolean, message: string, model?: string}>}
   */
  function testConnection(config) {
    /*
     * 整体包 try：和 interpret 同一个根因。
     *
     * endpointOf 对「地址为空」「缺 http://」是同步抛错的，而这个函数被
     * `testConnection({...}).then().catch()` 调用——同步抛出会让 catch 根本不执行，
     * 界面永久停在「正在测试…」，用户既看不到错也没有别的诊断手段。
     * 这个按钮恰恰是地址填错时最该有用的那个。
     *
     * 先检查模型名（那是调用方自己的遗漏，给同步风格之外更友好的文案），
     * 再检查地址。
     */
    try {
      if (!config.model) return Promise.reject(new Error('还没有填写模型名。'));

      var url = endpointOf(config.baseUrl);

      var headers = { 'Content-Type': 'application/json' };
      if (config.apiKey) headers['Authorization'] = 'Bearer ' + config.apiKey;

      return fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: '回复两个字：可用' }],
          max_tokens: 16,
          stream: false
        })
      }).then(function (response) {
        return response.text().then(function (text) {
          if (!response.ok) throw describeHttpError(response.status, text, config);

          /*
           * 解析要容错，而且要认出「不是补全响应」的情况。
           *
           * 原先是直接 JSON.parse(text) 然后无条件报成功：地址指向一个返回 JSON
           * 但不是 OpenAI 补全接口的服务（网关、健康检查页、自建服务）时，
           * 会显示「连通正常，模型返回：」（后面空着），用户以为配置好了，
           * 接着生成解读必然失败。200 配 HTML 时更糟——把裸 SyntaxError 丢给用户。
           */
          var payload;
          try {
            payload = JSON.parse(text);
          } catch (e) {
            throw new Error('这个地址返回的不是 JSON（多半不是模型接口）。' +
              '开头是：' + String(text).trim().slice(0, 60));
          }

          var choice = payload && payload.choices && payload.choices[0];
          if (!choice) {
            throw new Error('这个地址能连通，但返回的不是模型补全结果' +
              '（没有 choices 字段）。检查地址是否指向了 /v1/chat/completions。');
          }

          var content = choice.message ? choice.message.content : '';
          return {
            ok: true,
            message: '连通正常，模型返回：' + String(content).trim().slice(0, 40),
            model: payload.model || config.model
          };
        });
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  Tarot.LLM = {
    providers: PROVIDERS,
    buildSystemPrompt: buildSystemPrompt,
    buildUserPrompt: buildUserPrompt,
    formatSpreadForPrompt: formatSpreadForPrompt,
    parseQuestion: parseQuestion,
    extractTerms: extractTerms,
    evaluateSpecificity: evaluateSpecificity,
    evaluateOpenReading: evaluateOpenReading,
    parseJsonLoose: parseJsonLoose,
    extractFirstObject: extractFirstObject,
    quoteMatches: quoteMatches,
    normalizeForQuote: normalizeForQuote,
    normalizeReading: normalizeReading,
    endpointOf: endpointOf,
    interpret: interpret,
    testConnection: testConnection
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Tarot.LLM;
})(typeof globalThis !== 'undefined' ? globalThis : this);
