/*
 * 塔罗牌抽牌与 AI 解读 —— Android 壳
 *
 * 这不是原生应用：界面、逻辑、随机数全部还是 tarot/ 下那套网页，
 * 这里只提供一个 WebView 容器把它装起来。这么做是刻意的——
 * 抽牌的随机性来自浏览器的 crypto.getRandomValues，解读走用户自己填的
 * OpenAI 兼容接口，两者都不需要原生能力，包一层只是为了能装到手机上。
 *
 * ── 为什么不用 loadUrl("file:///android_asset/index.html") ──
 *
 * file:// 来源下 WebView 的 localStorage 行为不可靠（各版本、各厂商不一致），
 * 而这个应用要用 localStorage 存接口配置和抽牌历史。丢了配置用户每次打开
 * 都要重填，丢了历史则「历史记录」功能形同虚设。
 *
 * 所以这里自己拦截请求，把
 *     https://appassets.androidplatform.net/assets/…
 * 映射到 APK 里的 assets/。这是一个正常的 https 来源，
 * localStorage / crypto.getRandomValues / fetch 都能正常工作。
 *
 * （AndroidX 有个 WebViewAssetLoader 是干这个的，但引入它要多拉一堆依赖，
 *   而这里只需要映射一个前缀，自己写十几行更省事，构建也更快。）
 *
 * ── 为什么放开混合内容 ──
 *
 * 用户很可能填 http://192.168.x.x:11434/v1（局域网里的 Ollama），
 * 而页面本身是 https 来源。默认策略会把这种请求当混合内容拦掉，
 * 用户只会看到「连不上」，完全猜不到是浏览器策略的问题。
 */
package com.tarot.app;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {

    /** 虚拟主机名。用 .net 顶级域是官方示例的约定，避免和真实站点撞名。 */
    private static final String HOST = "appassets.androidplatform.net";
    private static final String PREFIX = "https://" + HOST + "/assets/";

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        /*
         * 沉浸式：系统栏透明，页面背景一直铺到屏幕边缘。
         *
         * 页面是 #0b0c14 的深色，而 Theme.Material.NoActionBar 给系统栏留的
         * 是系统默认底色——深色页面上就是底部一条白带，视觉上直接断掉。
         *
         * 只把系统栏涂成同色是不够的：那样底部仍有一条纯色带，内容在里面
         * 被截断。真正的沉浸要把这根带子去掉，让背景延伸过去。
         *
         * 代价是内容会伸进系统栏区域，所以两边都得留出安全距离——那个值
         * 由 injectSafeArea() 量出来交给 CSS（见那里的注释，为什么不用
         * env(safe-area-inset-*)）。
         *
         * 用 SYSTEM_UI_FLAG_* 而不是 Window.setDecorFitsSystemWindows(false)：
         * 后者是 API 30 起才有的全局开关，会连输入法（IME）的 inset 行为一起
         * 改掉，键盘弹出时 adjustResize 的表现变得不可预期。这几个标志虽然
         * 在新版本里标了 deprecated，但行为一直没变，而且只影响布局阶段。
         *
         * 不设 LIGHT_NAVIGATION_BAR / LIGHT_STATUS_BAR：那两个标志是
         * 「浅色背景 + 深色图标」。这里是深色背景，要浅色图标（深色主题的
         * 默认行为），加上反而会让图标在深底上看不见。
         */
        Window window = getWindow();
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // 系统会给导航栏自动加一层半透明遮罩来保证对比度，深色页面上会发灰
            window.setNavigationBarContrastEnforced(false);
            window.setStatusBarContrastEnforced(false);
        }
        window.getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();

        // 界面全靠 JS 渲染，没有 JS 就是一片空白
        settings.setJavaScriptEnabled(true);

        // localStorage：存接口配置与抽牌历史（见文件头的说明）
        settings.setDomStorageEnabled(true);

        // 允许 https 页面访问 http 接口（本地 Ollama）
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // 页面都从 assets 走，不需要文件系统权限——关掉更安全
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view,
                                                              WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (!url.startsWith(PREFIX)) return null;   // 让接口请求等照常走网络

                String assetPath = url.substring(PREFIX.length());
                int q = assetPath.indexOf('?');
                if (q >= 0) assetPath = assetPath.substring(0, q);
                int hash = assetPath.indexOf('#');
                if (hash >= 0) assetPath = assetPath.substring(0, hash);

                try {
                    InputStream in = getAssets().open(assetPath);
                    Map<String, String> headers = new HashMap<>();
                    // 这些资源是随 APK 打包的，内容不会变，允许缓存减少重读
                    headers.put("Cache-Control", "max-age=86400");
                    return new WebResourceResponse(mimeOf(assetPath), "utf-8", 200, "OK", headers, in);
                } catch (IOException e) {
                    // 找不到就返回 null，交给 WebView 报 404——比假装成功好查
                    return null;
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                injectSafeArea(view);
            }
        });

        webView.loadUrl(PREFIX + "index.html");
    }

    /**
     * 把系统栏的实测高度交给 CSS（--inset-top / --inset-bottom，单位 CSS px）。
     *
     * 全屏之后页面顶到了屏幕最边缘，内容会钻到状态栏和手势条底下，必须由
     * CSS 留出等高的空白。谁都不认识这些像素值，所以在这里量、在 CSS 里用。
     *
     * 为什么不用 env(safe-area-inset-*)：
     *   那需要页面带 viewport-fit=cover，而且老 WebView（这里 minSdk 是 24）
     *   对它支持不一致，返回 0 的时候内容就被手势条压住——而且不报错，
     *   只是静默地错位。这里量出来的值一定有。
     *
     * 为什么除以 density：
     *   WindowInsets 给的是物理像素，WebView 里的 CSS px 是逻辑像素。
     *   不换算的话 3 倍屏上会留出三倍宽的空白。
     *
     * 为什么要 post 重试：
     *   极少数情况下 onPageFinished 早于窗口把 inset 分发下来，
     *   getRootWindowInsets() 会返回 null。下一帧再量一次通常就有了，
     *   比在这里直接退化成 0 安全。
     */
    private void injectSafeArea(final WebView view) {
        WindowInsets insets = view.getRootWindowInsets();
        if (insets == null) {
            view.post(new Runnable() {
                @Override
                public void run() {
                    injectSafeArea(view);
                }
            });
            return;
        }

        int topPx;
        int bottomPx;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
            topPx = bars.top;
            bottomPx = bars.bottom;
        } else {
            topPx = insets.getSystemWindowInsetTop();
            bottomPx = insets.getSystemWindowInsetBottom();
        }

        float density = getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;

        int top = Math.round(topPx / density);
        int bottom = Math.round(bottomPx / density);

        // 写在 documentElement 上，:root 的变量从那里继承
        view.evaluateJavascript(
            "(function(){var d=document.documentElement;"
            + "d.style.setProperty('--inset-top','" + top + "px');"
            + "d.style.setProperty('--inset-bottom','" + bottom + "px');})()",
            null);
    }

    /** 按扩展名猜 MIME。WebView 对 MIME 敏感：css/js 类型不对就不会生效。 */
    private static String mimeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    /** 返回键先让页面后退（翻看历史牌面时有用），退无可退才退出应用 */
    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
