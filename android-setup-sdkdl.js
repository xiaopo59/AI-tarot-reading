/*
 * 临时脚本（用完即删）：直接下载 Android SDK 组件。
 *
 * 为什么不用 sdkmanager：
 *   它能启动、能接受许可，但拉不到远程包清单（`Failed to find package`，
 *   伴随 `Still waiting for package manifests to be fetched remotely`）。
 *   这台机器上 Java 的网络栈拿不到 dl.google.com，而 Node 的 fetch 可以
 *   （PowerShell 也不行，有 TLS 问题）。所以绕开 sdkmanager，直接下三个 zip。
 *
 * 下载完由 PowerShell 那边解压并摆到 SDK 要求的目录结构里。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var DL = path.join(__dirname, '.toolchain', 'downloads');

var ITEMS = [
  {
    name: 'platform-tools',
    url: 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
    file: 'platform-tools.zip',
    note: 'adb 等，构建不需要，但将来往手机装 APK 要用'
  },
  {
    name: 'platforms;android-34',
    url: 'https://dl.google.com/android/repository/platform-34-ext7_r03.zip',
    file: 'platform-34.zip',
    note: '编译用的 android.jar'
  },
  {
    name: 'build-tools;34.0.0',
    url: 'https://dl.google.com/android/repository/build-tools_r34-windows.zip',
    file: 'build-tools-34.zip',
    note: 'aapt2 / d8 / apksigner / zipalign，真正干活的工具'
  }
];

function mb(b) { return (b / 1048576).toFixed(1); }

async function download(item) {
  var dest = path.join(DL, item.file);

  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) {
    console.log('[跳过] ' + item.name + ' 已存在（' + mb(fs.statSync(dest).size) + ' MB）');
    return;
  }

  console.log('[下载] ' + item.name + '  —— ' + item.note);

  var res = await fetch(item.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(item.name + ' HTTP ' + res.status);

  var total = Number(res.headers.get('content-length')) || 0;
  var got = 0;
  var out = fs.createWriteStream(dest);
  var reader = res.body.getReader();

  for (;;) {
    var chunk = await reader.read();
    if (chunk.done) break;
    got += chunk.value.length;
    if (!out.write(Buffer.from(chunk.value))) {
      await new Promise(function (r) { out.once('drain', r); });
    }
  }
  await new Promise(function (r) { out.end(r); });

  console.log('       完成 ' + mb(got) + ' MB' + (total ? ' / ' + mb(total) + ' MB' : ''));
}

(async function () {
  fs.mkdirSync(DL, { recursive: true });
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
    console.log('失败 ' + failed.length + ' 项：' + failed.join('、'));
    process.exit(1);
  }
  console.log('三个组件都下好了，交给 PowerShell 解压。');
})().catch(function (e) {
  console.error(e && e.stack ? e.stack : e);
  process.exit(2);
});
