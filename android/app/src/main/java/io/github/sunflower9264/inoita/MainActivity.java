package io.github.sunflower9264.inoita;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.cefrium.Cefrium;
import com.cefrium.CefriumBrowser;

import java.io.IOException;
import java.util.Locale;

/**
 * 自带 Chromium 156 的 WebView 壳。
 *
 * 页面不再交给系统 WebView，而是由 Cefrium 内置的 Chromium 打开。页面从本地
 * 127.0.0.1 HTTP 服务加载，热更目录、云存档和诊断都走同一个 origin。
 */
public class MainActivity extends Activity implements UpdateManager.Listener {

    private static final String TAG = "InotiaCefrium";
    private static final long DOUBLE_BACK_MS = 2000;
    private static final long BOOT_TIMEOUT_MS = 90000;
    private static final String ESCAPE_SCRIPT =
            "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true}));"
            + "window.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true}));";

    private FrameLayout root;
    private CefriumBrowser browser;
    private LocalAssetServer server;
    private UpdateManager updateManager;
    private long lastBackPressed;
    private boolean pageReady;
    private String migrationJson;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable createBrowserTask = this::createBrowser;
    private final Runnable pauseBrowserTask = () -> {
        if (browser != null) browser.onPause();
    };
    private final Runnable bootWatchdog = this::onBootWatchdog;

    private AlertDialog updateDialog;
    private AlertDialog checkFailedDialog;
    private ProgressDialog downloadDialog;
    private AlertDialog bootingDialog;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
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
        CrashLog.deviceInfo(this, "activity-start");

        if (!Cefrium.isInitialized()) {
            // Application 初始化失败时再补一次；Cefrium 只允许初始化一次，失败则直接报错。
            try {
                Cefrium.initialize(this);
            } catch (Throwable error) {
                InotiaApplication.initializeError = Log.getStackTraceString(error);
                CrashLog.append(this, "crash.log", "cefrium-retry: " + Log.getStackTraceString(error));
            }
        }
        if (!Cefrium.isInitialized()) {
            showFatal(getString(R.string.browser_init_failed_title),
                    getString(R.string.browser_init_failed_message)
                            + (InotiaApplication.initializeError == null ? ""
                            : "\n\n" + InotiaApplication.initializeError));
            return;
        }

