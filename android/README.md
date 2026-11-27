# Android 打包

这个目录把 `tarot/` 那套网页装进一个 WebView 壳里，产出可以装到手机上的 APK。

**它不是原生应用**：界面、逻辑、随机数全部还是那份网页。包一层只是因为
「装到手机上、有个图标、能离线打开」比「每次开浏览器输网址」方便。
抽牌的随机性仍然来自浏览器的 `crypto.getRandomValues`，解读仍然走你自己填的接口。

---

## 产物

```
tarot/tarot.apk        281 KB
```

装到手机上有两种方式。

**一、手机浏览器下载**（最省事，电脑上的服务已经在跑）

手机连同一个 Wi-Fi，浏览器打开：

```
http://<电脑IP>:8000/tarot.apk
```

下载后点开安装，系统会问「是否允许安装未知来源应用」，允许即可。

> **这个地址里的 IP 会变。** 它是路由器用 DHCP 分配的，电脑重启或续约之后
> 可能就换了（实际遇到过：文档里写的是 `.7`，机器已经变成 `.12`，
> 于是手机一直连不上，还以为是防火墙问题）。
>
> 可靠的查法是**看服务启动时打印的那一行**：
>
> ```
> cd tarot
> python serve.py
>
> 服务已启动，目录：...
>
>   本机：  http://127.0.0.1:8000/
>   手机：  http://<电脑IP>:8000/        ← 用这个
> ```
>
> 或者手动查：`ipconfig`，看「IPv4 地址」那一行。
>
> （`serve.py` 是多线程的。`python -m http.server` 是单线程的，
> 一边下 APK 一边开网页时后一个请求会被前一个堵住，直到超时。）

**二、用 adb**（手机开了 USB 调试时）

```powershell
$adb = "tarot\.toolchain\android-sdk\platform-tools\adb.exe"
& $adb install -r tarot\tarot.apk
```

---

## 重新构建

改完网页之后要重新打包，跑一次：

```powershell
cd tarot
powershell -NoProfile -ExecutionPolicy Bypass -File android-build.ps1
```

它会自动把 `index.html` / `styles.css` / `js/*.js` 拷进 assets 再打包，
所以**不需要手工同步**——改完源码直接跑就行。

---

## 目录里都是什么

```
android/
├── app/src/main/
│   ├── AndroidManifest.xml              应用清单（权限、图标、Activity）
│   ├── java/com/tarot/app/MainActivity.java   WebView 壳，只有一百多行
│   ├── res/mipmap-*/ic_launcher.png     五个密度的图标
│   └── assets/                          ← 构建时自动拷贝，不要手工改
└── build/                               ← 中间产物，可以随时删
```

构建脚本（都在 `tarot/` 下）：

| 文件 | 用途 |
|---|---|
| `android-setup-download.js` | 下载 JDK / Gradle / cmdline-tools |
| `android-setup-sdkdl.js` | 下载 Android SDK 三个组件 |
| `android-setup-unpack.ps1` | 把上面下载的 zip 解压到位 |
| `make-android-icons.py` | 从 `tarot-icon.png` 生成五个密度的图标 |
| `android-build.ps1` | 真正的构建：aapt2 → javac → d8 → zipalign → apksigner |

工具链装在 `tarot/.toolchain/`（约 1.4 GB），**可以随时删掉**，
需要时重跑上面三个 setup 脚本即可。

---

## 几个刻意的选择

**为什么不用 Gradle。** Android Gradle Plugin 及其依赖要再拉几百 MB，
而这台机器上官方源都会 302 跳到 GitHub，GitHub 的 TLS 证书链在这里验证不过
（`unable to verify the first certificate`）。SDK 自带的 build-tools
足够打出一个正经 APK，步骤写在 `android-build.ps1` 的注释里。

**为什么不用 `file://` 加载页面。** `file://` 来源下 WebView 的 localStorage
行为不可靠（各版本、各厂商不一致），而这个应用要用它存接口配置和抽牌历史。
所以 `MainActivity` 自己拦截请求，把 `https://appassets.androidplatform.net/assets/…`
映射到 APK 内的 assets——这是一个正常的 https 来源，localStorage / crypto / fetch 都正常。

**为什么开了明文流量。** 你可能填 `http://192.168.x.x:11434/v1`（局域网里的 Ollama），
而页面本身是 https 来源。Android 9 起默认禁止明文流量，WebView 默认也拦混合内容，
两个开关都得打开，否则用户只会看到「连不上」，完全猜不到是系统策略。

**为什么图标下面的名字是「塔罗牌」而不是全名。** 手机桌面上的图标标签
超过 5~6 个字就会被省略号截掉，写全名会变成「塔罗牌抽牌与…」。完整名字在应用内的顶栏上。

---

## 已知限制

- **只做了 Android。** iOS 需要 macOS + Xcode，在 Windows 上无法完成。
- **这个 APK 是 debug 签名**（自签的 keystore，密码都是 `android`）。
  自己装、发给朋友装都没问题，但**不能上架应用商店**——那需要正式的签名证书。
- **没有在真机上跑过。** 构建环境里没有设备也没有模拟器，
  所以验证只到「APK 结构正确、签名有效、资源齐全、清单合法」这一层。
  运行时行为（WebView 加载、localStorage、调用接口）需要你装上之后实测。
- **聊天式 AI 的流式输出**没有做，解读仍然是一次性返回（和网页版一致）。

---

## 如果装上去是白屏

先按这个顺序查（都是我构建时踩过的坑）：

1. **assets 里的路径** —— 用 Windows 版 aapt2 打包时，`assets/js/app.js`
   会变成条目名 `assets/js\app.js`（反斜杠）。WebView 请求的是正斜杠，找不到就白屏。
   构建脚本里有一步专门修正并在最后校验，所以正常不会有这个问题；
   但如果有人改了打包流程，先用这个查：
   ```powershell
   Add-Type -AssemblyName System.IO.Compression.FileSystem
   $z = [System.IO.Compression.ZipFile]::OpenRead("tarot\tarot.apk")
   $z.Entries | Where-Object { $_.FullName -like '*\*' } | ForEach-Object { $_.FullName }
   $z.Dispose()
   ```
   有输出就说明又出这个问题了。

2. **看日志** —— 手机连电脑后：
   ```powershell
   & $adb logcat | Select-String -Pattern 'tarot|chromium|Console'
   ```
