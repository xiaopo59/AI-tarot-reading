/*
 * app.js —— 主控与交互
 *
 * 负责把各层串起来：状态 → 渲染 → 用户操作 → 再渲染。
 *
 * 状态只有一份（state），所有改动都走 render() 或专门的渲染函数，
 * 不做局部的手工 DOM 修改——这样界面永远等于状态，不会出现
 * 「牌换了但下面的解读还是上一次的」这类不同步。
 */
(function (root) {
  'use strict';

  var Tarot = root.Tarot;
  var Render = Tarot.Render;
  var $ = Render.$;

  var STORAGE_SETTINGS = 'tarot.settings.v1';
  var STORAGE_HISTORY = 'tarot.history.v1';
  var HISTORY_LIMIT = 50;

  /*
   * 应用版本号，必须跟 android-build.ps1 里的 --version-name 一致。
   *
   * 为什么不从 ?v= 推导：?v= 是**资源**版本，改任何一个 js/css 都要 +1，
   * 涨得飞快，跟用户理解的「2.1」不是一回事。两个都显示——2.1 是人看的
   * 版本，资源 vNN 是排查缓存用的，各自都有用。
   */
  var APP_VERSION = '3.4';

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  var state = {
    question: '',
    spreadKey: Tarot.Spreads.defaultKey,
    deckKey: 'full',
    result: null,
    bonus: [],          // 用户主动追加的补充牌（extraCards / 自己在牌区挑的返回值）
    bonusStep: 1,       // 补充牌张数选择器当前的值
    session: null,      // 正在进行的抽牌会话（prepareFan → takeFromFan → finalizeDraw）
    fanMode: 'main',    // 待挑牌区当前在做什么：'main' 挑主牌阵，'bonus' 补挑
    payload: null,      // {reading, quoteStats, issues, usage}
    busy: false,
    initialized: false,
    settings: {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: '',
      temperature: 0.8,
      // 按钮震动。默认开：抽牌是个「按下去该有回应」的动作，手机上震一下
      // 手感差别很明显。桌面浏览器没有震动马达，这个开关在那里不起作用。
      haptic: true
    },
    history: []
  };

  var abortController = null;
  var activeCardItem = null;

  /**
   * 校准 result.drawnIds。
   *
   * 它本来只该包含「桌上真的有的牌」= 牌阵的牌 + 补充牌。但有一条路径会让它
   * 多出没显示出来的牌：直接调 Engine.extraCards 抽了牌，却没把结果放进
   * state.bonus。后果很具体——牌池里平白少掉那几张，「还剩几张可追加」算错，
   * 严重时剩余量会变成负数。
   *
   * 所以追加之前按桌上的牌重算一遍。宁可每次多算一次，也不要让用户看到
   * 一个自相矛盾的剩余张数。
   */
  function reconcileDrawnIds() {
    if (!state.result) return;

    // 桌上真实存在的牌，按「牌阵 → 补充牌」的顺序
    var onTable = state.result.cards.map(function (item) { return item.cardId; });
    state.bonus.forEach(function (item) { onTable.push(item.cardId); });

    var wanted = {};
    onTable.forEach(function (id) { wanted[id] = true; });

    // 先保留 drawnIds 里那些确实还在桌上的（维持原顺序），再补上漏掉的
    var result = [];
    var added = {};
    state.result.drawnIds.forEach(function (id) {
      if (wanted[id] && !added[id]) {
        result.push(id);
        added[id] = true;
      }
    });
    onTable.forEach(function (id) {
      if (!added[id]) {
        result.push(id);
        added[id] = true;
      }
    });

    state.result.drawnIds = result;
  }

  /* ------------------------------------------------------------------ *
   * 本地存储：localStorage 在部分环境（隐私模式、file:// 受限）会直接抛错，
   * 所以统一包一层，失败就退回内存，功能照常但关掉页面会丢。
   * ------------------------------------------------------------------ */

  var memoryStore = {};

  function storageGet(key) {
    try {
      if (root.localStorage) return root.localStorage.getItem(key);
    } catch (e) { /* 落到内存 */ }
    return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
  }

  function storageSet(key, value) {
    try {
      if (root.localStorage) {
        root.localStorage.setItem(key, value);
        return true;
      }
    } catch (e) { /* 落到内存 */ }
    memoryStore[key] = value;
    return false;
  }

  /**
   * 轻震一下。
   *
   * 三个前提缺一不可：用户在设置里没关掉、设备真的有震动马达（桌面浏览器
   * 的 navigator.vibrate 不存在）、调用没被环境拒绝（vibrate 在不允许的
   * 场景下会抛异常）。
   *
   * 只给「有份量的动作」用：洗牌、挑中一张牌、补牌收尾。调整张数的 ± 按钮
   * 那种连续点击刻意不震——震多了就变成背景噪音，用户反而感觉不到抽牌这
   * 一下。这个取舍是整件事里最重要的部分，比震动本身重要。
   */
  function haptic(ms) {
    if (!state.settings.haptic) return;
    var nav = root.navigator;
    if (!nav || typeof nav.vibrate !== 'function') return;
    try { nav.vibrate(ms || 12); } catch (e) { /* 拒绝震动就算了，不值得报错 */ }
  }

  function loadSettings() {
    var raw = storageGet(STORAGE_SETTINGS);
    if (!raw) return;
    try {
      var saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        ['provider', 'baseUrl', 'model', 'apiKey'].forEach(function (key) {
          if (typeof saved[key] === 'string') state.settings[key] = saved[key];
        });
        if (typeof saved.temperature === 'number') state.settings.temperature = saved.temperature;
        if (typeof saved.haptic === 'boolean') state.settings.haptic = saved.haptic;
      }
    } catch (e) { /* 配置损坏就忽略，用默认值 */ }
  }

  function saveSettings() {
    storageSet(STORAGE_SETTINGS, JSON.stringify(state.settings));
  }

  function loadHistory() {
    var raw = storageGet(STORAGE_HISTORY);
    if (!raw) return;
    try {
      var saved = JSON.parse(raw);
      if (Array.isArray(saved)) state.history = saved;
    } catch (e) { /* 忽略损坏的记录 */ }
  }

  function saveHistory() {
    storageSet(STORAGE_HISTORY, JSON.stringify(state.history.slice(0, HISTORY_LIMIT)));
  }

  /*
   * 历史记录现在带解读正文了，体积比以前大一个量级：一条凯尔特十字的解读
   * 序列化之后能有 6-10 KB，50 条就是半兆。localStorage 一般给 5 MB，够用，
   * 但别的站点数据、浏览器自身的配额变化都可能让某一次写入抛 QuotaExceededError。
   *
   * 与其等它抛，不如先自己收：超过预算就从最老的记录开始丢解读正文（牌和
   * 问题都保留），丢到装得下为止。用户的牌面记录比解读正文更值钱。
   */
  var HISTORY_BYTE_BUDGET = 3.5 * 1024 * 1024;

  function trimHistoryToBudget() {
    var text = JSON.stringify(state.history.slice(0, HISTORY_LIMIT));
    var guard = 0;
    while (text.length > HISTORY_BYTE_BUDGET && guard < 200) {
      guard += 1;
      // 从最老的一条开始，逐条丢它的解读正文；牌和问题不动。
      var dropped = false;
      for (var i = state.history.length - 1; i >= 0; i -= 1) {
        if (state.history[i].reading) {
          state.history[i].reading = null;
          dropped = true;
          break;
        }
      }
      if (!dropped) break; // 一条解读都不剩了还是超预算，只能交给 storageSet 报错
      text = JSON.stringify(state.history.slice(0, HISTORY_LIMIT));
    }
  }

  /**
   * 把刚生成的解读回填到对应的历史记录里。
   *
   * 用户花的是真金白银的 token，拿到的东西不该是「关掉页面就没了」。存的是
   * 渲染解读区所需的那一份数据；raw 不存——那是模型原始响应文本，只在出错时
   * 用来给用户看开头，留着白占空间。
   *
   * 找不到对应记录就静默返回：用户可能刚把它删了。
   *
   * @param {string} id 抽牌编号
   * @param {Object} payload Tarot.LLM.interpret() 的返回值
   */
  function rememberReading(id, payload) {
    if (!payload || !payload.reading) return;

    var record = null;
    for (var i = 0; i < state.history.length; i += 1) {
      if (state.history[i].id === id) { record = state.history[i]; break; }
    }
    if (!record) return;

    record.reading = {
      reading: payload.reading,
      issues: payload.issues || [],
      quoteStats: payload.quoteStats || null,
      specificity: payload.specificity || null,
      usage: payload.usage || null,
      salvaged: Boolean(payload.salvaged)
    };
    trimHistoryToBudget();
    saveHistory();
  }

  /* ------------------------------------------------------------------ *
   * 提示条
   * ------------------------------------------------------------------ */

  var toastTimer = null;

  function toast(message, ms) {
    var node = $('toast');
    node.textContent = message;
    node.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; }, ms || 2600);
  }

  /* ------------------------------------------------------------------ *
   * 弹窗与滚动
   * ------------------------------------------------------------------ */

  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }

  /**
   * 平滑滚动到某个区域。
   *
   * 加这层判断是因为 scrollIntoView 属于「可选实现」的 DOM 方法：真实浏览器
   * 都有，但某些精简的 DOM 实现没有。缺了它不该让整个操作崩掉——滚动只是
   * 体验，不是功能。
   *
   * @param {string} id
   */
  function scrollTo(id) {
    var node = $(id);
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function bindModals() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (node) {
      node.addEventListener('click', function () {
        closeModal(node.getAttribute('data-close') + 'Modal');
      });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      ['settingsModal', 'historyModal', 'cardModal'].forEach(function (id) {
        var node = $(id);
        if (node && !node.hidden) closeModal(id);
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 渲染入口
   * ------------------------------------------------------------------ */

  /**
   * 同步按钮的可用状态。
   * 抽牌按钮的禁用条件（忙碌 / 随机源不可用）在 render() 和解读流程里都要用到，
   * 抽出来避免两处各写一遍、改一处漏一处。
   */
  /**
   * 当前该显示、该送去解读的完整牌面。
   *
   * state.result 是一次纯粹的随机抽牌记录（含 deckOrder / drawnIds），
   * 补充牌是叠加在它上面的显示层。两者在这里合成一个视图，
   * 所有渲染与解读都只认这个视图，避免各处在「要不要带补充牌」上不一致。
   */
  function currentView() {
    if (!state.result) return null;
    return Render.mergeBonus(state.result, state.bonus);
  }

  /**
   * 给当前牌面算一个指纹：牌 + 朝向 + 顺序。
   *
   * 用途是判断「解读回来时，牌面还是不是发出去时的那一副」。
   * 用户在等待期间追加了牌或翻转了朝向的话，指纹会变，
   * 那次解读就该作废而不是照常显示。
   *
   * @param {Object} view
   * @returns {string}
   */
  function cardSignature(view) {
    if (!view) return '';
    return view.cards.map(function (item) {
      return item.cardId + (item.reversed ? 'R' : 'U');
    }).join('|');
  }

  function syncButtons() {
    var blocked = state.busy || !Tarot.RNG.available();

    $('btnDraw').disabled = blocked;
    $('btnDraw').classList.toggle('is-shuffling', state.busy);
    /*
     * 只有一个洗牌按钮。
     *
     * 原来这里是两个：「洗牌」和「重新洗牌」，绑的却是同一个
     * startShuffle('main')，洗过一次之后两者完全一样。用户直接说
     * 「这两个按钮功能重复了」。
     *
     * 合并的办法是保留主按钮、让文案跟着状态变——这样用户仍然能在
     * 点之前看出「我已经抽过了，这一下是重来」。
     */
    /*
     * 文案三态。挑牌途中点这一下会把已经挑走的牌全部作废（startShuffle
     * 会清掉 result/payload 并建一个新的 session），所以挑牌中不能还写
     * 「洗牌」——那看起来像「开始」，实际是「推倒重来」。
     */
    $('btnDrawText').textContent = state.busy
      ? '洗牌中'
      : (isPicking() ? '重新洗牌' : (state.result ? '重新洗一次' : '洗牌'));

    syncBonusControls(blocked);
  }

  /** 扇形是否正等着用户挑牌 */
  function isPicking() {
    return Boolean(state.session && state.session.picks.length < state.session.needed);
  }

  /**
   * 补充牌相关控件的可用状态。
   *
   * 挑牌过程中和解读进行中都要禁用：解读进行中是因为请求已经带着某一副具体的牌
   * 发出去了，再改牌面就会让回来的解读和屏幕上的牌对不上。
   *
   * @param {boolean} blocked
   */
  function syncBonusControls(blocked) {
    $('bonusCount').textContent = String(state.bonusStep);
    $('btnBonusMinus').disabled = blocked || state.bonusStep <= 1;
    $('btnBonusPlus').disabled = blocked || state.bonusStep >= 10;
    $('btnDrawBonus').disabled = blocked || !state.result || remainingCards() === 0;

    // 扇形里还有牌的话，也允许「一张一张自己挑」
    var canPick = !blocked && state.result && remainingCards() > 0;
    $('btnBonusPick').disabled = !canPick;
    $('btnBonusPick').hidden = !canPick;
  }

  /** 这副牌里还剩几张没抽出来（补充牌的可用上限） */
  function remainingCards() {
    if (!state.result || !Array.isArray(state.result.remaining)) return 0;
    return state.result.remaining.length;
  }

  function updateBonusNote() {
    var node = $('bonusNote');
    var remaining = remainingCards();

    if (!state.result) {
      node.textContent = '抽完牌之后，可以在这里从同一副牌里继续补抽几张——' +
        '牌阵没答清楚、或者你想再看一个角度时用。';
      return;
    }

    Render.clear(node);
    if (remaining === 0) {
      node.appendChild(document.createTextNode('这副牌已经抽完了，没有可以追加的牌。'));
      return;
    }

    var text = '从同一副已洗好的牌里继续抽，不放回——这副还剩 ';
    node.appendChild(document.createTextNode(text));
    node.appendChild(Render.el('strong', null, String(remaining)));
    node.appendChild(document.createTextNode(' 张可以追加。'));
  }

  /**
   * 问题质量提示。
   *
   * 三种问法给三种回应，**不评价问题本身好不好**——问什么、怎么问是用户的事：
   *
   *   开放问题（「我今天会发生些什么」）→ 说明它会怎么被读，让用户放心。
   *     这是正当的塔罗问法，早先却弹了「问题太笼统」的警告，那是个判断错误。
   *   太短（「嗯」）        → 提一句补个具体的事会更有用。
   *   具体问题            → 列出解读会围绕的点。
   */
  function renderQuestionQuality() {
    var node = $('questionQuality');
    var parsed = Tarot.LLM.parseQuestion(state.question);

    if (parsed.isBlank) {
      node.hidden = true;
      return;
    }

    node.hidden = false;
    Render.clear(node);

    // 开放问题：说明读法，不劝退
    if (parsed.isOpen) {
      node.className = 'question-quality is-open';
      node.appendChild(Render.el('strong', null, '这是个开放的问题。'));
      node.appendChild(document.createTextNode(
        ' 它会这样被读：把牌当成此刻处境的一面镜子，指出' +
        (parsed.hints.timeframe ? '「' + parsed.hints.timeframe + '」' : '这段时间') +
        '什么值得留意——而不是预告会发生什么具体的事。'));
      node.appendChild(document.createElement('br'));
      node.appendChild(document.createTextNode(
        '想换个问法的话，说清一件具体的事（比如在纠结什么）解读会更贴着你；' +
        '但你这样问也完全没问题。'));
      return;
    }

    // 短到看不出在问什么
    if (parsed.isVague) {
      node.className = 'question-quality is-thin';
      node.appendChild(Render.el('strong', null, '这个问题有点短。'));
      node.appendChild(document.createTextNode(
        ' 看不出你在问哪件事，解读容易变成「要多沟通」这类放到谁身上都成立的话。' +
        '补一句具体在纠结什么，会好很多。'));
      return;
    }

    node.className = 'question-quality is-rich';
    node.appendChild(Render.el('strong', null, '解读会围绕这些点展开：'));
    var terms = (parsed.terms.length ? parsed.terms : []).slice(0, 8);
    var box = Render.el('span', 'qq-terms');
    terms.forEach(function (term) { box.appendChild(Render.el('span', null, term)); });
    node.appendChild(box);

    if (parsed.hints.choice) {
      node.appendChild(document.createElement('br'));
      node.appendChild(document.createTextNode('你这是一个「要做选择」的问题，解读会明确说往哪边、依据是什么。'));
    }
    // 是非判断句：要的是「行不行」，不是开放式讨论
    if (parsed.hints.verdict) {
      node.appendChild(document.createElement('br'));
      node.appendChild(document.createTextNode('你问的是「这样做行不行」，解读会给出明确判断和依据，不绕回「因人而异」。'));
    }
    if (parsed.hints.stake) {
      node.appendChild(document.createElement('br'));
      node.appendChild(document.createTextNode('你提到的顾虑：' + parsed.hints.stake));
    }
  }

  function render() {
    var badge = $('rngBadge');
    if (Tarot.RNG.available()) {
      badge.textContent = '随机源：系统加密熵 ✓';
      badge.className = 'rng-badge is-ok';
    } else {
      badge.textContent = '随机源不可用 ✗';
      badge.className = 'rng-badge is-bad';
    }

    /*
     * 切换牌阵 / 牌库时，必须把「正在进行的挑牌会话」一并取消。
     *
     * 会话在 prepareFan 那一刻就把 spreadKey / deckKey / needed 都捕获下来了，
     * 之后改 state 上的这两个字段对它没有任何影响。不取消的话会出现一种
     * 自相矛盾的画面：用户挑到一半去点另一个牌阵，界面上写着「凯尔特十字 10 张」，
     * 而「这套牌阵要抽 N 张」和扇形上的进度还是旧牌阵的；继续挑下去，
     * 最终收尾出来的仍是旧牌阵的牌——用户的选择被静默忽略。
     *
     * 取消而不是保留，是因为牌阵变了之后之前挑的那几张已经没有归属了，
     * 留着一半的进度只会更混乱。提示一句，让用户知道要重新开始。
     */
    function cancelPickingForChange() {
      if (!state.session) return false;
      state.session = null;
      state.fanMode = 'main';
      toast('牌阵或牌库换了，之前挑的牌已作废，请重新洗牌。', 4000);
      return true;
    }

    Render.renderSpreadList($('spreadList'), state.spreadKey, function (key) {
      if (key === state.spreadKey) return;
      state.spreadKey = key;
      cancelPickingForChange();
      render();
    });

    Render.renderDeckOptions($('deckOptions'), state.deckKey, function (key) {
      if (key === state.deckKey) return;
      state.deckKey = key;
      cancelPickingForChange();
      render();
    });

    var spread = Tarot.Spreads.get(state.spreadKey);
    $('spreadCount').textContent = '当前：' + spread.name + ' · ' +
      spread.positions.length + ' 张';

    syncButtons();
    updateBonusNote();
    renderFanArea();
    renderQuestionQuality();

    var view = currentView();
    if (view) {
      $('panelTable').hidden = false;
      $('tableSub').textContent = view.spreadName + ' · ' + view.cards.length + ' 张' +
        (view.bonusCount ? '（含 ' + view.bonusCount + ' 张补充）' : '');
      Render.renderTable($('tableSurface'), view, {
        onCardClick: function (item) { showCardDetail(item); }
      });
      Render.renderTableFoot($('tableFoot'), view);

      $('panelReading').hidden = false;
      renderReadingArea();
    } else {
      $('panelTable').hidden = true;
      $('panelReading').hidden = true;
    }
  }

  /**
   * 扇形区域：正在挑牌时显示整副摊开的牌，否则整个面板收起来。
   */
  function renderFanArea() {
    var picking = Boolean(state.session);
    $('panelFan').hidden = !picking;
    if (!picking) return;

    var session = state.session;
    var isBonus = state.fanMode === 'bonus';

    $('fanSub').textContent = isBonus
      ? '补挑模式 · 还可以挑 ' + session.fanOrder.length + ' 张'
      : session.picks.length + ' / ' + session.needed;

    if (isBonus) {
      $('fanPrompt').textContent = '从下面自己挑一张。挑完还会继续摊着，' +
        '想再挑就接着点，不想要了就点「挑够了」。';
    } else {
      $('fanPrompt').textContent = Render.fanPrompt({
        needed: session.needed,
        picked: session.picks.length,
        remaining: session.fanOrder.length
      });
    }

    // 已经挑走的牌列出来，让用户看到自己挑了几张、都是什么
    var pickedBox = $('fanPicked');
    Render.clear(pickedBox);
    if (!isBonus && session.picks.length) {
      session.picks.forEach(function (pick, i) {
        var chip = Render.el('span', 'picked-chip');
        chip.appendChild(Render.el('span', 'pc-index', i + 1));
        chip.appendChild(document.createTextNode(
          pick.card.name + (pick.reversed ? '（逆位）' : '（正位）')));
        pickedBox.appendChild(chip);
      });
    }

    /*
     * 「挑够了，收起来」只在补挑模式出现，且必须已经挑到至少一张。
     *
     * 判据用 state.bonus.length 而不是 session.picks.length——后者是这次
     * 补挑会话里挑的数量，前者是整轮累计的补充牌数。补挑模式下两者都会增长，
     * 但用 bonus 更稳：它是真正的交付物，picks 只是过程记录。
     */
    $('btnFanDone').hidden = !isBonus;
    $('btnFanDone').disabled = isBonus && state.bonus.length === 0;

    Render.renderFan($('fanSurface'), session.fanOrder, {
      onPick: pickFromFan
    });
  }

  /** 补挑模式的收尾：把扇形收起来，牌桌保留 */
  function finishBonusPicking() {
    if (!state.session) return;
    haptic(14);
    state.session = null;
    state.fanMode = 'main';
    render();
    scrollTo('panelBonus');
    toast('补挑结束。');
  }

  function renderReadingArea() {
    var container = $('readingBody');
    var view = currentView();
    $('readingSub').textContent = state.payload
      ? '解读完成 · ' + view.cards.length + ' 个牌位'
      : '待生成';

    if (state.payload) {
      Render.renderReading(container, {
        result: view,
        reading: state.payload.reading,
        quoteStats: state.payload.quoteStats,
        specificity: state.payload.specificity,
        issues: state.payload.issues,
        usage: state.payload.usage
      }, {
        onExport: function () { exportReading(state.result, state.payload); },
        onRegenerate: function () { generateReading(true); },
        onSharpen: function () {
          $('question').focus();
          scrollTo('panelAsk');
        }
      });
      return;
    }

    Render.renderReadingPlaceholder(container, view, {
      configured: isConfigured(),
      onGenerate: function () { generateReading(false); },
      onOpenSettings: function () { openSettings(); }
    });
  }

  /* ------------------------------------------------------------------ *
   * 抽牌
   * ------------------------------------------------------------------ */

  /**
   * 洗牌，并把牌摊成扇形等用户来挑。
   *
   * 这一步不产生结果——结果要等用户挑完才成立。所以此刻会清掉上一次的牌面，
   * 避免「扇形已经换了、桌上还摆着上一轮的牌」这种自相矛盾的画面。
   */
  function startShuffle(mode) {
    if (state.busy) return;
    haptic(14);
    state.question = $('question').value;

    var session;
    try {
      if (mode === 'bonus') {
        // 补挑：牌池是上一轮洗好的牌里剩下的，不重新洗
        session = {
          spreadKey: state.result.spreadKey,
          deckKey: state.result.deckKey,
          question: state.result.question,
          deckOrder: null,
          fanOrder: state.result.remaining.slice(),
          picks: [],
          needed: 1,
          bonusTaken: 0
        };
      } else {
        // 张数由牌阵决定：牌阵有几个牌位就抽几张
        session = Tarot.Engine.prepareFan({
          spreadKey: state.spreadKey,
          question: state.question,
          deckKey: state.deckKey
        });
        // 重新洗牌 → 上一轮的牌面和补充牌全部作废
        state.result = null;
        state.bonus = [];
        state.payload = null;
      }
    } catch (error) {
      toast('洗牌失败：' + error.message, 5000);
      return;
    }

    state.session = session;
    state.fanMode = mode === 'bonus' ? 'bonus' : 'main';
    render();

    if (typeof root.requestAnimationFrame === 'function') {
      root.requestAnimationFrame(function () { scrollTo('panelFan'); });
    } else {
      scrollTo('panelFan');
    }
  }

  /**
   * 用户从扇形里点走一张。
   *
   * 主牌阵挑够张数后立即收尾成结果；补挑模式则是挑一张就贴到牌桌下方，
   * 然后继续等下一张——可以一直挑到把牌挑完。
   *
   * @param {number} fanIndex 扇形里的位置
   */
  function pickFromFan(fanIndex) {
    if (state.busy || !state.session) return;

    var pick;
    try {
      if (state.fanMode === 'bonus') {
        // 补挑的牌池不在 session.deckOrder 里（它是上一轮的剩余牌），
        // 所以这里自己取牌、自己掷正逆位，再同步维护 result.remaining
        pick = takeBonusPick(fanIndex);
      } else {
        pick = Tarot.Engine.takeFromFan(state.session, fanIndex);
      }
    } catch (error) {
      toast('挑牌失败：' + error.message, 4000);
      return;
    }

    // 只有真的挑到了才震：上面那条 return 说明这张位置没牌，震了就是骗人
    haptic(12);

    if (state.fanMode === 'bonus') {
      state.bonus = state.bonus.concat([pick]);
      reconcileDrawnIds();
      syncHistoryBonus();
      if (state.payload) {
        state.payload = null;
        toast('已补挑 1 张。牌变了，之前的解读已作废，请重新生成。', 5000);
      } else {
        toast('已补挑 1 张。');
      }

      // 还有牌就继续摊着让用户接着挑
      if (state.session.fanOrder.length === 0) {
        state.session = null;
        state.fanMode = 'main';
      }
      render();
      return;
    }

    // 主牌阵：挑够了就收尾
    if (state.session.picks.length >= state.session.needed) {
      var result;
      try {
        result = Tarot.Engine.finalizeDraw(state.session);
      } catch (error) {
        toast('收尾失败：' + error.message, 5000);
        return;
      }
      state.result = result;
      state.payload = null;
      state.session = null;
      state.fanMode = 'main';

      /*
       * 补充牌必须清掉。
       *
       * 补充牌是绑在**上一副牌**上的，新抽一副之后它们就不成立了。
       * 原来只有 startShuffle('main') 那条路清，这里没清，于是：
       * 载入一条带补充牌的历史 → 再点「洗牌」挑完新的 → 新的 result 只有 1 张，
       * 而 state.bonus 还留着历史里的那些，牌桌显示 2 张、drawnIds 只有 1 个，
       * 「还剩几张可追加」跟着算多，extraCards 甚至可能把桌上已有的那张再抽一次。
       *
       * 另外 saveHistoryRecord 会写 state.bonus，不清的话新记录里会带上
       * 属于上一副牌的补充牌。
       */
      state.bonus = [];

      saveHistoryRecord(result);
      render();
      scrollTo('panelTable');
    } else {
      render();
    }
  }

  /**
   * 补挑模式里从扇形取一张。
   *
   * 与 takeFromFan 的区别：牌池是 result.remaining（上一轮剩下的），
   * 取走后要同步把它从 remaining 里移除，否则「还剩几张」会算重复。
   *
   * @param {number} fanIndex
   * @returns {Object}
   */
  function takeBonusPick(fanIndex) {
    var session = state.session;
    var index = Math.floor(fanIndex);
    if (!isFinite(index) || index < 0 || index >= session.fanOrder.length) {
      throw new Error('牌区里没有这个位置');
    }

    var cardId = session.fanOrder[index];
    var card = Tarot.Cards.get(cardId);
    if (!card) throw new Error('这张牌不存在：' + cardId);

    // 正逆位需要一次取熵，所以外面套一个审计窗口，把这次消耗记下来
    Tarot.RNG.startAudit();
    var reversed = Tarot.RNG.randomBool();
    var audit = Tarot.RNG.auditLine();

    var pick = {
      cardId: cardId,
      card: card,
      reversed: reversed,
      orientation: reversed ? '逆位' : '正位',
      meaning: Tarot.Cards.meaning(card, reversed)
    };

    session.fanOrder = session.fanOrder.filter(function (id) { return id !== cardId; });

    /*
     * 记一笔到 picks 里。
     *
     * 这一行曾经漏掉，导致「挑够了，收起来」按钮永远点不动——它的可用条件是
     * `session.picks.length > 0`，而补挑的牌只进了 state.bonus，picks 始终是空的。
     * 也就是说那个按钮从写出来起就是坏的，只是没人点到过。
     *
     * 主流程（Engine.takeFromFan）会自己维护 picks，补挑这条路是手写的，
     * 容易漏掉这类「顺手要维护的状态」。
     */
    session.picks.push(pick);

    // 从「还没抽出来」的牌里移除，并让已抽集合跟上
    state.result.remaining = state.result.remaining.filter(function (id) { return id !== cardId; });
    state.result.drawnIds.push(cardId);
    session.bonusTaken += 1;
    state.result.audit = state.result.audit + '；补挑 1 张：' + audit;

    return pick;
  }

  /**
   * 追加补充牌。
   *
   * 关键行为：追加会让**已有的解读作废**。原因是解读是绑定在一组具体的牌上的，
   * 悄悄多出几张牌却继续显示旧解读，用户会以为那段解读已经把新牌考虑进去了——
   * 这比让他多点一次「生成解读」糟得多。
   */
  function drawBonus() {
    if (state.busy || !state.result) return;
    haptic(14);

    // 先把已抽集合校准到「桌上真实有的牌」，否则剩余张数可能算错
    reconcileDrawnIds();

    var count = state.bonusStep;
    var added;
    try {
      added = Tarot.Engine.extraCards(state.result, count);
    } catch (error) {
      toast('追加失败：' + error.message, 5000);
      return;
    }

    // 直接存 extraCards 返回的对象本身，所以之后手动翻转的朝向会一直保留
    state.bonus = state.bonus.concat(added);
    syncHistoryBonus();

    if (state.payload) {
      state.payload = null;
      toast('已追加 ' + added.length + ' 张补充牌。牌变了，之前的解读已作废，请重新生成。', 5000);
    } else {
      toast('已追加 ' + added.length + ' 张补充牌。');
    }

    render();
    scrollTo('panelTable');
  }

  function saveHistoryRecord(result) {
    state.history.unshift({
      id: result.id,
      at: result.at,
      question: result.question,
      spreadKey: result.spreadKey,
      spreadName: result.spreadName,
      deckKey: result.deckKey,
      deckLabel: result.deckLabel,
      /*
       * 解读正文先留空，等真的生成出来再回填（见 rememberReading）。
       *
       * 这里的 null 是有意义的：它区分「这条记录生成过解读但内容丢了」和
       * 「这条记录根本还没解读过」。老记录没有这个字段，读的时候也按
       * 「没有解读」处理。
       */
      reading: null,
      cards: result.cards.map(function (item) {
        return {
          cardId: item.cardId,
          cardName: item.card.name,
          reversed: item.reversed,
          orientation: item.orientation,
          positionTitle: item.position.title
        };
      })
    });
    if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
    saveHistory();
  }

  /**
   * 把补充牌同步进历史记录。
   *
   * 抽牌时就写了一条记录，追加牌是之后发生的，所以要回填。
   * drawnIds 决定「重新载入这次牌面后还能从哪继续追加」，所以每次追加都要更新。
   */
  function syncHistoryBonus() {
    if (!state.result) return;
    var record = null;
    for (var i = 0; i < state.history.length; i++) {
      if (state.history[i].id === state.result.id) { record = state.history[i]; break; }
    }
    if (!record) return;

    record.bonus = state.bonus.map(function (item) {
      return { cardId: item.cardId, reversed: item.reversed };
    });
    record.drawnIds = state.result.drawnIds.slice();
    saveHistory();
  }

  /* ------------------------------------------------------------------ *
   * AI 解读
   * ------------------------------------------------------------------ */

  function isConfigured() {
    return Boolean(state.settings.baseUrl && state.settings.model);
  }

  function generateReading(isRegenerate) {
    if (!state.result) return;
    if (state.busy) return;

    if (!isConfigured()) {
      openSettings();
      toast('先填好接口地址和模型名。');
      return;
    }

    if (isRegenerate) state.payload = null;
    state.busy = true;
    syncButtons();
    $('readingSub').textContent = '正在解读…';
    Render.renderReadingLoading($('readingBody'), currentView());
    scrollTo('panelReading');

    abortController = new AbortController();

    // 把这次解读所针对的牌面固定下来。
    // 用户可能在等待期间点「抽补充牌」——那样 state 里的牌面就变了，
    // 而请求已经带着旧牌面发出去了，回来时会和屏幕上的牌对不上。
    // 拿到结果时用它和当前牌面对比，不一致就丢弃并提示重新生成。
    var requestedView = currentView();
    var requestedSignature = cardSignature(requestedView);

    /*
     * 问题用输入框里的当前值，不用抽牌那一刻的快照。
     *
     * 用户经常这样：抽完牌、看到牌面，才想起要补一句背景，或者把问题改得
     * 更具体。以前这里用的是 result.question（抽牌时的快照），改了输入框
     * 再点「生成解读」，模型拿到的还是旧问题——从用户角度看就是「我明明
     * 改了，它装没看见」。
     *
     * 牌不动，只换问题。牌阵每个位置的含义是固定的，不依赖问句，所以换
     * 问题不会让牌面失去意义。历史记录里保留的仍是抽牌那一刻的问题，那
     * 是这次抽牌的原始上下文。
     *
     * 指纹在上一行就算好了，它只含牌与朝向，不受这里影响。
     */
    var liveQuestion = String(($('question') && $('question').value) || '').trim();
    if (liveQuestion !== requestedView.question) {
      requestedView.question = liveQuestion;
    }

    /*
     * 这里必须包 try，而且要在同一条链上接住同步异常。
     *
     * busy 已经在上面置成 true 了，而解锁只发生在 .then / .catch 里。
     * 只要 interpret 有任何一个同步抛出的路径（例如接口地址缺 http://），
     * 异常就会从 generateReading 逃出去，.catch 根本不执行——busy 永久为 true，
     * 所有按钮禁用，界面停在「正在解读…」，而且没有任何提示，
     * 改好设置再保存也不解锁（保存不触发按钮同步），整页只能刷新。
     *
     * llm.js 那边已经改成返回 rejected promise 了，这里是第二道防线：
     * 将来任何人在 interpret 里加了同步 throw，也不会再把页面锁死。
     */
    var interpretPromise;
    try {
      interpretPromise = Tarot.LLM.interpret({
        result: requestedView,
        config: state.settings,
        signal: abortController.signal
      });
    } catch (syncError) {
      state.busy = false;
      syncButtons();
      Render.renderReadingError($('readingBody'),
        (syncError && syncError.message) || String(syncError),
        function () { generateReading(false); }, openSettings);
      $('readingSub').textContent = '解读失败';
      return;
    }

    interpretPromise.then(function (payload) {
      state.busy = false;

      if (cardSignature(currentView()) !== requestedSignature) {
        state.payload = null;
        render();
        toast('你在这期间改了牌面（追加了补充牌或翻转了朝向），这次解读已作废，请重新生成。', 6000);
        return;
      }

      state.payload = payload;
      // 先存进历史再渲染：渲染不影响它，但把「保存」排在前面，
      // 万一渲染抛异常也不会让这次解读白丢。
      rememberReading(requestedView.id, payload);
      render();
      if (payload.issues.length) {
        toast('解读完成，但校验发现 ' + payload.issues.length + ' 处问题。', 4000);
      } else {
        toast('解读完成。');
      }
    }).catch(function (error) {
      state.busy = false;
      if (error && error.name === 'AbortError') {
        renderReadingArea();
        syncButtons();
        return;
      }
      var message = (error && error.message) || String(error);
      if (error && error.preview) {
        message += ' 模型返回的开头是：' + error.preview;
      }
      Render.renderReadingError($('readingBody'), message, function () {
        generateReading(false);
      }, openSettings);
      $('readingSub').textContent = '解读失败';
      syncButtons();
    });
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  function buildExportText(result, payload) {
    var lines = [];

    lines.push('塔罗牌抽取记录');
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
        item.card.name + '（' + item.card.en + '） ' + item.orientation +
        (item.isBonus ? '　[用户追加的补充牌]' : ''));
      lines.push('   此位在问：' + item.position.asks);
      /*
       * 牌义要判空。
       *
       * 正常路径下牌义一定在（引擎造牌时就算好了），但 buildExportText 是公开
       * 导出的函数，任何调用方都可能传一份不完整的 result 进来。解读那一段
       * 早就写了 `if (item.meaning && item.meaning.text)`，这里当初漏了——
       * 同一个函数里两套假设，迟早会被踩到。
       */
      if (item.meaning) {
        if (item.meaning.keywords && item.meaning.keywords.length) {
          lines.push('   关键词：' + item.meaning.keywords.join('、'));
        }
        if (item.meaning.text) lines.push('   牌义：' + item.meaning.text);
        if (item.meaning.advice) lines.push('   传统建议：' + item.meaning.advice);
      }
    });

    if (payload) {
      lines.push('');
      lines.push('-'.repeat(40));
      lines.push('AI 解读');
      lines.push('-'.repeat(40));
      /*
       * 顺序和界面完全一致：结论 → 每张牌 → 行动 → 元信息。
       *
       * 元信息（贴合度、引文核对）是事后核对用的，界面上放在最后
       * （见 render.js 的 reading-meta），导出也要一致——否则用户
       * 对照着看时会发现「文件里的顺序和屏幕上不一样」。
       */
      if (payload.reading.verdict) {
        lines.push('【结论】');
        lines.push(payload.reading.verdict);
        lines.push('');
      }
      if (payload.reading.cards.length) {
        lines.push('【每张牌说了什么】');
        // 牌义不在这里重复：上面「抽到的牌」那段已经逐张列过了
        lines.push('（各牌的关键词与牌义见上面「抽到的牌」一段）');
        payload.reading.cards.forEach(function (item) {
          lines.push(item.index + '. ' + item.position + ' · ' + item.cardName + item.orientation);
          if (item.gist) lines.push('   针对你的问题：' + item.gist);
          if (item.reading && item.reading !== item.gist) lines.push('   ' + item.reading);
          if (item.quote) {
            lines.push('   引用原文：「' + item.quote + '」' +
              (item.quoteOk ? '（已核对）' : '（未通过核对）'));
          }
          // 旧结构每张牌还带一句 action，老记录里可能还有
          if (item.action) lines.push('   可以做的事：' + item.action);
        });
        lines.push('');
      }
      if (payload.reading.actions && payload.reading.actions.length) {
        lines.push('【可以去做的事】');
        payload.reading.actions.forEach(function (text, i) {
          lines.push((i + 1) + '. ' + text);
        });
        lines.push('');
      }

      /*
       * ── 以下是与界面 reading-meta 对应的元信息段 ──
       *
       * 贴合度。
       *
       * 开放问题（level === 'open'）**没有分数**——score 是 null。
       * 原来无条件拼 score + '/100'，导出的文件里会出现
       * 「问题贴合度：null/100（解读跟问题关系不大）」，
       * 把一次正常解读在存档里判成答非所问。界面那边早就为 open 级别
       * 换了说法，导出这里一直没跟上。
       */
      if (payload.specificity && payload.specificity.level !== 'skip') {
        if (payload.specificity.level === 'open') {
          lines.push('问题贴合度：开放问题，按「是否读成事件预告」核对，不打分');
        } else {
          lines.push('问题贴合度：' + payload.specificity.score + '/100（' +
            (payload.specificity.level === 'good' ? '解读与问题对得上'
              : payload.specificity.level === 'fair' ? '有部分内容比较泛' : '解读跟问题关系不大') + '）');
        }
        if (payload.specificity.loose && payload.specificity.loose.length) {
          lines.push('  以下牌位没提到问题里的具体词，内容换个问题也成立：' +
            payload.specificity.loose.map(function (item) {
              return item.position + '（' + item.cardName + '）';
            }).join('、'));
        }
        lines.push('');
      }
      /*
       * 引文核对：和界面 reading-meta 的位置一致，排在贴合度之后。
       *
       * 这个数字比解读本身更值得先看——如果模型编造了牌义原文，
       * 它那一段的推理也不可信。但它属于「事后核对」，
       * 所以放最后，不跟结论抢注意力。
       */
      if (payload.quoteStats) {
        lines.push('引文核对：' + payload.quoteStats.ok + '/' + payload.quoteStats.total +
          ' 个牌位的引用能在牌义原文里逐字找到');
        lines.push('');
      }
      if (payload.issues.length) {
        lines.push('【校验发现的问题】');
        payload.issues.forEach(function (text) { lines.push('- ' + text); });
        lines.push('');
      }
    } else {
      lines.push('');
      lines.push('（这次抽牌没有生成 AI 解读）');
    }

    lines.push('');
    lines.push('-'.repeat(40));
    lines.push('说明：塔罗牌是随机抽出的，不预测未来。这份记录供自省参考，不能替代');
    lines.push('医疗、法律、投资等专业意见。');
    lines.push('生成时间：' + new Date().toLocaleString('zh-CN'));

    return lines.join('\n');
  }

  function downloadText(filename, text) {
    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function filenameFor(result) {
    var stamp = new Date(result.at);
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return '塔罗-' + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) +
      '-' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + '-' + result.id.slice(0, 4) + '.txt';
  }

  function exportReading(result, payload) {
    downloadText(filenameFor(result), buildExportText(currentView() || result, payload));
    toast('已导出文本文件。');
  }

  /* ------------------------------------------------------------------ *
   * 牌义弹窗
   * ------------------------------------------------------------------ */

  function showCardDetail(item) {
    activeCardItem = item;
    $('cardModalTitle').textContent = item.position.title + ' · ' + item.card.name;
    Render.renderCardDetail($('cardModalBody'), item);
    $('btnFlipCard').textContent = item.reversed ? '改为正位' : '改为逆位';
    openModal('cardModal');
  }

  /**
   * 手动翻转正逆位。
   *
   * 这是一个明确的「人工覆盖」入口，所以界面上不做任何伪装：
   * 翻转后牌义、朝向标签、以及送给模型的朝向都会一起改，并且会提示用户。
   * 它不影响随机性——随机抽出的结果已经记录在历史里了。
   */
  function flipActiveCard() {
    if (!activeCardItem) return;

    activeCardItem.reversed = !activeCardItem.reversed;
    activeCardItem.orientation = activeCardItem.reversed ? '逆位' : '正位';
    activeCardItem.meaning = Tarot.Cards.meaning(activeCardItem.card, activeCardItem.reversed);

    // 补充牌的朝向存在 state.bonus 里。这里拿到的是「合并视图」里的对象，
    // 必须回头把源数组里的那一张也改掉，否则一旦重新合并（mergeBonus 每次
    // 都会新建视图对象），翻转就丢了。
    if (activeCardItem.isBonus) {
      for (var i = 0; i < state.bonus.length; i++) {
        if (state.bonus[i].cardId === activeCardItem.cardId) {
          state.bonus[i].reversed = activeCardItem.reversed;
          state.bonus[i].orientation = activeCardItem.orientation;
          state.bonus[i].meaning = activeCardItem.meaning;
          break;
        }
      }
    }

    // 朝向变了，上一次的解读就失效了——必须清掉，否则牌面和解读会对不上
    if (state.payload) {
      state.payload = null;
      toast('朝向已改，之前的解读已作废，请重新生成。历史记录里存的仍是抽出的原始朝向。', 5000);
    } else {
      toast('已改为' + activeCardItem.orientation + '。历史记录里存的仍是抽出的原始朝向。', 4500);
    }

    closeModal('cardModal');
    render();
  }

  /* ------------------------------------------------------------------ *
   * 接口设置
   * ------------------------------------------------------------------ */

  function openSettings() {
    var select = $('providerSelect');
    Render.clear(select);
    Tarot.LLM.providers.forEach(function (provider) {
      var option = document.createElement('option');
      option.value = provider.key;
      option.textContent = provider.label;
      select.appendChild(option);
    });
    select.value = state.settings.provider;

    $('baseUrl').value = state.settings.baseUrl;
    $('model').value = state.settings.model;
    $('apiKey').value = state.settings.apiKey;
    $('temperature').value = String(state.settings.temperature);
    $('hapticToggle').checked = state.settings.haptic !== false;
    $('testResult').textContent = '';
    $('testResult').className = 'test-result';

    updateProviderNote();
    openModal('settingsModal');
  }

  function currentProvider() {
    var key = $('providerSelect').value;
    for (var i = 0; i < Tarot.LLM.providers.length; i++) {
      if (Tarot.LLM.providers[i].key === key) return Tarot.LLM.providers[i];
    }
    return Tarot.LLM.providers[Tarot.LLM.providers.length - 1];
  }

  function updateProviderNote() {
    var provider = currentProvider();
    $('providerNote').textContent = provider.note;
  }

  function applyProviderPreset() {
    var provider = currentProvider();
    if (provider.key === 'custom') return;
    $('baseUrl').value = provider.baseUrl;
    $('model').value = provider.model;
  }

  function saveSettingsFromForm() {
    state.settings.provider = $('providerSelect').value;
    state.settings.baseUrl = $('baseUrl').value.trim();
    state.settings.model = $('model').value.trim();
    state.settings.apiKey = $('apiKey').value.trim();

    var temp = parseFloat($('temperature').value);
    if (isNaN(temp)) temp = 0.8;
    state.settings.temperature = Math.max(0, Math.min(1.5, temp));

    state.settings.haptic = $('hapticToggle').checked;

    saveSettings();
    closeModal('settingsModal');
    toast('接口设置已保存。');
    if (state.result && !state.payload) renderReadingArea();
  }

  function testConnection() {
    var result = $('testResult');
    result.className = 'test-result';
    result.textContent = '正在测试…';

    Tarot.LLM.testConnection({
      baseUrl: $('baseUrl').value.trim(),
      model: $('model').value.trim(),
      apiKey: $('apiKey').value.trim()
    }).then(function (outcome) {
      result.className = 'test-result ok';
      /*
       * 测通了不等于存下了。
       *
       * testConnection 读的是表单里的值，state.settings 要等用户点「保存」
       * 才会变。以前这里只说「✓ 连通」，用户测通之后直接关弹窗，回到主界面
       * 生成解读还是失败——因为存的还是旧配置。这时表单值和已存值不同，
       * 就把这句话补上；相同就没什么好提醒的。
       */
      var dirty = state.settings.baseUrl !== $('baseUrl').value.trim() ||
        state.settings.model !== $('model').value.trim() ||
        state.settings.apiKey !== $('apiKey').value.trim();
      result.textContent = '✓ ' + outcome.message +
        (dirty ? '　（改动还没保存，点「保存」才生效）' : '');
    }).catch(function (error) {
      result.className = 'test-result bad';
      result.textContent = '✗ ' + ((error && error.message) || String(error));
    });
  }

  /* ------------------------------------------------------------------ *
   * 历史记录
   * ------------------------------------------------------------------ */

  function openHistory() {
    Render.renderHistory($('historyList'), state.history, {
      onRestore: restoreRecord,
      onExport: function (record) {
        downloadText('塔罗记录-' + record.id.slice(0, 4) + '.txt',
          buildExportText(historyExportView(record), null));
        toast('已导出（不含当时的 AI 解读）。');
      },
      onDelete: function (id) {
        state.history = state.history.filter(function (record) { return record.id !== id; });
        saveHistory();
        openHistory();
      }
    });
    openModal('historyModal');
  }

  /**
   * 把历史记录里存的牌位重新组装成一次抽牌结果。
   *
   * 牌义从本地牌库现取而不是存副本——这样牌义文案更新后，旧记录显示的
   * 也是新文案，不会留下一份过期的副本。
   *
   * deckOrder / drawnIds 是「重新载入后还能不能继续追加补充牌」的关键：
   * 记录里存了 drawnIds 的话，就从完整牌库里排除这些牌，重建一个等价的
   * 剩余牌池。重载后的牌面因此仍然可以继续追加，且不会和桌上已有的牌重复。
   *
   * @param {Object} record
   * @param {Array} [record.bonus] 当时追加的补充牌
   * @returns {Object}
   */
  function rehydrate(record) {
    var spread = Tarot.Spreads.get(record.spreadKey);
    var cards = record.cards.map(function (saved, i) {
      var card = Tarot.Cards.get(saved.cardId);
      var position = (spread && spread.positions[i]) ||
        { title: saved.positionTitle, asks: '', x: 50, y: 50 };
      return {
        index: i,
        cardId: saved.cardId,
        card: card,
        reversed: saved.reversed,
        orientation: saved.orientation,
        position: position,
        /*
         * 牌找不到时不要去算牌义。
         *
         * Cards.meaning 会直接读 card.keywords，传 null 进去就抛
         * TypeError，而那个异常会从点击事件处理器里逃出去——用户看到的
         * 是「点了按钮没反应」：弹窗不关、没有提示、桌面上的牌也没变。
         * 这种「牌库里没有这张牌」的记录确实会出现（改过牌库 id、
         * 手工编辑过 localStorage、旧版本写的），下面重建牌池时
         * 已经在清洗同类脏数据了，这里漏了一处。
         */
        meaning: card ? Tarot.Cards.meaning(card, saved.reversed) : null
      };
    });

    /*
     * 只要有牌位认不出来，这次记录就不能算完整。
     *
     * 不去猜、也不静默降级：牌面缺一张，牌阵的解读就无从谈起。
     * 让调用方拿到明确的失败，好给用户一句能看懂的话。
     */
    var missing = cards.filter(function (item) { return !item.card; });
    if (missing.length) {
      var err = new Error('这次记录里有 ' + missing.length +
        ' 张牌在当前牌库里找不到（牌库可能被改过）。');
      err.missingCardIds = missing.map(function (item) { return item.cardId; });
      throw err;
    }

    // 重建牌池：整副牌里去掉已经抽走的那几张。
    //
    // 这里不能无条件信任记录里的 drawnIds——历史存在浏览器里，可能是旧版本
    // 写的、也可能被手工改过，出现「不存在的 id」「重复 id」「张数超过牌库」
    // 都发生过。所以先清洗：只保留真实存在的牌，并去掉重复。
    var pool = Tarot.Engine.deckFor(record.deckKey);
    var validIds = {};
    pool.forEach(function (card) { validIds[card.id] = true; });

    var rawDrawn = Array.isArray(record.drawnIds) && record.drawnIds.length
      ? record.drawnIds
      : record.cards.map(function (saved) { return saved.cardId; });

    var used = {};
    var drawnIds = [];
    rawDrawn.forEach(function (id) {
      if (validIds[id] && !used[id]) {
        used[id] = true;
        drawnIds.push(id);
      }
    });

    // remaining 的语义就是「还没抽出来的牌」，所以长度天然等于剩余张数。
    // 早先版本存的是整副牌的顺序（deckOrder），还原时又当成剩余量来用，
    // 语义一混就会算出负数——现在拆成两个字段，各自只有一个含义。
    var remaining = pool
      .map(function (card) { return card.id; })
      .filter(function (id) { return !used[id]; });

    return {
      id: record.id,
      at: record.at,
      question: record.question,
      spreadKey: record.spreadKey,
      spreadName: record.spreadName,
      spreadSubtitle: spread ? spread.subtitle : '',
      deckKey: record.deckKey,
      deckLabel: record.deckLabel,
      cards: cards,
      audit: '（历史记录，未保存审计信息）',
      rng: 'crypto.getRandomValues + Fisher-Yates + 拒绝采样',
      drawnIds: drawnIds,
      remaining: remaining
    };
  }

  /**
   * 从历史记录里还原当时的补充牌。
   * @param {Object} record
   * @returns {Array}
   */
  function bonusFromRecord(record) {
    if (!record.bonus || !record.bonus.length) return [];
    return record.bonus.map(function (saved) {
      var card = Tarot.Cards.get(saved.cardId);
      return {
        cardId: card.id,
        card: card,
        reversed: saved.reversed,
        orientation: saved.reversed ? '逆位' : '正位',
        meaning: Tarot.Cards.meaning(card, saved.reversed)
      };
    });
  }

  /**
   * 历史记录的导出视图：还原牌面 + 当时的补充牌。
   * @param {Object} record
   * @returns {Object}
   */
  function historyExportView(record) {
    return Render.mergeBonus(rehydrate(record), bonusFromRecord(record));
  }

  /**
   * 从历史记录里取出可渲染的解读 payload；没有就返回 null。
   *
   * 存的是当时那次解读本身。载入时确认它跟这份记录的牌对得上——老记录没有
   * reading 字段，也有极小概率记录被外部改过。对不上宁可当作没存，也不能
   * 把两张牌的解读叠在一起显示。
   *
   * @param {Object} record
   * @returns {Object|null}
   */
  function readingFromRecord(record) {
    var saved = record && record.reading;
    if (!saved || !saved.reading) return null;
    var cards = saved.reading.cards;
    if (!Array.isArray(cards) || !record.cards || cards.length !== record.cards.length) {
      return null;
    }
    return saved;
  }

  function restoreRecord(record) {
    /*
     * 载入历史时必须把「正在进行的挑牌会话」清掉。
     *
     * 不清的话会出现一个很难察觉的错位：用户先点了「洗牌」进入挑牌态（扇形里
     * 摊着 78 张、还没挑满），然后打开历史记录点了「重新载入这次牌面」——
     * 此时 state.result 换成了历史里那副牌，但 state.session 还是上一次洗牌的，
     * 扇形面板也还开着。用户接着点扇形里的牌，那一次点击会走主牌阵流程，
     * 把刚载入的牌面**静默替换**成一次全新的抽牌，而用户以为自己是在给
     * 载入的那副牌补牌。
     *
     * fanMode 也要一起复位，否则会停在补挑模式。
     */
    state.session = null;
    state.fanMode = 'main';

    /*
     * 重建牌面可能失败（记录里的牌在牌库里找不到了）。
     *
     * 必须接住：这个函数是从历史记录弹窗的按钮点进来的，异常逃出事件
     * 处理器的话，用户看到的是「点了没反应」——弹窗不关、没有提示、
     * 桌面也没变，只能怀疑程序坏了。给一句话，比什么都不说强。
     */
    var rebuilt;
    try {
      rebuilt = rehydrate(record);
    } catch (error) {
      toast('这次记录载入失败：' + error.message, 6000);
      return;
    }

    state.result = rebuilt;
    state.bonus = bonusFromRecord(record);
    /*
     * 解读正文现在存在记录里了，载入时一并恢复。
     *
     * 以前这里无条件置 null：历史只留牌和问题，解读是「一次性的」。
     * 但用户花 token 换来的东西，关掉页面就没了，实在说不过去。
     * 老记录没有 reading 字段，readingFromRecord 会返回 null，
     * 行为和以前一样——需要重新生成。
     */
    state.payload = readingFromRecord(record);
    state.question = record.question;
    $('question').value = record.question;
    closeModal('historyModal');
    /*
     * 按桌上的牌重算 drawnIds。
     *
     * 载入的牌面 + 它的补充牌才是「桌上真实有的牌」，而 drawnIds 决定
     * 「还剩几张可以追加」。不同步的话剩余数会算错，extraCards 甚至可能
     * 把桌上已经有的那张再抽一次。
     */
    reconcileDrawnIds();
    render();
    toast('已载入这次牌面，可以重新生成解读。');
    scrollTo('panelTable');
  }

  /* ------------------------------------------------------------------ *
   * 绑定
   * ------------------------------------------------------------------ */

  function on(node, type, handler) {
    if (node) node.addEventListener(type, handler);
  }

  function bind() {
    bindModals();

    on($('btnDraw'), 'click', function () { startShuffle('main'); });
    on($('btnFanDone'), 'click', finishBonusPicking);

    on($('question'), 'input', function () {
      state.question = $('question').value;
      renderQuestionQuality();
    });

    on($('btnSettings'), 'click', openSettings);
    on($('btnSaveSettings'), 'click', saveSettingsFromForm);
    on($('btnTest'), 'click', testConnection);
    on($('providerSelect'), 'change', function () {
      applyProviderPreset();
      updateProviderNote();
    });

    on($('btnHistory'), 'click', openHistory);
    on($('btnClearHistory'), 'click', function () {
      if (!state.history.length) { toast('本来就是空的。'); return; }
      if (!root.confirm('确定清空全部 ' + state.history.length + ' 条记录？这个操作不能撤销。')) return;
      state.history = [];
      saveHistory();
      openHistory();
      toast('历史记录已清空。');
    });

    on($('btnFlipCard'), 'click', flipActiveCard);

    // 补充牌张数选择器
    on($('btnBonusMinus'), 'click', function () {
      state.bonusStep = Math.max(1, state.bonusStep - 1);
      syncButtons();
    });
    on($('btnBonusPlus'), 'click', function () {
      state.bonusStep = Math.min(10, state.bonusStep + 1);
      syncButtons();
    });
    on($('btnDrawBonus'), 'click', drawBonus);
    on($('btnBonusPick'), 'click', function () { startShuffle('bonus'); });

    Render.renderExamples($('exampleList'), function (text) {
      $('question').value = text;
      state.question = text;
      $('question').focus();
    });
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  /**
   * 页脚那行版本标记。
   *
   * 存在的唯一目的是**让「浏览器跑的是哪一版」一眼可见**。加它是因为
   * 反复出现同一种浪费：代码改好了、测试全绿，用户那边却还在跑缓存里的
   * 旧 JS——于是一个早就修掉的 bug 看起来还在，双方都得从头查一遍。
   *
   * 这里把版本号写在确定性最强的位置：
   *   · 读 index.html 里带 ?v= 的资源地址，那就是页面自己的版本号；
   *   · 读不到就退回脚本自身的构建标记。
   * 值本身不重要，重要的是它必须**随文件变化**。
   */
  function showBuildStamp() {
    var node = document.getElementById('buildStamp');
    if (!node) return;

    var version = null;
    /*
     * 从资源 URL 上取 ?v=NN。
     *
     * **必须锚定到 js/ 下的脚本**，不能图省事写 `script[src*="?v="], link[href*="?v="]`。
     * 那样取的是「文档序第一个带 ?v= 的节点」，而 <link styles.css> 在 <head>、
     * 脚本在 <body> 末尾——于是页脚显示的是**样式表的版本号**。
     * 一旦有人只改了样式表的 ?v=（index.html 里那段「把下面所有版本号 +1」
     * 是要求人工同步的），页脚就会显示新版本、实际跑的却是旧 JS，
     * 恰恰毁掉了这行标记存在的意义。
     *
     * 包在 try/catch 里也有原因：测试用的精简 DOM 替身没有选择器引擎，
     * 调 querySelector 会直接抛错（那是刻意设计的，免得测试里写出假通过的
     * 选择器断言）。版本标记属于锦上添花，绝不该因此让整个应用初始化失败。
     */
    try {
      var tagged = typeof document.querySelector === 'function'
        ? document.querySelector('script[src*="js/"][src*="?v="]')
        : null;
      // 退一步：任何带 js/ 的脚本（哪怕没有版本参数）
      if (!tagged && typeof document.querySelector === 'function') {
        tagged = document.querySelector('script[src*="js/"]');
      }
      if (tagged) {
        var url = tagged.getAttribute('src') || '';
        var m = url.match(/[?&]v=(\d+)/);
        if (m) version = m[1];
      }
    } catch (e) {
      version = null;
    }

    node.textContent = version
      ? ('版本 ' + APP_VERSION + '　·　资源 v' + version)
      : ('版本 ' + APP_VERSION + '　·　资源地址上没有版本号，无法确认是否最新');
  }

  function init() {
    // 只允许初始化一次。init 会给按钮挂监听器，重复调用会让一次点击触发两轮抽牌，
    // 牌面和历史记录都会多出一份。浏览器里正常只会走到一次，但把它做成幂等的
    // 代价很低，能避免将来（比如热重载或手动调用）踩这个坑。
    if (state.initialized) return;
    state.initialized = true;

    showBuildStamp();

    /*
     * 先按当前视口算一遍尺寸，再挂尺寸变化监听。
     *
     * 必须在渲染之前做：render.js 把卡片尺寸写进 CSS 变量，而牌桌上的牌位
     * 是按这些尺寸算坐标的。顺序反了会先按旧尺寸画一帧，手机上就是一眼可见的错位。
     */
    Tarot.Render.applyMetrics();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      var resizeTimer = null;
      window.addEventListener('resize', function () {
        // 手机旋转屏幕会连发多次 resize，防抖一下免得重复重排
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
          resizeTimer = null;
          var before = Tarot.Render.metrics().cardW;
          Tarot.Render.applyMetrics();
          if (Tarot.Render.metrics().cardW !== before) render();
        }, 150);
      });
    }

    loadSettings();
    loadHistory();

    // 牌库和牌阵是手写数据，启动时先自检一遍。有错就直接显示出来，
    // 而不是让用户在页面上看到一张缺名字的牌再回来猜哪里错了。
    var cardCheck = Tarot.Cards.validate();
    var spreadCheck = Tarot.Spreads.validate();
    if (!cardCheck.ok || !spreadCheck.ok) {
      var problems = cardCheck.errors.concat(spreadCheck.errors);
      var body = $('readingBody');
      if (body) {
        Render.clear(body);
        var box = Render.el('div', 'reading-error');
        box.appendChild(Render.el('strong', null, '牌库数据自检未通过（' + problems.length + ' 项）：'));
        var ul = document.createElement('ul');
        problems.slice(0, 12).forEach(function (text) {
          ul.appendChild(Render.el('li', null, text));
        });
        box.appendChild(ul);
        body.appendChild(box);
        $('panelReading').hidden = false;
      }
    }

    bind();
    render();
  }

  // 自动初始化。
  //
  // 这里的判断刻意保持宽松：只要 document 有 getElementById，并且页面上真的
  // 存在 btnDraw，就算处在可初始化的环境里。
  // 早先的版本额外要求 document.addEventListener 存在，那是个错误的条件——
  // 真实浏览器里它当然存在（所以这个条件从不救场），但任何缺少它的环境
  // （比如某些无头 DOM 实现）会被静默跳过初始化，页面一片空白却没有任何报错。
  // 宁可在缺 DOM 时明确失败，也不要静默不渲染。
  if (typeof document !== 'undefined' && typeof document.getElementById === 'function' &&
      document.getElementById('btnDraw')) {
    if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', init);

      // 兜底：正常情况下 DOMContentLoaded 一定会来，但万一页面是被动态注入的
      // （脚本执行时 DOM 已经就绪，事件却早已派发过），不补这一下就会永远停在
      // 空白页。init 是幂等的，重复调用没有副作用。
      setTimeout(function () {
        if (!state.initialized) init();
      }, 0);
    } else {
      init();
    }
  }

  Tarot.App = {
    state: state,
    buildExportText: buildExportText,
    rehydrate: rehydrate,
    filenameFor: filenameFor,
    init: init,
    // 供无头测试驱动界面用：直接调用内部动作，避免测试去点击某个
    // 与断言无关的控件来「顺便」触发重绘。
    render: render,
    renderReadingArea: renderReadingArea,
    startShuffle: startShuffle,
    pickFromFan: pickFromFan,
    finishBonusPicking: finishBonusPicking,
    drawBonus: drawBonus,
    generateReading: generateReading,
    // 载入历史也导出：它有一条「记录里的牌在牌库里找不到」的失败路径，
    // 值得单独驱动一次（走点击也能触发，但那样断言会混进一堆无关的界面状态）
    restoreRecord: restoreRecord
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
