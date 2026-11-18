package io.github.sunflower9264.inoita;

import android.webkit.MimeTypeMap;

import java.util.Locale;

/**
 * 内容服务的路径与响应头规则。
 *
 * 和原来的 WebViewAssetLoader 一样：资源清单是权威，磁盘优先，APK assets 兜底。
 */
final class AssetPaths {

    /** 构建产物文件名带内容哈希，可以按 immutable 缓存一年。 */
    private static final long IMMUTABLE_CACHE_MAX_AGE_SECONDS = 365L * 24 * 60 * 60;

    private AssetPaths() {}

    /** 内容服务传入的路径已经解码，这里只按段校验，不再做一次 URL 解码。 */
    static String normalizeDecoded(String rawPath) {
        if (rawPath == null || rawPath.isEmpty()) return null;
        String path = rawPath.charAt(0) == '/' ? rawPath.substring(1) : rawPath;
        if (path.isEmpty()) return null;
        if (path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) return null;

        String[] segments = path.split("/", -1);
        StringBuilder result = new StringBuilder(path.length());
        for (String segment : segments) {
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) return null;
            if (segment.charAt(0) == '.') return null;
            if (segment.indexOf('/') >= 0 || segment.indexOf('\\') >= 0
                    || segment.indexOf('\0') >= 0) return null;
            if (result.length() > 0) result.append('/');
            result.append(segment);
        }
        return result.toString();
    }

    static String mimeType(String relative) {
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
            case "mp3":
                return "audio/mpeg";
            case "webp":
                return "image/webp";
            default:
                String guessed = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
                return guessed == null ? "application/octet-stream" : guessed;
        }
    }

    static boolean needsUtf8(String relative) {
        String mime = mimeType(relative);
        int dot = relative.lastIndexOf('.');
        String extension = dot < 0 ? "" : relative.substring(dot + 1).toLowerCase(Locale.US);
        return extension.equals("json") || extension.equals("js") || extension.equals("mjs")
                || extension.equals("html") || extension.equals("css") || extension.equals("svg")
                || extension.equals("webmanifest") || mime.startsWith("text/");
    }

    static String cachePolicy(String relative) {
        if (relative.startsWith("bundles/")) {
            return "public, max-age=" + IMMUTABLE_CACHE_MAX_AGE_SECONDS + ", immutable";
        }
        if (relative.equals("index.html") || relative.equals("diagnostics.js")) return "no-store";
        return "no-cache";
    }
}