        updateManager = UpdateManager.get(getApplicationContext());
        updateManager.setListener(this);
        startWithMigration();
        hideSystemBars();
    }

    private void startWithMigration() {
        final boolean needed = SaveMigration.isNeeded(this);
        final ProgressDialog migrationDialog;
        if (needed) {
            migrationDialog = new ProgressDialog(this);
            migrationDialog.setMessage(getString(R.string.migration_booting));
            migrationDialog.setCancelable(false);
            migrationDialog.show();
        } else {
            migrationDialog = null;
        }

        SaveMigration.migrateIfNeeded(this, json -> {
            if (migrationDialog != null) migrationDialog.dismiss();
            if (isFinishing() || isDestroyed()) return;
            migrationJson = json;
            if (json == null || json.equals("{}")) SaveMigration.markDone(this);
            updateManager.initialize(this::onUpdateManagerReady);
            hideSystemBars();
        });
    }

    private void onUpdateManagerReady() {
        if (isFinishing() || isDestroyed()) return;
        try {
            server = new LocalAssetServer(this, updateManager, migrationJson, this::onMigrationDone);
            server.startServer();
        } catch (IOException error) {
            Log.e(TAG, "本地资源服务启动失败", error);
            showFatal(getString(R.string.local_server_failed_title),
                    getString(R.string.local_server_failed_message, LocalAssetServer.PORT));
            return;
        }
        createBrowser();
        hideSystemBars();
        if (updateManager.isBooting()) {
            showBootingDialog();
            startBootWatchdog();
        }
        if (!updateManager.repostPendingState()) updateManager.checkForUpdate();
    }

    private void onMigrationDone() {
        SaveMigration.markDone(this);
    }

    private void createBrowser() {
        if (isFinishing() || isDestroyed() || server == null) return;
        pageReady = false;
        try {
            browser = CefriumBrowser.createWithSurface(this);
        } catch (Throwable error) {
            Log.e(TAG, "创建 CefriumBrowser 失败", error);
            CrashLog.append(this, "crash.log", "create-browser: " + Log.getStackTraceString(error));
            showFatal(getString(R.string.browser_init_failed_title), Log.getStackTraceString(error));
            return;
        }
        browser.getSurfaceContainer().setBackgroundColor(getColor(R.color.background));
        root.addView(browser.getSurfaceContainer(), new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        browser.setMediaPlaybackRequiresUserGesture(false);
        browser.setPinchToZoomEnabled(false);
        browser.setDarkMode(false);
        browser.setDialogActivity(this);
        browser.setCallback(new CefriumBrowser.Callback() {
            @Override
            public void onFullscreenChanged(boolean fullscreen) {
                hideSystemBars();
            }

            @Override
            public void onLoadingStateChanged(boolean loading, boolean canGoBack, boolean canGoForward) {
                if (!loading) pageReady = true;
            }
        });
        browser.setOnRenderProcessTerminatedListener((code, reason) -> {
            // 等待新版本启动时由 UpdateManager 接管并回退；正常游玩只重建浏览器。
            if (updateManager.onRenderProcessGone()) return;
            root.post(this::recreateBrowser);
        });

        browser.loadUrl(server.baseUrl() + "/index.html?v=" + updateManager.currentBuildId());
    }

    private void recreateBrowser() {
        if (isFinishing() || isDestroyed()) return;
        pageReady = false;
        if (browser != null) {
            try {
                browser.close();
            } catch (RuntimeException ignored) {
                // 渲染进程已经退出时 close 可能失败；继续创建新实例。
            }
            browser = null;
        }
        root.removeAllViews();
        mainHandler.removeCallbacks(createBrowserTask);
        // 给 CEF 一点时间释放旧浏览器和渲染进程，再创建新实例。
        mainHandler.postDelayed(createBrowserTask, 300);
    }

    private void showFatal(String title, String message) {
        if (isFinishing() || isDestroyed()) return;
        CrashLog.append(this, "crash.log", "fatal " + title + ": " + message);
        new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(message)
                .setCancelable(false)
                .setPositiveButton(R.string.exit_confirm, (dialog, which) -> finish())
                .show();
    }

    private void reportUpdateEvent(String kind, String... keyValues) {
        Diagnostics.report(kind, keyValues);
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
        recreateBrowser();
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
        recreateBrowser();
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
        if (updateManager != null && updateManager.isBooting()) updateManager.onBootTimeout();
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
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onPause() {
        if (browser != null) {
            // 先让页面跑完 pagehide（暂停场景、音频并落一次自动存档），再冻结浏览器。
            if (pageReady) browser.evaluateJavaScript("window.dispatchEvent(new Event('pagehide'));");
            mainHandler.removeCallbacks(pauseBrowserTask);
            mainHandler.postDelayed(pauseBrowserTask, 150);
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        mainHandler.removeCallbacks(pauseBrowserTask);
        if (browser != null) {
            browser.onResume();
            if (pageReady) browser.evaluateJavaScript("window.dispatchEvent(new Event('pageshow'));");
        }
        hideSystemBars();
        if (updateManager != null) updateManager.checkForUpdateOnForeground();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (browser != null && pageReady) browser.evaluateJavaScript(ESCAPE_SCRIPT);

        long now = SystemClock.uptimeMillis();
        if (now - lastBackPressed <= DOUBLE_BACK_MS) {
            lastBackPressed = 0;
            confirmExit();
        } else {
            lastBackPressed = now;
        }
    }

    private void confirmExit() {
        if (isFinishing() || isDestroyed()) return;
        new AlertDialog.Builder(this)
                .setMessage(R.string.exit_message)
                .setPositiveButton(R.string.exit_confirm, (dialog, which) -> finish())
                .setNegativeButton(R.string.exit_cancel, null)
                .show();
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacks(bootWatchdog);
        mainHandler.removeCallbacks(createBrowserTask);
        mainHandler.removeCallbacks(pauseBrowserTask);
        dismissUpdateDialog();
        dismissCheckFailedDialog();
        dismissProgressDialog();
        dismissBootingDialog();
        if (browser != null) {
            try {
                browser.close();
            } catch (RuntimeException ignored) {
                // 进程退出阶段关闭失败不需要影响清理。
            }
            browser = null;
        }
        if (server != null) {
            server.stop();
            server = null;
        }
        if (updateManager != null) {
            updateManager.clearListener(this);
            updateManager.cancelDownload();
        }
        super.onDestroy();
    }
}
