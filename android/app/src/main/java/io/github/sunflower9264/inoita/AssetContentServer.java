package io.github.sunflower9264.inoita;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.cefrium.CefriumContentRequest;
import com.cefrium.CefriumContentResponse;
import com.cefrium.CefriumContentServer;
import com.cefrium.CefriumProfile;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * 页面内容服务：由 Cefrium 在进程内回答 App 自己的 HTTPS origin，不开端口。
 *
 * 职责是：按 UpdateManager 快照送 dist 文件、提供原生桥、转发云存档和诊断请求。
 * 所有请求在后台线程并发执行，这里只保存不可变快照和线程安全的回调。
 */
final class AssetContentServer implements CefriumContentServer {

    interface FrameRateListener {
        void onFrameRateRequested(int rate);
    }

    /** 页面 origin 是 localStorage 的身份，发布后不能改。 */
    static final String ORIGIN = "https://inoita.invalid";
    static final int FRAME_RATE_30 = 30;
    static final int FRAME_RATE_60 = 60;

    private static final String TAG = "InotiaContent";
    private static final int MAX_BODY_BYTES = 32 * 1024 * 1024;
    private static final int PROXY_CONNECT_TIMEOUT_MS = 15000;
    private static final int PROXY_READ_TIMEOUT_MS = 30000;
    private static final int HTTP_BAD_GATEWAY = 502;
    private static final int READ_BUFFER_BYTES = 16 * 1024;

    private static volatile AssetContentServer instance;

    private final Context context;
    private final UpdateManager manager;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile FrameRateListener frameRateListener;

    private AssetContentServer(Context context, UpdateManager manager) {
        this.context = context.getApplicationContext();
        this.manager = manager;
    }

    /** 注册一次并跟随进程；Activity 重建时直接复用。 */
    static synchronized AssetContentServer install(Context context, UpdateManager manager) {
        if (instance != null) return instance;
        AssetContentServer server = new AssetContentServer(context, manager);
        CefriumProfile.getDefault().registerContentServer(ORIGIN, server);
        instance = server;
        return server;
    }

    void setFrameRateListener(FrameRateListener listener) {
        frameRateListener = listener;
    }

    /** 只清空自己设置的监听，避免新旧 Activity 互相覆盖。 */
    void clearFrameRateListener(FrameRateListener listener) {
        if (frameRateListener == listener) frameRateListener = null;
    }

    @Override
    public CefriumContentResponse serve(CefriumContentRequest request) throws IOException {
        String path = request.getPath();
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";

        if (path.equals("/__native/report") || path.equals("/__diagnostics/report")) {
            return nativeReport(request);
        }
        if (path.equals("/__native/boot-ok")) {
            mainHandler.post(manager::markBootOk);
            return empty(204, "No Content");
        }
        if (path.equals("/__native/build-info")) return json(manager.buildInfoJson());
        if (path.equals("/__native/frame-rate")) return nativeFrameRate(request);
        if (path.equals("/__native/bootstrap.js")) return bootstrap();
        if (path.equals("/__cloud") || path.startsWith("/__cloud/")) return proxyCloud(request);
        return serveAsset(path);
    }

    private CefriumContentResponse nativeReport(CefriumContentRequest request) {
        byte[] body = body(request);
        if (body == null) return text(400, "Bad Request", "body too large");
        boolean ok = Diagnostics.post(new String(body, StandardCharsets.UTF_8));
        return empty(ok ? 200 : 500, ok ? "OK" : "Internal Server Error");
    }

    /** 页面只报 30/60；壳自己选刷新率能整除它的显示模式。 */
    private CefriumContentResponse nativeFrameRate(CefriumContentRequest request) {
        String query = request.getQuery();
        String value = query == null ? null : Uri.parse("?" + query).getQueryParameter("rate");
        int rate;
        try {
            rate = Integer.parseInt(value == null ? "" : value.trim());
        } catch (NumberFormatException error) {
            rate = 0;
        }
        if (rate == FRAME_RATE_30 || rate == FRAME_RATE_60) {
            final int requested = rate;
            mainHandler.post(() -> {
                FrameRateListener listener = frameRateListener;
                if (listener != null) listener.onFrameRateRequested(requested);
            });
        }
        return empty(204, "No Content");
    }

