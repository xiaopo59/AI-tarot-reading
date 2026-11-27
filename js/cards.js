/*
 * cards.js —— 牌库汇总层
 *
 * 把大阿卡纳与小阿卡纳合成一副完整的 78 张牌，并建立索引。
 * 顺带做一次结构自检：牌库是手写数据，最容易出的错是漏字段、重 id、
 * 数量不对——这些错在页面上只会表现为「某张牌显示不出来」，很难查。
 * 所以这里在启动时就把它们查出来并直接报错。
 */
(function (root) {
  'use strict';

  var Tarot = root.Tarot = root.Tarot || {};

  var MAJOR = Tarot.MajorArcana || [];
  var MINOR = Tarot.MinorArcana || [];

  var SUITS = [
    { key: 'major', label: '大阿卡纳', short: '大', element: '灵', color: '#c9a227' },
    { key: 'wands', label: '权杖', short: '杖', element: '火', color: '#d2691e' },
    { key: 'cups', label: '圣杯', short: '杯', element: '水', color: '#3a7ca5' },
    { key: 'swords', label: '宝剑', short: '剑', element: '风', color: '#7d8ca3' },
    { key: 'pentacles', label: '星币', short: '币', element: '土', color: '#2e8b57' }
  ];

  function suitOf(id) {
    if (id.indexOf('major-') === 0) return 'major';
    if (id.indexOf('wands-') === 0) return 'wands';
    if (id.indexOf('cups-') === 0) return 'cups';
    if (id.indexOf('swords-') === 0) return 'swords';
    if (id.indexOf('pentacles-') === 0) return 'pentacles';
    return 'unknown';
  }

  /** 完整牌库：大阿卡纳在前，然后按权杖→圣杯→宝剑→星币排列。 */
  var DECK = MAJOR.concat(MINOR).map(function (card) {
    var suit = suitOf(card.id);
    var meta = null;
    for (var i = 0; i < SUITS.length; i++) {
      if (SUITS[i].key === suit) meta = SUITS[i];
    }
    return {
      id: card.id,
      name: card.name,
      en: card.en,
      num: card.num,
      roman: card.roman || String(card.num),
      glyph: card.glyph || meta.short,
      suit: suit,
      suitLabel: meta.label,
      suitShort: meta.short,
      element: meta.element,
      color: meta.color,
      keywords: card.keywords,
      core: card.core,
      up: card.up,
      rev: card.rev,
      advice: card.advice
    };
  });

  var BY_ID = {};
  DECK.forEach(function (card) { BY_ID[card.id] = card; });

  /**
   * 按 id 取牌。
   * @param {string} id
   * @returns {Object|undefined}
   */
  function get(id) {
    return BY_ID[id];
  }

  /**
   * 结构性自检。牌库是手写数据，这里把能机械查出来的错都查一遍。
   * @returns {{ok: boolean, errors: Array<string>, stats: Object}}
   */
  function validate() {
    var errors = [];

    if (MAJOR.length !== 22) {
      errors.push('大阿卡纳应为 22 张，实际 ' + MAJOR.length + ' 张');
    }
    if (MINOR.length !== 56) {
      errors.push('小阿卡纳应为 56 张，实际 ' + MINOR.length + ' 张');
    }
    if (DECK.length !== 78) {
      errors.push('整副牌应为 78 张，实际 ' + DECK.length + ' 张');
    }

    var seenId = {};
    var seenName = {};
    var suitCount = { major: 0, wands: 0, cups: 0, swords: 0, pentacles: 0 };

    DECK.forEach(function (card, index) {
      var where = '第 ' + (index + 1) + ' 张(' + (card.id || '无 id') + ')';

      if (!card.id) errors.push(where + ' 缺少 id');
      if (seenId[card.id]) errors.push(where + ' 的 id 与前面的牌重复');
      seenId[card.id] = true;

      if (!card.name) errors.push(where + ' 缺少 name');
      if (seenName[card.name]) errors.push(where + ' 的名称「' + card.name + '」与前面的牌重复');
      seenName[card.name] = true;

      if (card.suit === 'unknown') errors.push(where + ' 的 id 前缀无法识别归属');

      ['en', 'num', 'keywords', 'core', 'up', 'rev', 'advice'].forEach(function (field) {
        var value = card[field];
        if (value === undefined || value === null || value === '') {
          errors.push(where + ' 缺少字段 ' + field);
        }
      });

      // 只有正文长度值得设下限：en 是英文名（The Fool 本来就只有 8 个字符），
      // num 是编号，keywords 是数组。core 是刻意的短句（最短的「退一步，才看得见。」
      // 只有 9 个字），对它设下限只会产生误报，所以不查。
      ['up', 'rev', 'advice'].forEach(function (field) {
        var value = card[field];
        if (typeof value === 'string' && value.length < 10) {
          errors.push(where + ' 的字段 ' + field + ' 过短，可能是漏写：' + value);
        }
      });

      if (!Array.isArray(card.keywords) || card.keywords.length < 3) {
        errors.push(where + ' 的 keywords 至少要有 3 个');
      }

      // 正逆位不能写成同一段话——那说明逆位是复制粘贴来的
      if (card.up && card.up === card.rev) {
        errors.push(where + ' 的正位与逆位牌义完全相同');
      }

      if (suitCount[card.suit] !== undefined) suitCount[card.suit] += 1;
    });

    // 大阿卡纳编号必须刚好覆盖 0..21
    var majorNums = MAJOR.map(function (card) { return card.num; }).sort(function (a, b) { return a - b; });
    for (var n = 0; n < 22; n++) {
      if (majorNums[n] !== n) {
        errors.push('大阿卡纳编号不连续：第 ' + n + ' 位应为 ' + n + '，实际 ' + majorNums[n]);
        break;
      }
    }

    // 每组小阿卡纳必须是 10 张数字牌 + 4 张宫廷牌
    ['wands', 'cups', 'swords', 'pentacles'].forEach(function (suit) {
      var group = DECK.filter(function (card) { return card.suit === suit; });
      if (group.length !== 14) {
        errors.push(SUITS.filter(function (s) { return s.key === suit; })[0].label + ' 应为 14 张，实际 ' + group.length + ' 张');
      }
      var courts = group.filter(function (card) {
        return ['侍从', '骑士', '王后', '国王'].indexOf(card.num) >= 0;
      });
      if (courts.length !== 4) {
        errors.push(SUITS.filter(function (s) { return s.key === suit; })[0].label + ' 的宫廷牌应为 4 张，实际 ' + courts.length + ' 张');
      }
    });

    return {
      ok: errors.length === 0,
      errors: errors,
      stats: { total: DECK.length, major: MAJOR.length, minor: MINOR.length, bySuit: suitCount }
    };
  }

  Tarot.Cards = {
    deck: DECK,
    suits: SUITS,
    get: get,
    validate: validate,
    /** 正位 / 逆位标签 */
    orientationLabel: function (reversed) { return reversed ? '逆位' : '正位'; },
    /**
     * 取某张牌在指定朝向下的牌义。
     * @param {Object} card
     * @param {boolean} reversed
     * @returns {{keywords: Array<string>, core: string, text: string, advice: string}}
     */
    meaning: function (card, reversed) {
      return {
        keywords: card.keywords,
        core: card.core,
        text: reversed ? card.rev : card.up,
        advice: card.advice
      };
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Tarot.Cards;
})(typeof globalThis !== 'undefined' ? globalThis : this);
