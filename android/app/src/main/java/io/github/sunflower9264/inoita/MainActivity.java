package io.github.sunflower9264.inoita;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Collections;
import java.util.UUID;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 离线 WebView 壳。
 *
 * 游戏构建产物（dist）作为 Android assets 打进 APK，再由 WebViewAssetLoader 映射到
 * https://appassets.androidplatform.net/。热更新只把差异文件落到 filesDir，页面来源
 * 和 localStorage 都不变；启动时先解析版本清单，再创建 WebView 加载对应版本。
 */
public class MainActivity extends Activity implements UpdateManager.Listener {

    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String GAME_URL = "https://" + ASSET_HOST + "/index.html";
    private static final long DOUBLE_BACK_MS = 2000;
    /** 新版本切过去后等待标题页启动信号的窗口；慢设备上 45 秒偏紧，放到 90 秒。 */
    private static final long BOOT_TIMEOUT_MS = 90000;

    private FrameLayout root;
    private WebView webView;
    private WebViewAssetLoader assetLoader;
    private UpdateManager updateManager;
    private long lastBackPressed;
    /** 诊断上报走单线程后台队列，避免占用 WebView 的 JS 线程。 */
    private final ExecutorService diagnosticsExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private AlertDialog updateDialog;
    private AlertDialog checkFailedDialog;
    private ProgressDialog downloadDialog;
    private AlertDialog bootingDialog;
    private final Runnable bootWatchdog = this::onBootWatchdog;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attrs = getWindow().getAttributes();
            attrs.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attrs);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.background));
        setContentView(root);

        updateManager = UpdateManager.get(getApplicationContext());
        updateManager.setListener(this);

        assetLoader = new WebViewAssetLoader.Builder()
                // 离线包里没有接收端；相对路径的诊断请求直接吞掉。APK 的上报地址由
                // document-start 脚本写入全局变量，指向项目服务器。
                .addPathHandler("/__diagnostics/", path -> new WebResourceResponse(
                        "application/json", "utf-8", 204, "No Content",
                        Collections.emptyMap(), new ByteArrayInputStream(new byte[0])))
                // 清单是权威：新版本删掉的文件不能从 APK 旧副本复活。
                .addPathHandler("/", new UpdatePathHandler(updateManager,
                        new WebViewAssetLoader.AssetsPathHandler(getApplicationContext())))
                .build();

        // 先读清单、发布路径快照，再创建 WebView；否则第一波请求可能还没有权威清单。
        updateManager.initialize(this::onUpdateManagerReady);
        hideSystemBars();
    }

    private void onUpdateManagerReady() {
        if (isFinishing() || isDestroyed()) return;
        createWebView();
        hideSystemBars();
        // Activity 被重建时可能还处在等待新版本启动的窗口里，补回提示和看门狗。
        if (updateManager.isBooting()) {
            showBootingDialog();
            startBootWatchdog();
        }
        // 先把上次没处理完的更新重新呈现；没有待处理更新才发起新的检查。
        if (!updateManager.repostPendingState()) updateManager.checkForUpdate();
    }

    private void createWebView() {
        if (isFinishing() || isDestroyed()) return;

        webView = new WebView(this);
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        webView.setBackgroundColor(getColor(R.color.background));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setFocusable(true);

        // 原生桥优先于 document-start 注入：旧 WebView 也能上报，且不受页面跨域限制。
        webView.addJavascriptInterface(new NativeBridge(), "InotiaNative");

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // 页面是 HTTPS 源，调试包可能通过 adb reverse 访问本机 HTTP 服务。
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setTextZoom(100);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(true);

        // 在页面脚本之前把统一的服务地址交给页面；网页版没有这个全局变量，仍用相对路径。
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView,
                    endpointsScript(), Collections.singleton("*"));
        }

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                // document-start 不可用的旧 WebView 在页面开始加载时补一次；用 || 避免
                // 覆盖已经注入的地址。页面到点上传/下载时才读，所以晚一点也能生效。
                view.evaluateJavascript(endpointsFallbackScript(), null);
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(
                    @NonNull WebView view, @NonNull WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(
                    @NonNull WebView view, @NonNull WebResourceRequest request) {
                String host = request.getUrl().getHost();
                return host == null || !ASSET_HOST.equals(host);
            }

            @Override
            public boolean onRenderProcessGone(
                    @NonNull WebView view, @NonNull RenderProcessGoneDetail detail) {
                // 渲染进程被系统回收后 WebView 实例不可再用，换一个新的，避免整个应用闪退。
                // 只有正在等待新版本启动完成时，Manager 才会接管并回退；正常游玩只重建。
                if (updateManager.onRenderProcessGone()) {
                    return true;
                }
                root.post(MainActivity.this::recreateWebView);
                return true;
            }
        });

        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // ?v= 用内容版本号而不是 VERSION_CODE：重建 WebView 时才能稳定命中新资源。
        webView.loadUrl(GAME_URL + "?v=" + updateManager.currentBuildId());
    }

    private static String endpointsLiteral() {
        return "{\"version\":1,\"cloudBase\":" + JSONObject.quote(BuildConfig.CLOUD_SAVE_URL)
                + ",\"diagnosticsReport\":" + JSONObject.quote(BuildConfig.DIAGNOSTICS_URL)
                + "}";
    }

    private static String endpointsScript() {
        return "globalThis.__inoitaEndpoints=" + endpointsLiteral() + ";";
    }

    private static String endpointsFallbackScript() {
        return "globalThis.__inoitaEndpoints=globalThis.__inoitaEndpoints||"
                + endpointsLiteral() + ";";
    }

    /** 页面只提交已经组装好的诊断 JSON；地址和发送方式都由原生层固定。 */
    private final class NativeBridge {
        @JavascriptInterface
        public void report(String body, String requestId) {
            if (body == null || requestId == null || body.isEmpty() || body.length() > 65536) return;
            try {
                diagnosticsExecutor.execute(() -> {
                    boolean acknowledged = postDiagnostics(body);
                    WebView view = webView;
                    if (view == null) return;
                    view.post(() -> {
                        if (webView != view) return;
                        try {
                            view.evaluateJavascript("window.__inoitaNativeReportResult&&window.__inoitaNativeReportResult("
                                    + JSONObject.quote(requestId) + "," + acknowledged + ");", null);
                        } catch (RuntimeException ignored) {
                            // WebView 正在销毁时回调已经没有必要。
                        }
                    });
                });
            } catch (RuntimeException ignored) {
                // Activity 已销毁，新的页面会重新建立上报通道。
            }
        }

        /** 标题页加载完成时调用；提交本次新版本，之后渲染进程再崩溃也不回退。 */
        @JavascriptInterface
        public void markBootOk() {
            updateManager.markBootOk();
        }

        /** 返回当前壳版本、渠道和本地版本信息，供网页层诊断/GM 状态页读取。 */
        @JavascriptInterface
        public String buildInfo() {
            return updateManager.buildInfoJson();
        }
    }

    /** 把更新生命周期事件写进现有诊断通道；失败只记日志，不影响更新流程。 */
    private void reportUpdateEvent(String kind, String... keyValues) {
        try {
            JSONObject details = new JSONObject();
            for (int index = 0; index + 1 < keyValues.length; index += 2) {
                details.put(keyValues[index], keyValues[index + 1]);
            }
            JSONObject entry = new JSONObject();
            entry.put("id", UUID.randomUUID().toString());
            entry.put("kind", kind);
            entry.put("time", Instant.now().toString());
            entry.put("page", "/update");
            entry.put("details", details);
            JSONObject root = new JSONObject();
            root.put("version", 1);
            root.put("entries", new JSONArray().put(entry));
            String body = root.toString();
            diagnosticsExecutor.execute(() -> postDiagnostics(body));
        } catch (Exception error) {
            Log.w("InotiaUpdate", "更新事件上报失败: " + error.getMessage());
        }
    }

    private boolean postDiagnostics(String body) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(BuildConfig.DIAGNOSTICS_URL).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.w("InotiaDiagnostics", "diagnostics report returned HTTP " + code);
                return false;
            }
            return true;
        } catch (Exception error) {
            Log.w("InotiaDiagnostics", "diagnostics report failed: " + error.getClass().getSimpleName());
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    // ---- 更新界面 ----

    @Override
    public void onUpdateAvailable(String buildId, int fileCount, long downloadBytes) {
        if (isFinishing() || isDestroyed()) return;
        reportUpdateEvent("update-available", "buildId", buildId,
                "files", String.valueOf(fileCount), "bytes", String.valueOf(downloadBytes));
        dismissCheckFailedDialog();
        dismissUpdateDialog();

        String megabytes = String.format(Locale.US, "%.1f", downloadBytes / 1048576.0);
        updateDialog = new AlertDialog.Builder(this)
                .setTitle(R.string.update_available_title)
                .setMessage(getString(R.string.update_available_message, megabytes, fileCount))
                .setPositiveButton(R.string.update_now, (dialog, which) -> {
                    updateDialog = null;
                    reportUpdateEvent("download-start", "buildId", buildId,
                            "files", String.valueOf(fileCount));
                    showDownloadDialog(fileCount);
                    updateManager.startDownload();
                })
                .setNegativeButton(R.string.update_later, (dialog, which) -> {
                    updateDialog = null;
                    reportUpdateEvent("update-deferred", "buildId", buildId);
                    updateManager.deferUpdate();
                    dialog.dismiss();
                })
                .create();
        updateDialog.show();
    }

    @Override
    public void onDownloadProgress(int completed, int total) {
        if (isFinishing() || isDestroyed()) return;
        // Activity 重建后恢复下载进度框；一直下载中也要能重新显示。
        if (downloadDialog == null) showDownloadDialog(Math.max(1, total));
        if (downloadDialog == null) return;
        downloadDialog.setMax(Math.max(1, total));
        downloadDialog.setProgress(Math.min(completed, total));
        downloadDialog.setMessage(getString(
                R.string.update_downloading_message, completed, total));
    }

    @Override
    public void onUpdateReady(String buildId) {
        if (isFinishing() || isDestroyed()) return;
        reportUpdateEvent("update-ready", "buildId", buildId);
        dismissUpdateDialog();
        new AlertDialog.Builder(this)
                .setTitle(R.string.update_ready_title)
                .setMessage(R.string.update_ready_message)
                .setPositiveButton(R.string.update_restart_now,
                        (dialog, which) -> updateManager.applyReadyUpdate())
                .setNegativeButton(R.string.update_later,
                        (dialog, which) -> updateManager.deferUpdate())
                .show();
    }

    @Override
    public void onUpdateApplied(String buildId) {
        reportUpdateEvent("update-applied", "buildId", buildId, "buildInfo", updateManager.buildInfoJson());
        dismissProgressDialog();
        recreateWebView();
        showBootingDialog();
        startBootWatchdog();
    }

    @Override
    public void onUpdateFailed(String reason, boolean cancelled) {
        dismissProgressDialog();
        Log.w("InotiaUpdate", "更新未完成: " + reason + (cancelled ? "（已取消）" : ""));
        reportUpdateEvent("update-failed", "reason", reason == null ? "" : reason,
                "cancelled", String.valueOf(cancelled), "buildInfo", updateManager.buildInfoJson());
        if (cancelled || isFinishing() || isDestroyed()) return;
        new AlertDialog.Builder(this)
                .setTitle(R.string.update_failed_title)
                .setMessage(getString(R.string.update_failed_message, reason))
                .setPositiveButton(R.string.update_retry, (dialog, which) -> updateManager.retryAfterFailure())
                .setNegativeButton(R.string.update_later, null)
                .show();
    }

    @Override
    public void onRollbackComplete(String failedBuildId) {
        reportUpdateEvent("update-rollback", "failedBuildId", failedBuildId,
                "buildInfo", updateManager.buildInfoJson());
        stopBootWatchdog();
        dismissBootingDialog();
        recreateWebView();
        if (!isFinishing() && !isDestroyed()) {
            new AlertDialog.Builder(this)
                    .setTitle(R.string.update_rollback_title)
                    .setMessage(R.string.update_rollback_message)
                    .setPositiveButton(R.string.update_retry, (dialog, which) -> updateManager.retryUpdate())
                    .setNegativeButton(R.string.update_later, null)
                    .show();
        }
    }

    @Override
    public void onBootCommitted() {
        reportUpdateEvent("update-boot-ok", "buildInfo", updateManager.buildInfoJson());
        stopBootWatchdog();
        dismissBootingDialog();
    }

    @Override
    public void onUpdateCheckStart() {
        reportUpdateEvent("update-check-start", "buildInfo", updateManager.buildInfoJson());
    }

    @Override
    public void onUpdateCheckResult(String result, String error) {
        reportUpdateEvent("update-check", "result", result == null ? "" : result,
                "error", error == null ? "" : error, "buildInfo", updateManager.buildInfoJson());
    }

    @Override
    public void onUpdateCheckFailed(String reason) {
        if (isFinishing() || isDestroyed()) return;
        Log.w("InotiaUpdate", "检查更新失败: " + reason);
        if (checkFailedDialog != null && checkFailedDialog.isShowing()) return;
        checkFailedDialog = new AlertDialog.Builder(this)
                .setTitle(R.string.update_check_failed_title)
                .setMessage(R.string.update_check_failed_message)
                .setPositiveButton(R.string.update_retry, (dialog, which) -> {
                    checkFailedDialog = null;
                    updateManager.retryUpdate();
                })
                .setNegativeButton(R.string.update_later,
                        (dialog, which) -> checkFailedDialog = null)
                .create();
        checkFailedDialog.show();
    }

    private void showDownloadDialog(int fileCount) {
        if (isFinishing() || isDestroyed()) return;
        dismissProgressDialog();
        downloadDialog = new ProgressDialog(this);
        downloadDialog.setTitle(R.string.update_downloading_title);
        downloadDialog.setMessage(getString(R.string.update_downloading_message, 0, fileCount));
        downloadDialog.setProgressStyle(ProgressDialog.STYLE_HORIZONTAL);
        downloadDialog.setMax(Math.max(1, fileCount));
        downloadDialog.setProgress(0);
        downloadDialog.setCancelable(true);
        downloadDialog.setCanceledOnTouchOutside(false);
        downloadDialog.setOnCancelListener(dialog -> updateManager.cancelDownload());
        downloadDialog.show();
    }

    private void showBootingDialog() {
        if (isFinishing() || isDestroyed()) return;
        dismissBootingDialog();
        bootingDialog = new AlertDialog.Builder(this)
                .setMessage(R.string.update_booting)
                .setCancelable(false)
                .create();
        bootingDialog.show();
    }

    private void startBootWatchdog() {
        mainHandler.removeCallbacks(bootWatchdog);
        mainHandler.postDelayed(bootWatchdog, BOOT_TIMEOUT_MS);
    }

    private void stopBootWatchdog() {
        mainHandler.removeCallbacks(bootWatchdog);
    }

    private void onBootWatchdog() {
        if (updateManager != null && updateManager.isBooting()) {
            updateManager.onBootTimeout();
        }
    }

    private void dismissUpdateDialog() {
        if (updateDialog != null) {
            updateDialog.dismiss();
            updateDialog = null;
        }
    }

    private void dismissCheckFailedDialog() {
        if (checkFailedDialog != null) {
            checkFailedDialog.dismiss();
            checkFailedDialog = null;
        }
    }

    private void dismissProgressDialog() {
        if (downloadDialog != null) {
            downloadDialog.dismiss();
            downloadDialog = null;
        }
    }

    private void dismissBootingDialog() {
        if (bootingDialog != null) {
            bootingDialog.dismiss();
            bootingDialog = null;
        }
    }

    private void destroyWebView() {
        if (webView == null) return;
        root.removeView(webView);
        webView.destroy();
        webView = null;
    }

    private void recreateWebView() {
        if (isFinishing() || isDestroyed()) {
            return;
        }
        destroyWebView();
        createWebView();
    }

    private void hideSystemBars() {
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemBars();
        }
    }

    @Override
    protected void onPause() {
        WebView view = webView;
        if (view != null) {
            // 先让页面跑完 pagehide（暂停场景、音频并落一次自动存档），再冻结 WebView。
            view.evaluateJavascript("window.dispatchEvent(new Event('pagehide'));", ignored -> {
                view.onPause();
                view.pauseTimers();
            });
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        WebView view = webView;
        if (view != null) {
            view.resumeTimers();
            view.onResume();
            view.postDelayed(() -> view.evaluateJavascript(
                    "window.dispatchEvent(new Event('pageshow'));", null), 50);
        }
        hideSystemBars();
        if (updateManager != null) updateManager.checkForUpdateOnForeground();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        WebView view = webView;
        if (view != null) {
            view.requestFocus();
            long now = SystemClock.uptimeMillis();
            dispatchEscape(view, now);
        }

        long now = SystemClock.uptimeMillis();
        if (now - lastBackPressed <= DOUBLE_BACK_MS) {
            lastBackPressed = 0;
            confirmExit();
        } else {
            lastBackPressed = now;
        }
    }

    private void dispatchEscape(WebView view, long now) {
        KeyEvent down = new KeyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ESCAPE,
                0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0,
                KeyEvent.FLAG_FROM_SYSTEM, InputDevice.SOURCE_KEYBOARD);
        KeyEvent up = new KeyEvent(now, now, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ESCAPE,
                0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0,
                KeyEvent.FLAG_FROM_SYSTEM, InputDevice.SOURCE_KEYBOARD);
        view.dispatchKeyEvent(down);
        view.dispatchKeyEvent(up);
    }

    private void confirmExit() {
        if (isFinishing() || isDestroyed()) {
            return;
        }
        new AlertDialog.Builder(this)
                .setMessage(R.string.exit_message)
                .setPositiveButton(R.string.exit_confirm, (dialog, which) -> finish())
                .setNegativeButton(R.string.exit_cancel, null)
                .show();
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacks(bootWatchdog);
        dismissUpdateDialog();
        dismissCheckFailedDialog();
        dismissProgressDialog();
        dismissBootingDialog();
        if (updateManager != null) {
            updateManager.clearListener(this);
            updateManager.cancelDownload();
        }
        diagnosticsExecutor.shutdownNow();
        destroyWebView();
        super.onDestroy();
    }
}
