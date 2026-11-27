/*
 * 临时脚本（用完即删）：下载 Android 打包所需的工具链。
 *
 * 为什么要有这个：这个环境里 workspace 之外不可写，所以 JDK / Android SDK /
 * Gradle 不能装到系统目录，只能全部装进 tarot/.toolchain/。
 * 相应地，构建时的 JAVA_HOME / ANDROID_HOME / GRADLE_USER_HOME 都要指到这里面。
 *
 * 用 Node 下载而不是 PowerShell：这个环境的 PowerShell 有 TLS 问题
 * （Invoke-WebRequest 全部报「基础连接已经关闭」），而 Node 的 fetch 正常。
 *
 *     node android-setup-download.js
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = __dirname;
var TC = path.join(ROOT, '.toolchain');
var DL = path.join(TC, 'downloads');

/*
 * 下载源的选择（踩过坑，记下来免得以后又换回去）
 *
 * Adoptium 的 api.adoptium.net 和 services.gradle.org 的「官方推荐地址」
 * 都会 **302 重定向到 GitHub releases**，而这个环境访问 GitHub 时
 * TLS 证书链验证失败（`unable to verify the first certificate`），
 * 于是下载报一个很含糊的 `fetch failed`。
 *
 * 换成本地/大厂镜像就正常。凡是重定向到 GitHub 的源都别用。
 */
var ITEMS = [
  {
    // Microsoft Build of OpenJDK 17 —— 直接由 aka.ms 提供，不跳 GitHub
    name: 'JDK 17 (Microsoft OpenJDK)',
    url: 'https://aka.ms/download-jdk/microsoft-jdk-17-windows-x64.zip',
    file: 'jdk17.zip',
    approx: 178,
    extractTo: 'jdk'
  },
  {
    name: 'Android commandline-tools',
    url: 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip',
    file: 'cmdline-tools.zip',
    approx: 150,
    extractTo: 'android-sdk/cmdline-tools-tmp'
  },
  {
    // Gradle 官方源同样跳 GitHub，用腾讯镜像
    name: 'Gradle 8.7 (腾讯镜像)',
    url: 'https://mirrors.cloud.tencent.com/gradle/gradle-8.7-bin.zip',
    file: 'gradle-8.7-bin.zip',
    approx: 128,
    extractTo: 'gradle'
  }
];

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1); }

async function download(item) {
  var dest = path.join(DL, item.file);

  // 已经下过就跳过（脚本可能被重跑）
  if (fs.existsSync(dest)) {
    var have = fs.statSync(dest).size;
    console.log('[跳过] ' + item.name + ' 已存在（' + mb(have) + ' MB）');
    return dest;
  }

  console.log('[开始] ' + item.name + '  →  ' + item.file + '（约 ' + item.approx + ' MB）');

  var res = await fetch(item.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(item.name + ' 下载失败：HTTP ' + res.status);

  var total = Number(res.headers.get('content-length')) || 0;
  var received = 0;
  var lastReport = 0;

  var out = fs.createWriteStream(dest);
  var reader = res.body.getReader();

  for (;;) {
    var chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.length;

    if (!out.write(Buffer.from(chunk.value))) {
      await new Promise(function (r) { out.once('drain', r); });
    }

    // 每 10MB 报一次进度，免得刷屏
    if (received - lastReport > 10 * 1024 * 1024) {
      lastReport = received;
      var pct = total ? (' (' + (received / total * 100).toFixed(0) + '%)') : '';
      console.log('         ' + mb(received) + ' MB' + pct);
    }
  }

  await new Promise(function (r) { out.end(r); });
  console.log('[完成] ' + item.name + '  ' + mb(received) + ' MB');
  return dest;
}

(async function () {
  fs.mkdirSync(DL, { recursive: true });
  console.log('工具链目录：' + TC);
  console.log('');

  var failed = [];
  for (var i = 0; i < ITEMS.length; i++) {
    try {
      await download(ITEMS[i]);
    } catch (e) {
      console.log('[失败] ' + ITEMS[i].name + '：' + e.message);
      failed.push(ITEMS[i].name);
    }
  }

  console.log('');
  if (failed.length) {
    console.log('有 ' + failed.length + ' 项失败：' + failed.join('、'));
    process.exit(1);
  }
  console.log('全部下载完成，共 ' + ITEMS.length + ' 个文件。');
})().catch(function (e) {
  console.error('脚本出错：', e && e.stack ? e.stack : e);
  process.exit(2);
});
