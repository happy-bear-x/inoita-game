package io.github.sunflower9264.inoita;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import org.json.JSONTokener;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;

/**
 * 把旧 WebView 地址下的 localStorage 搬到 Cefrium 的新地址。
 *
 * 旧壳页面地址是 https://appassets.androidplatform.net，新壳是 http://127.0.0.1:端口。
 * 浏览器把两者当成两个网站，所以必须在第一次启动时导出一次，再由页面脚本写进新地址。
 */
final class SaveMigration {

    private static final String TAG = "InotiaMigration";
    private static final String PREFS = "inoita-migration";
    private static final String KEY_DONE = "localStorage-migrated";
    private static final String BACKUP = "migration-localstorage.json";
    private static final long TIMEOUT_MS = 8000;

    interface Callback {
        void onDone(String json);
    }

    private SaveMigration() {}

    static boolean isNeeded(Context context) {
        return !prefs(context).getBoolean(KEY_DONE, false);
    }

    static void markDone(Context context) {
        prefs(context).edit().putBoolean(KEY_DONE, true).apply();
    }

    static String readBackup(Context context) {
        File file = new File(context.getFilesDir(), BACKUP);
        if (!file.isFile()) return null;
        try (InputStream input = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) file.length()];
            int offset = 0;
            while (offset < bytes.length) {
                int read = input.read(bytes, offset, bytes.length - offset);
                if (read < 0) break;
                offset += read;
            }
            return new String(bytes, 0, offset, StandardCharsets.UTF_8);
        } catch (Exception error) {
            Log.w(TAG, "读取迁移备份失败", error);
            return null;
        }
    }

    static void migrateIfNeeded(Activity activity, Callback callback) {
        if (!isNeeded(activity)) {
            callback.onDone(null);
            return;
        }
        final boolean[] finished = {false};
        final Handler main = new Handler(Looper.getMainLooper());
        WebView view;
        try {
            view = new WebView(activity);
        } catch (Throwable error) {
            Log.w(TAG, "系统 WebView 不可用，跳过旧存档迁移", error);
            callback.onDone(null);
            return;
        }

        final Consumer<String> finish = json -> {
            if (finished[0]) return;
            finished[0] = true;
            main.removeCallbacksAndMessages(null);
            try {
                view.stopLoading();
                view.destroy();
            } catch (RuntimeException ignored) {
                // 迁移失败不应影响新引擎启动。
            }
            callback.onDone(json);
        };

        try {
            view.getSettings().setJavaScriptEnabled(true);
            view.getSettings().setDomStorageEnabled(true);
            view.getSettings().setAllowFileAccess(false);
            view.getSettings().setAllowContentAccess(false);

            WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                    .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(activity))
                    .build();
            view.setWebViewClient(new WebViewClientCompat() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView webView, WebResourceRequest request) {
                    return loader.shouldInterceptRequest(request.getUrl());
                }

                @Override
                public void onPageFinished(WebView webView, String url) {
                    webView.evaluateJavascript("JSON.stringify(window.__migration||{})", value -> {
                        String json = unquote(value);
                        if (json != null) writeBackup(activity, json);
                        finish.accept(json);
                    });
                }
            });

            main.postDelayed(() -> {
                Log.w(TAG, "旧存档迁移超时");
                finish.accept(null);
            }, TIMEOUT_MS);
            view.loadUrl("https://appassets.androidplatform.net/migrate.html");
        } catch (Throwable error) {
            Log.w(TAG, "启动旧存档迁移失败", error);
            finish.accept(null);
        }
    }

    private static String unquote(String value) {
        if (value == null) return null;
        try {
            Object parsed = new JSONTokener(value).nextValue();
            return parsed instanceof String ? (String) parsed : parsed.toString();
        } catch (Exception error) {
            Log.w(TAG, "解析迁移结果失败", error);
            return null;
        }
    }

    private static void writeBackup(Context context, String json) {
        try (FileOutputStream output = new FileOutputStream(new File(context.getFilesDir(), BACKUP))) {
            output.write(json.getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) {
            Log.w(TAG, "写入迁移备份失败", error);
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
