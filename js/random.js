/*
 * random.js —— 真随机引擎
 *
 * 本文件是「完全随机」这一条需求的全部实现。要点：
 *
 * 1) 随机源用 crypto.getRandomValues（操作系统 CSPRNG），不用 Math.random。
 *    Math.random 是 xorshift128+ 一类伪随机、种子可预测、且 V8 内部还要做
 *    一次浮点转换；抽塔罗牌没有理由不用系统熵。
 *
 * 2) 取样用「拒绝采样」而不是取模。
 *    random % 78 会让 0~63 出现 1/78 的概率、64~77 出现 0 概率……准确说是
 *    直接用 (random % 78) 时，2^32 除不尽 78，前 (2^32 mod 78) 个余数各多出现
 *    一次。偏差约 1e-8 量级，肉眼看不出来，但「完全随机」是个可以做到精确的
 *    目标，那就做到精确。拒绝采样让 78 个结果严格等概率。
 *
 * 3) 每次洗牌都重新取熵，不做「洗牌池复用」，不缓存牌序。
 *
 * 4) 提供审计记录（RNG.audit）：把本次抽牌用到的原始随机字与拒绝次数留档，
 *    让「这一抽是不是真随机」可以被事后核查，而不是只能相信。
 *
 * 本文件不依赖任何第三方库，同时兼容浏览器与 Node（挂到 globalThis.Tarot）。
 */