    private CefriumContentResponse proxyCloud(CefriumContentRequest request) {
        String suffix;
        String query;
        try {
            URI uri = new URI(request.getUrl());
            String rawPath = uri.getRawPath();
            if (rawPath == null || !rawPath.startsWith("/__cloud")) {
                return text(400, "Bad Request", "bad cloud path");
            }
            suffix = rawPath.substring("/__cloud".length());
            query = uri.getRawQuery();
        } catch (URISyntaxException error) {
            return text(400, "Bad Request", "bad cloud url");
        }

        String target = BuildConfig.CLOUD_SAVE_URL + suffix
                + (query == null || query.isEmpty() ? "" : "?" + query);
        byte[] body = body(request);
        if (body == null) return text(400, "Bad Request", "body too large");

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(target).openConnection();
            connection.setRequestMethod(request.getMethod());
            connection.setConnectTimeout(PROXY_CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(PROXY_READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept-Encoding", "identity");
            // 不转发 Origin：云存档服务只认旧 allowlist。
            String contentType = request.getHeader("Content-Type");
            if (contentType != null) connection.setRequestProperty("Content-Type", contentType);
            String authorization = request.getHeader("Authorization");
            if (authorization != null) connection.setRequestProperty("Authorization", authorization);
            if (body.length > 0) {
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(body);
                }
            }

            int code = connection.getResponseCode();
            InputStream input = code >= HttpURLConnection.HTTP_BAD_REQUEST
                    ? connection.getErrorStream() : connection.getInputStream();
            byte[] data = input == null ? new byte[0] : readAll(input);
            String type = connection.getContentType();
            CefriumContentResponse response = proxyResponse(type, data);
            response.setStatus(code, reason(connection.getResponseMessage()));
            String encoding = connection.getHeaderField("Content-Encoding");
            if (encoding != null) response.setHeader("Content-Encoding", encoding);
            return response;
        } catch (Exception error) {
            Log.w(TAG, "代理请求失败: " + target, error);
            return text(HTTP_BAD_GATEWAY, "Bad Gateway", "proxy error");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private CefriumContentResponse serveAsset(String path) throws IOException {
        String relative = AssetPaths.normalizeDecoded(path);
        if (relative == null) return null;

        UpdateManager.Snapshot snapshot = manager.snapshot();
        File file = null;
        if (snapshot.isAuthoritative()) {
            if (!snapshot.paths().contains(relative)) return null;
            file = snapshot.files().get(relative);
        }

        if (file != null && file.isFile()) {
            try {
                if (relative.equals("index.html")) return htmlFile(file);
                CefriumContentResponse response =
                        new CefriumContentResponse(AssetPaths.mimeType(relative), new FileInputStream(file));
                if (AssetPaths.needsUtf8(relative)) response.setCharset("utf-8");
                response.setContentLength(file.length());
                response.setHeader("Cache-Control", AssetPaths.cachePolicy(relative));
                return response;
            } catch (IOException error) {
                return null;
            }
        }

        try (InputStream input = context.getAssets().open(relative)) {
            byte[] data = readAll(input);
            if (relative.equals("index.html")) return htmlResponse(injectBootstrap(data));
            CefriumContentResponse response = response(AssetPaths.mimeType(relative), data);
            if (AssetPaths.needsUtf8(relative)) response.setCharset("utf-8");
            response.setHeader("Cache-Control", AssetPaths.cachePolicy(relative));
            return response;
        } catch (IOException error) {
            return null;
        }
    }

    private CefriumContentResponse htmlFile(File file) throws IOException {
        byte[] data;
        try (InputStream input = new FileInputStream(file)) {
            data = injectBootstrap(readAll(input));
        }
        return htmlResponse(data);
    }

    private static CefriumContentResponse htmlResponse(byte[] data) {
        CefriumContentResponse response = response("text/html", data);
        response.setCharset("utf-8");
        response.setHeader("Cache-Control", AssetPaths.cachePolicy("index.html"));
        return response;
    }

    /** 在入口 HTML 的 head 最前面插入 bootstrap，保证它先于模块脚本和 diagnostics.js。 */
    private static byte[] injectBootstrap(byte[] htmlBytes) {
        String html = new String(htmlBytes, StandardCharsets.UTF_8);
        String tag = "<script src=\"/__native/bootstrap.js\"></script>";
        int head = html.toLowerCase(Locale.US).indexOf("<head");
        if (head >= 0) {
            int end = html.indexOf('>', head);
            if (end >= 0) html = html.substring(0, end + 1) + tag + html.substring(end + 1);
            else html = tag + html;
        } else {
            html = tag + html;
        }
        return html.getBytes(StandardCharsets.UTF_8);
    }

    private CefriumContentResponse bootstrap() {
        String endpoints = "{\"version\":1"
                + ",\"cloudBase\":" + jsString(ORIGIN + "/__cloud")
                + ",\"diagnosticsReport\":" + jsString(ORIGIN + "/__diagnostics/report")
                + "}";
        StringBuilder script = new StringBuilder();
        script.append("globalThis.__inoitaEngine='cefrium';");
        script.append("globalThis.__inoitaEndpoints=").append(endpoints).append(";");
        script.append("globalThis.__inoitaBuildInfo=").append(manager.buildInfoJson()).append(";");
        script.append("window.InotiaNative={")
                .append("report:function(body,id){")
                .append("fetch('/__native/report',{method:'POST',headers:{'Content-Type':'application/json'},body:body})")
                .append(".then(function(r){return r.ok}).catch(function(){return false})")
                .append(".then(function(ok){try{window.__inoitaNativeReportResult&&window.__inoitaNativeReportResult(id,ok)}catch(e){}});")
                .append("},")
                .append("markBootOk:function(){fetch('/__native/boot-ok',{method:'POST'}).catch(function(){});},")
                .append("setFrameRate:function(rate){fetch('/__native/frame-rate?rate='+encodeURIComponent(rate),{method:'POST'}).catch(function(){});},")
                .append("buildInfo:function(){return JSON.stringify(globalThis.__inoitaBuildInfo||{});}")
                .append("};");

        byte[] data = script.toString().getBytes(StandardCharsets.UTF_8);
        CefriumContentResponse response = response("text/javascript", data);
        response.setCharset("utf-8");
        response.setHeader("Cache-Control", "no-store");
        return response;
    }

    private static CefriumContentResponse proxyResponse(String contentType, byte[] data) {
        String type = contentType == null ? "application/json" : contentType;
        String mime = type;
        String charset = null;
        int semicolon = type.indexOf(';');
        if (semicolon >= 0) {
            mime = type.substring(0, semicolon).trim();
            String rest = type.substring(semicolon + 1).trim();
            if (rest.toLowerCase(Locale.US).startsWith("charset=")) {
                charset = rest.substring("charset=".length()).trim();
            }
        }
        CefriumContentResponse response = response(mime, data);
        if (charset != null && !charset.isEmpty()) response.setCharset(charset);
        return response;
    }

    private static CefriumContentResponse json(String body) {
        byte[] data = body.getBytes(StandardCharsets.UTF_8);
        CefriumContentResponse response = response("application/json", data);
        response.setCharset("utf-8");
        return response;
    }

    private static CefriumContentResponse response(String mime, byte[] data) {
        CefriumContentResponse response =
                new CefriumContentResponse(mime, new ByteArrayInputStream(data));
        response.setContentLength(data.length);
        return response;
    }

    private static CefriumContentResponse text(int status, String reason, String body) {
        byte[] data = body.getBytes(StandardCharsets.UTF_8);
        CefriumContentResponse response = response("text/plain", data);
        response.setCharset("utf-8");
        response.setStatus(status, reason);
        return response;
    }

    private static CefriumContentResponse empty(int status, String reason) {
        CefriumContentResponse response = new CefriumContentResponse("text/plain", null);
        response.setStatus(status, reason);
        return response;
    }

    private static String reason(String value) {
        return value == null ? "" : value;
    }

    private static String jsString(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r") + "\"";
    }

    private static byte[] body(CefriumContentRequest request) {
        byte[] body = request.getBody();
        if (body == null) return new byte[0];
        if (body.length > MAX_BODY_BYTES) return null;
        return body;
    }

    private static byte[] readAll(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[READ_BUFFER_BYTES];
        int read;
        while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
        return output.toByteArray();
    }
}
