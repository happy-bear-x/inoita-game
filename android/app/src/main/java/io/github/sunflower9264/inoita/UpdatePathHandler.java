package io.github.sunflower9264.inoita;

import android.util.Log;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceResponse;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 页面资源的加载器：清单是权威，磁盘优先，APK assets 兜底。
 *
 * 新版本删掉的路径即使 APK 里还有旧副本也必须 404，否则旧文件会被「复活」。
 * 清单读不出来时快照会标记为不可信，此时全部交给 AssetsPathHandler，保证还能
 * 用 APK 资源启动，而不是整站 404。
 */
final class UpdatePathHandler implements WebViewAssetLoader.PathHandler {

    private static final String TAG = "InotiaUpdate";

    private final UpdateManager manager;
    private final WebViewAssetLoader.AssetsPathHandler assets;

    UpdatePathHandler(UpdateManager manager, WebViewAssetLoader.AssetsPathHandler assets) {
        this.manager = manager;
        this.assets = assets;
    }

    @Nullable
    @Override
    public WebResourceResponse handle(@NonNull String path) {
        // WebView 访问根路径时传进来的是空串；沿用 AssetsPathHandler 的行为，落到 index.html。
        String requested = path == null || path.isEmpty() || "/".equals(path) ? "index.html" : path;
        String relative = normalize(requested);
        if (relative == null) return notFound();

        UpdateManager.Snapshot snapshot = manager.snapshot();
        if (!snapshot.isAuthoritative()) {
            // 没有可解析的清单：退回 APK 资源，不能把所有请求都判 404。
            return fallback(requested);
        }

        if (!snapshot.paths().contains(relative)) return notFound();

        File file = snapshot.files().get(relative);
        if (file != null) {
            WebResourceResponse response = fromFile(relative, file, snapshot);
            if (response != null) return response;
        }
        // 清单里有、但当前版本目录没有：使用 APK 自带的那份。
        return fallback(requested);
    }

    /** AssetsPathHandler 对缺失文件返回 null；转成显式 404，避免 WebView 去访问网络。 */
    private WebResourceResponse fallback(String path) {
        WebResourceResponse response = assets.handle(path);
        return response == null ? notFound() : response;
    }

    /** 按段解码并拒绝 .、..、反斜杠、NUL、隐藏段和空段。 */
    @Nullable
    static String normalize(@Nullable String rawPath) {
        if (rawPath == null || rawPath.isEmpty()) return null;
        String path = rawPath.charAt(0) == '/' ? rawPath.substring(1) : rawPath;
        if (path.isEmpty()) return null;
        if (path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) return null;

        String[] segments = path.split("/", -1);
        StringBuilder result = new StringBuilder(path.length());
        for (String segment : segments) {
            if (segment.isEmpty()) return null;
            String decoded;
            try {
                // URLDecoder 会把 + 当成空格；路径里 + 是字面量，先转义回来。
                decoded = URLDecoder.decode(segment.replace("+", "%2B"), "UTF-8");
            } catch (IllegalArgumentException | IOException error) {
                return null;
            }
            if (decoded.isEmpty() || decoded.equals(".") || decoded.equals("..")) return null;
            if (decoded.charAt(0) == '.') return null;
            if (decoded.indexOf('/') >= 0 || decoded.indexOf('\\') >= 0
                    || decoded.indexOf('\0') >= 0) {
                return null;
            }
            if (result.length() > 0) result.append('/');
            result.append(decoded);
        }
        return result.toString();
    }

    @Nullable
    private WebResourceResponse fromFile(String relative, File file,
                                         UpdateManager.Snapshot snapshot) {
        File root = snapshot.buildRoot();
        if (root == null || !file.isFile()) return null;
        try {
            String rootPath = root.getCanonicalPath() + File.separator;
            String filePath = file.getCanonicalPath();
            if (!filePath.startsWith(rootPath)) {
                Log.w(TAG, "拒绝越界资源: " + relative);
                return notFound();
            }
            String mime = mimeType(relative);
            String encoding = needsUtf8(relative, mime) ? "utf-8" : null;
            return new WebResourceResponse(mime, encoding, 200, "OK",
                    headers(relative), new FileInputStream(file));
        } catch (IOException error) {
            Log.w(TAG, "读取版本文件失败: " + relative);
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                headers, new ByteArrayInputStream(new byte[0]));
    }

    private static Map<String, String> headers(String relative) {
        Map<String, String> headers = new HashMap<>();
        // 和 AssetsPathHandler 保持一致：模块脚本和 fetch 需要这个头。
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", cachePolicy(relative));
        return headers;
    }

    private static String cachePolicy(String relative) {
        if (relative.startsWith("bundles/")) {
            return "public, max-age=31536000, immutable";
        }
        if (relative.equals("index.html") || relative.equals("diagnostics.js")) {
            return "no-store";
        }
        return "no-cache";
    }

    private static String mimeType(String relative) {
        int dot = relative.lastIndexOf('.');
        String extension = dot < 0 ? "" : relative.substring(dot + 1).toLowerCase(Locale.US);
        switch (extension) {
            case "json":
                return "application/json";
            case "js":
            case "mjs":
                return "text/javascript";
            case "html":
                return "text/html";
            case "css":
                return "text/css";
            case "svg":
                return "image/svg+xml";
            case "webmanifest":
                return "application/manifest+json";
            case "wasm":
                return "application/wasm";
            default:
                String guessed = MimeTypeMap.getSingleton()
                        .getMimeTypeFromExtension(extension);
                return guessed == null ? "application/octet-stream" : guessed;
        }
    }

    private static boolean needsUtf8(String relative, String mime) {
        int dot = relative.lastIndexOf('.');
        String extension = dot < 0 ? "" : relative.substring(dot + 1).toLowerCase(Locale.US);
        return extension.equals("json") || extension.equals("js") || extension.equals("mjs")
                || extension.equals("html") || extension.equals("css")
                || extension.equals("svg") || extension.equals("webmanifest")
                || mime.startsWith("text/");
    }
}