(function (root) {
  'use strict';

  var UINT32_RANGE = 4294967296; // 2^32

  var cryptoObj = null;
  if (typeof globalThis !== 'undefined' && globalThis.crypto &&
      typeof globalThis.crypto.getRandomValues === 'function') {
    cryptoObj = globalThis.crypto;
  } else if (typeof globalThis !== 'undefined' && typeof globalThis.msCrypto === 'object' &&
      globalThis.msCrypto && typeof globalThis.msCrypto.getRandomValues === 'function') {
    cryptoObj = globalThis.msCrypto;
  }

  /**
   * 环境是否具备密码学随机源。
   * @returns {boolean}
   */
  function available() {
    return cryptoObj !== null;
  }

  /**
   * 未取得随机源时的统一报错。宁可直接失败，也不静默退回 Math.random ——
   * 悄悄降级会让「真随机」这句话变成假的。
   */
  function unavailable() {
    var err = new Error(
      '当前环境没有 crypto.getRandomValues，无法提供真随机。' +
      '请用现代浏览器打开，或在 Node 18+ 下运行。'
    );
    err.code = 'NO_CRYPTO';
    return err;
  }

  /*
   * 熵池。一次 getRandomValues 取 256 个 32 位字，摊薄系统调用开销；
   * 池空即重新取熵，绝不复用旧值。
   */
  var POOL_WORDS = 256;
  var pool = new Uint32Array(POOL_WORDS);
  var poolLeft = 0;
  var poolBase = 0; // 池中第 0 个字在原始熵流里的序号，供审计记录用

  // 审计状态
  var auditBase = 0;      // 审计窗口的起点（原始熵流序号）
  var auditRaw = [];      // 本次窗口内实际用到的原始 32 位随机字
  var auditRejects = 0;   // 本次窗口内被拒绝的字数

  function refill() {
    cryptoObj.getRandomValues(pool);
    poolLeft = POOL_WORDS;
    poolBase += POOL_WORDS;
  }

  function nextRaw() {
    if (poolLeft === 0) refill();
    poolLeft -= 1;
    var index = POOL_WORDS - 1 - poolLeft; // 池按顺序消费，便于复现审计
    var word = pool[index];
    auditRaw.push(word);
    return word;
  }

  /**
   * 无偏取 [0, bound) 的整数。bound 为不小于 1 的安全整数。
   *
   * 做法：把 2^32 里能整除 bound 的最大区间截出来，落在区间外的字整字重抽。
   * 拒绝率 < bound / 2^32，对 78 张牌来说约为 1.8e-8，即几乎从不重抽。
   *
   * @param {number} bound
   * @returns {number} 0 <= n < bound
   */
  function randomBelow(bound) {
    if (!cryptoObj) throw unavailable();
    if (typeof bound !== 'number' || !isFinite(bound) || bound < 1) {
      throw new Error('randomBelow: bound 必须是不小于 1 的有限数，收到 ' + bound);
    }
    bound = Math.floor(bound);
    if (bound === 1) {
      nextRaw(); // 仍然消耗一个随机字，保持审计链的连续性
      return 0;
    }
    if (bound > UINT32_RANGE) {
      throw new Error('randomBelow: bound 不能超过 2^32');
    }
    var limit = UINT32_RANGE - (UINT32_RANGE % bound);
    for (var guard = 0; guard < 4096; guard++) {
      var word = nextRaw();
      if (word < limit) return word % bound;
      auditRejects += 1;
    }
    // 概率上不可能走到这里（连续 4096 次拒绝的几率低于 10^-40000）
    throw new Error('randomBelow: 拒绝采样异常，随机源可能已损坏');
  }

  /**
   * 无偏取闭区间 [min, max] 的整数。
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function randomInt(min, max) {
    return min + randomBelow(max - min + 1);
  }

  /**
   * 无偏洗牌（Fisher–Yates）。原地修改并返回同一个数组。
   * 每一轮 i 都从 [0, i] 里等概率取一个换到 i 位，因此 78! 种排列严格等概率。
   *
   * @param {Array} list
   * @returns {Array} 传入的那个数组
   */
  function shuffle(list) {
    if (!list || typeof list.length !== 'number') {
      throw new Error('shuffle: 需要一个数组');
    }
    for (var i = list.length - 1; i > 0; i--) {
      var j = randomBelow(i + 1);
      var tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }

  /**
   * 无偏不放回抽取 k 个（不修改原数组）。
   * @param {Array} list
   * @param {number} k
   * @returns {Array}
   */
  function sample(list, k) {
    if (k > list.length) {
      throw new Error('sample: 要抽 ' + k + ' 个，但只有 ' + list.length + ' 个可选');
    }
    return shuffle(list.slice()).slice(0, k);
  }

  /**
   * 等概率布尔值（正位/逆位用）。
   * @returns {boolean}
   */
  function randomBool() {
    return randomBelow(2) === 1;
  }

  /**
   * 从给定字符串集合里等概率取一个。
   * @param {Array<string>} list
   * @returns {string}
   */
  function pick(list) {
    return list[randomBelow(list.length)];
  }

  /**
   * 随机十六进制串（抽牌编号等用途，不用于安全场景）。
   * @param {number} bytes
   * @returns {string}
   */
  function randomHex(bytes) {
    var buffer = new Uint8Array(bytes);
    cryptoObj.getRandomValues(buffer);
    var out = '';
    for (var i = 0; i < bytes; i++) {
      out += (buffer[i] < 16 ? '0' : '') + buffer[i].toString(16);
    }
    return out;
  }

  /** 开启一次审计窗口，之前的记录清空。 */
  function startAudit() {
    auditBase = poolBase - poolLeft;
    auditRaw = [];
    auditRejects = 0;
  }

  /**
   * 结束审计窗口，返回本次抽牌用掉的原始随机字与统计。
   * @returns {{words: Array<number>, rawCount: number, rejected: number, offset: number}}
   */
  function endAudit() {
    return {
      words: auditRaw.slice(),
      rawCount: auditRaw.length,
      rejected: auditRejects,
      offset: auditBase
    };
  }

  /**
   * 把审计记录折叠成一行可读文字，附在抽牌结果里。
   * @returns {string}
   */
  function auditLine() {
    var record = endAudit();
    var head = record.words.slice(0, 4).map(function (w) {
      return w.toString(16).padStart(8, '0');
    }).join(' ');
    return '本次消耗 ' + record.rawCount + ' 个 32 位随机字，拒绝 ' + record.rejected +
      ' 个，熵流偏移 ' + record.offset + (head ? '，首字 ' + head + '…' : '');
  }

  var api = {
    available: available,
    randomBelow: randomBelow,
    randomInt: randomInt,
    shuffle: shuffle,
    sample: sample,
    randomBool: randomBool,
    pick: pick,
    randomHex: randomHex,
    startAudit: startAudit,
    endAudit: endAudit,
    auditLine: auditLine
  };

  // 浏览器：挂到全局；Node：同时兼容 module.exports，便于验证脚本直接 require
  root.Tarot = root.Tarot || {};
  root.Tarot.RNG = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
