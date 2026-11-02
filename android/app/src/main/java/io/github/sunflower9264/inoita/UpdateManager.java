package io.github.sunflower9264.inoita;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 进程级更新管理器：启动时解析当前版本清单，后台检查更新，必要时下载并切换版本。
 *
 * 线程约定：
 * - initialize/检查/下载/落盘都在后台线程，UI 回调统一切回主线程；
 * - 路径快照只在初始化或切换版本后整体替换，PathHandler 读到的永远是同一份不可变对象；
 * - pendingBoot 只在「刚切换到新版本、还没收到 markBootOk」时为真，回退只在这个窗口发生。
 */
final class UpdateManager {

    interface Listener {
        void onUpdateAvailable(int fileCount, long downloadBytes);

        void onDownloadProgress(int completed, int total);

        void onUpdateApplied(String buildId);

        void onUpdateFailed(String reason, boolean cancelled);

        void onRollbackComplete(String failedBuildId);

        void onBootCommitted();
    }

    /** WebView 的 IO 线程只读这份不可变快照，不碰任何可变状态。 */
    static final class Snapshot {
        private final String buildId;
        private final boolean authoritative;
        private final Set<String> paths;
        private final Map<String, File> files;
        private final File buildRoot;

        private Snapshot(String buildId, boolean authoritative, Set<String> paths,
                         Map<String, File> files, File buildRoot) {
            this.buildId = buildId;
            this.authoritative = authoritative;
            this.paths = paths;
            this.files = files;
            this.buildRoot = buildRoot;
        }

        static Snapshot apkOnly(String buildId) {
            return new Snapshot(buildId, false,
                    Collections.emptySet(), Collections.emptyMap(), null);
        }

        static Snapshot build(String buildId, UpdateManifest.Manifest manifest, File root) {
            if (manifest == null) return apkOnly(buildId);

            Set<String> paths = new HashSet<>(manifest.files.size() * 2);
            Map<String, File> files = new HashMap<>();
            String rootCanonical = null;
            if (root != null) {
                try {
                    rootCanonical = root.getCanonicalPath();
                } catch (IOException error) {
                    rootCanonical = null;
                }
            }

            for (UpdateManifest.FileEntry entry : manifest.files) {
                paths.add(entry.path);
                if (root == null || rootCanonical == null) continue;
                File file = new File(root, entry.path);
                if (!file.isFile()) continue;
                try {
                    String canonical = file.getCanonicalPath();
                    if (canonical.startsWith(rootCanonical + File.separator)) {
                        files.put(entry.path, file);
                    }
                } catch (IOException ignored) {
                    // 读不到路径就当作没有本地文件，由 AssetsPathHandler 兜底。
                }
            }

            return new Snapshot(buildId, true,
                    Collections.unmodifiableSet(paths),
                    Collections.unmodifiableMap(files), root);
        }

        String buildId() {
            return buildId;
        }

        boolean isAuthoritative() {
            return authoritative;
        }

        Set<String> paths() {
            return paths;
        }

        Map<String, File> files() {
            return files;
        }

        File buildRoot() {
            return buildRoot;
        }
    }

    private static final class Candidate {
        final UpdateManifest.Pointer pointer;
        final UpdateManifest.Manifest manifest;
        final UpdateInstaller.Plan plan;

        Candidate(UpdateManifest.Pointer pointer, UpdateManifest.Manifest manifest,
                  UpdateInstaller.Plan plan) {
            this.pointer = pointer;
            this.manifest = manifest;
            this.plan = plan;
        }
    }

    private static final String TAG = "InotiaUpdate";
    private static final int DOWNLOAD_THREADS = 3;
    private static volatile UpdateManager instance;

    static UpdateManager get(Context context) {
        UpdateManager current = instance;
        if (current == null) {
            synchronized (UpdateManager.class) {
                current = instance;
                if (current == null) {
                    current = new UpdateManager(context.getApplicationContext());
                    instance = current;
                }
            }
        }
        return current;
    }

    private final Context context;
    private final UpdateState state;
    private final UpdateInstaller installer;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean checkStarted = new AtomicBoolean(false);

    private volatile Snapshot snapshot = Snapshot.apkOnly("apk");
    private volatile UpdateManifest.Pointer baselinePointer;
    private volatile UpdateManifest.Manifest baselineManifest;
    private volatile UpdateManifest.Manifest activeManifest;
    private volatile String installedBuiltAt = "";
    private volatile Listener listener;
    private volatile Candidate candidate;

    private final Object initLock = new Object();
    private boolean initialized;
    private boolean initializing;
    private final List<Runnable> initCallbacks = new ArrayList<>();

    private final Object downloadLock = new Object();
    private boolean downloading;
    private volatile boolean downloadCancelled;

    private final Object bootLock = new Object();
    private boolean pendingBoot;
    private boolean bootOk;
    private boolean bootFailureHandled;
    private String pendingBuildId = "";

    private UpdateManager(Context context) {
        this.context = context;
        this.state = new UpdateState(context);
        this.installer = new UpdateInstaller(state);
    }

    /** 读完当前版本清单、发布不可变快照后才回调，回调在主线程。 */
    void initialize(Runnable onReady) {
        synchronized (initLock) {
            if (initialized) {
                mainHandler.post(onReady);
                return;
            }
            initCallbacks.add(onReady);
            if (initializing) return;
            initializing = true;
        }

        worker.execute(() -> {
            try {
                loadSnapshot();
            } catch (Exception error) {
                Log.w(TAG, "初始化版本快照失败，降级为 APK 资源", error);
                snapshot = Snapshot.apkOnly("apk");
            }

            List<Runnable> callbacks;
            synchronized (initLock) {
                initialized = true;
                initializing = false;
                callbacks = new ArrayList<>(initCallbacks);
                initCallbacks.clear();
            }
            mainHandler.post(() -> {
                for (Runnable callback : callbacks) callback.run();
            });
        });
    }

    Snapshot snapshot() {
        return snapshot;
    }

    String currentBuildId() {
        return snapshot.buildId();
    }

    void setListener(Listener listener) {
        this.listener = listener;
    }

    void clearListener(Listener listener) {
        if (this.listener == listener) this.listener = null;
    }

    /**
     * 每个进程只检查一次。debug 包跳过：它指向 Vite 开发服务，没有 /update 目录。
     * 检查失败只记日志，玩家照常用当前版本进游戏。
     */
    void checkForUpdate() {
        if (BuildConfig.DEBUG) {
            Log.i(TAG, "debug 包跳过热更检查");
            return;
        }
        if (!checkStarted.compareAndSet(false, true)) return;
        if (BuildConfig.UPDATE_PUBLIC_KEY.isEmpty()) {
            Log.w(TAG, "缺少更新公钥，跳过热更检查");
            return;
        }
        worker.execute(this::runUpdateCheck);
    }

    private void runUpdateCheck() {
        try {
            String pointerPath = "staging".equals(BuildConfig.UPDATE_CHANNEL)
                    ? "/update/latest-staging.json"
                    : "/update/latest.json";
            UpdateHttp http = new UpdateHttp(BuildConfig.UPDATE_BASE_URL);

            // 指针本身也要验签：否则旧指针可以被重放。
            byte[] pointerBytes = http.fetchPointer(pointerPath);
            byte[] pointerSignature = http.fetchSignature(pointerPath + ".sig");
            if (!UpdateManifest.verifySignature(
                    pointerBytes, pointerSignature, BuildConfig.UPDATE_PUBLIC_KEY)) {
                Log.w(TAG, "指针签名校验失败");
                return;
            }
            UpdateManifest.Pointer pointer = UpdateManifest.parsePointer(pointerBytes);

            if (pointer.buildId.equals(snapshot.buildId())) return;
            if (pointer.buildId.equals(state.failedBuildId())) {
                Log.i(TAG, "该版本曾启动失败，不再提示: " + pointer.buildId);
                return;
            }
            if (pointer.minShell > BuildConfig.SHELL_VERSION) {
                Log.i(TAG, "新版本需要更高的壳版本: minShell=" + pointer.minShell);
                return;
            }
            long installed = UpdateState.parseMillis(installedBuiltAt);
            if (installed != Long.MIN_VALUE && pointer.builtAtMillis <= installed) {
                Log.i(TAG, "更新指针不比已安装版本新");
                return;
            }

            // 清单先验原始字节的 SHA-256，再验签名和 buildId。
            byte[] manifestBytes = http.fetchManifest("/" + pointer.manifest);
            if (!pointer.manifestSha256.equals(UpdateManifest.sha256Hex(manifestBytes))) {
                Log.w(TAG, "清单哈希与指针不一致");
                return;
            }
            UpdateManifest.Manifest manifest = UpdateManifest.parseManifest(manifestBytes);
            if (!manifest.buildId.equals(pointer.buildId)) {
                Log.w(TAG, "清单 buildId 与指针不一致");
                return;
            }
            byte[] manifestSignature =
                    http.fetchSignature("/" + pointer.manifest + ".sig");
            if (!UpdateManifest.verifySignature(
                    manifestBytes, manifestSignature, BuildConfig.UPDATE_PUBLIC_KEY)) {
                Log.w(TAG, "清单签名校验失败");
                return;
            }

            UpdateInstaller.Plan plan = installer.prepare(
                    manifest, baselineManifest, activeManifest,
                    manifestBytes, pointer.builtAt);
            installer.requireSpace(plan);

            candidate = new Candidate(pointer, manifest, plan);
            int fileCount = plan.downloadCount();
            long bytes = plan.downloadBytes;
            postToMain(() -> {
                Listener current = listener;
                if (current != null) current.onUpdateAvailable(fileCount, bytes);
            });
        } catch (Exception error) {
            Log.w(TAG, "检查更新失败: " + error.getClass().getSimpleName()
                    + " " + error.getMessage());
        }
    }

    /** 玩家点了「立即更新」：后台开 3 个线程下载，全部成功后切换版本。 */
    void startDownload() {
        Candidate ready = candidate;
        if (ready == null) return;
        synchronized (downloadLock) {
            if (downloading) return;
            downloading = true;
            downloadCancelled = false;
        }
        worker.execute(() -> runDownload(ready));
    }

    void cancelDownload() {
        synchronized (downloadLock) {
            if (!downloading) return;
            downloadCancelled = true;
        }
    }

    private void runDownload(Candidate ready) {
        try {
            installer.requireSpace(ready.plan);
        } catch (Exception error) {
            finishDownload();
            notifyFailed(error.getMessage(), false);
            return;
        }

        List<UpdateManifest.FileEntry> downloads = ready.plan.downloads;
        int total = downloads.size();
        if (total == 0) {
            finalizeInstall(ready);
            return;
        }

        UpdateHttp http;
        try {
            http = new UpdateHttp(BuildConfig.UPDATE_BASE_URL);
        } catch (Exception error) {
            finishDownload();
            notifyFailed(error.getMessage(), false);
            return;
        }

        ExecutorService pool = Executors.newFixedThreadPool(DOWNLOAD_THREADS);
        CountDownLatch latch = new CountDownLatch(DOWNLOAD_THREADS);
        AtomicInteger next = new AtomicInteger(0);
        AtomicInteger completed = new AtomicInteger(0);
        AtomicBoolean failed = new AtomicBoolean(false);
        AtomicReference<String> failure = new AtomicReference<>("下载失败");

        Runnable task = () -> {
            try {
                while (!downloadCancelled && !failed.get()) {
                    int index = next.getAndIncrement();
                    if (index >= downloads.size()) return;
                    UpdateManifest.FileEntry entry = downloads.get(index);
                    try {
                        installer.downloadEntry(ready.plan, entry, http,
                                () -> downloadCancelled);
                        int done = completed.incrementAndGet();
                        postToMain(() -> {
                            Listener current = listener;
                            if (current != null) current.onDownloadProgress(done, total);
                        });
                    } catch (Exception error) {
                        if (!downloadCancelled) {
                            failure.compareAndSet("下载失败", error.getMessage());
                            failed.set(true);
                        }
                        return;
                    }
                }
            } finally {
                latch.countDown();
            }
        };
        for (int index = 0; index < DOWNLOAD_THREADS; index++) pool.execute(task);

        try {
            latch.await();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            failed.set(true);
        } finally {
            pool.shutdownNow();
        }

        if (downloadCancelled) {
            finishDownload();
            Log.i(TAG, "下载已取消，保留 staging 供下次续传");
            notifyFailed("cancelled", true);
            return;
        }
        if (failed.get()) {
            finishDownload();
            notifyFailed(failure.get(), false);
            return;
        }
        finalizeInstall(ready);
    }

    private void finalizeInstall(Candidate ready) {
        try {
            installer.complete(ready.plan, ready.pointer.builtAt, BuildConfig.UPDATE_CHANNEL);
            // 新版本已经切换，重建快照后才能加载它。
            loadSnapshot();
            synchronized (bootLock) {
                pendingBoot = true;
                bootOk = false;
                bootFailureHandled = false;
                pendingBuildId = ready.manifest.buildId;
            }
            candidate = null;
            finishDownload();
            String buildId = ready.manifest.buildId;
            postToMain(() -> {
                Listener current = listener;
                if (current != null) current.onUpdateApplied(buildId);
            });
        } catch (Exception error) {
            finishDownload();
            notifyFailed(error.getMessage(), false);
        }
    }

    private void finishDownload() {
        synchronized (downloadLock) {
            downloading = false;
            downloadCancelled = false;
        }
    }

    private void notifyFailed(String reason, boolean cancelled) {
        Log.w(TAG, "更新未完成: " + reason);
        postToMain(() -> {
            Listener current = listener;
            if (current != null) current.onUpdateFailed(reason, cancelled);
        });
    }

    /** 网页标题页加载完成后调用；收到后本次启动就算提交，不再回退。 */
    void markBootOk() {
        final String buildId;
        synchronized (bootLock) {
            if (!pendingBoot || bootOk || bootFailureHandled) return;
            bootOk = true;
            pendingBoot = false;
            buildId = pendingBuildId;
        }
        postToMain(() -> {
            Listener current = listener;
            if (current != null) current.onBootCommitted();
        });

        // 清理旧版本目录是磁盘操作，不能占用调用 markBootOk 的 JS 线程。
        worker.execute(() -> {
            String previous = state.previous();
            state.clearPrevious();
            if (!previous.isEmpty() && !previous.equals(buildId)) {
                UpdateState.deleteRecursively(state.buildDir(previous));
                UpdateState.deleteRecursively(state.stagingDir(previous));
            }
        });
    }

    boolean isBooting() {
        synchronized (bootLock) {
            return pendingBoot && !bootOk && !bootFailureHandled;
        }
    }

    /**
     * 渲染进程崩溃时的边界：只有「等待新版本启动完成」期间才回退；正常游玩时
     * 返回 false，由 Activity 只重建 WebView。
     */
    boolean onRenderProcessGone() {
        synchronized (bootLock) {
            if (!pendingBoot || bootOk || bootFailureHandled) return false;
            bootFailureHandled = true;
            pendingBoot = false;
        }
        worker.execute(() -> rollback("render-process"));
        return true;
    }

    void onBootTimeout() {
        synchronized (bootLock) {
            if (!pendingBoot || bootOk || bootFailureHandled) return;
            bootFailureHandled = true;
            pendingBoot = false;
        }
        worker.execute(() -> rollback("timeout"));
    }

    private void rollback(String reason) {
        final String failed;
        synchronized (bootLock) {
            failed = pendingBuildId;
        }
        Log.w(TAG, "新版本启动失败(" + reason + ")，回退: " + failed);

        try {
            String previous = state.previous();
            boolean usable = state.isUsable(previous);
            if (usable) {
                String previousBuiltAt = state.readBuiltAt(previous);
                state.rollbackTo(previous);
                if (!previousBuiltAt.isEmpty()) {
                    state.commitActive(previous, "", previousBuiltAt, state.activeChannel());
                }
            } else {
                state.clearActive();
            }

            if (!failed.isEmpty() && !failed.equals(previous)) {
                state.setFailedBuildId(failed);
                UpdateState.deleteRecursively(state.buildDir(failed));
                UpdateState.deleteRecursively(state.stagingDir(failed));
            } else if (!failed.isEmpty()) {
                state.setFailedBuildId(failed);
            }

            loadSnapshot();
            state.cleanupBuilds(state.active(), state.previous());
        } catch (Exception error) {
            Log.e(TAG, "回退时磁盘操作失败", error);
        }

        postToMain(() -> {
            Listener current = listener;
            if (current != null) current.onRollbackComplete(failed);
        });
    }

    /** 不碰磁盘，只读内存状态；给 InotiaNative.buildInfo() 用。 */
    String buildInfoJson() {
        try {
            JSONObject json = new JSONObject();
            json.put("version", 1);
            json.put("shellVersion", BuildConfig.SHELL_VERSION);
            json.put("channel", BuildConfig.UPDATE_CHANNEL);
            json.put("buildId", snapshot.buildId());
            json.put("active", state.active());
            json.put("previous", state.previous());
            json.put("failedBuildId", state.failedBuildId());
            json.put("builtAt", installedBuiltAt);
            json.put("pendingBoot", isBooting());
            return json.toString();
        } catch (JSONException error) {
            return "{}";
        }
    }

    /**
     * 读当前版本清单并发布快照。active 不完整时回 APK 基线；基线也读不出来时
     * 标记为不可信快照，PathHandler 会全部交给 AssetsPathHandler。
     */
    private void loadSnapshot() {
        try {
            state.ensureDirs();
        } catch (IOException error) {
            Log.w(TAG, "更新目录初始化失败", error);
        }

        UpdateManifest.Pointer basePointer = null;
        UpdateManifest.Manifest baseManifest = null;
        try {
            byte[] latest = readAsset("update/latest.json");
            if (latest != null) {
                UpdateManifest.Pointer pointer = UpdateManifest.parsePointer(latest);
                byte[] manifestBytes = readAsset(pointer.manifest);
                if (manifestBytes != null) {
                    UpdateManifest.Manifest manifest =
                            UpdateManifest.parseManifest(manifestBytes);
                    if (manifest.buildId.equals(pointer.buildId)) {
                        basePointer = pointer;
                        baseManifest = manifest;
                    } else {
                        Log.w(TAG, "APK 基线清单 buildId 与指针不一致");
                    }
                }
            }
        } catch (Exception error) {
            Log.w(TAG, "读取 APK 基线失败", error);
        }
        baselinePointer = basePointer;
        baselineManifest = baseManifest;

        String activeId = state.active();
        if (!activeId.isEmpty() && !state.isUsable(activeId)) {
            Log.w(TAG, "本地 active 不完整，回到 APK 资源: " + activeId);
            state.clearActive();
            activeId = "";
        }
        if (!activeId.isEmpty() && basePointer != null) {
            state.discardActiveIfBaselineNewer(basePointer.builtAtMillis);
            activeId = state.active();
        }

        UpdateManifest.Manifest chosen = null;
        UpdateManifest.Manifest chosenActive = null;
        File root = null;
        String buildId = "apk";
        String builtAt = "";

        if (!activeId.isEmpty()) {
            try {
                byte[] manifestBytes = readFile(state.manifestCopy(activeId));
                UpdateManifest.Manifest manifest =
                        UpdateManifest.parseManifest(manifestBytes);
                if (!manifest.buildId.equals(activeId)) {
                    throw new IOException("active 清单 buildId 不一致");
                }
                chosen = manifest;
                chosenActive = manifest;
                root = state.buildDir(activeId);
                buildId = activeId;
                builtAt = state.activeBuiltAt();
            } catch (Exception error) {
                Log.w(TAG, "active 清单损坏，回到 APK 资源: " + activeId, error);
                UpdateState.deleteRecursively(state.buildDir(activeId));
                state.clearActive();
            }
        }

        if (chosen == null && baseManifest != null) {
            chosen = baseManifest;
            buildId = basePointer.buildId;
            builtAt = basePointer.builtAt;
        }

        activeManifest = chosenActive;
        installedBuiltAt = builtAt;
        snapshot = Snapshot.build(buildId, chosen, root);
        state.cleanupBuilds(state.active(), state.previous());
        Log.i(TAG, "当前版本 buildId=" + buildId
                + "，来源=" + (root == null ? "APK 资源" : root.getName()));
    }

    private byte[] readAsset(String path) throws IOException {
        try (InputStream input = context.getAssets().open(path)) {
            return readAll(input);
        }
    }

    private static byte[] readFile(File file) throws IOException {
        try (InputStream input = new FileInputStream(file)) {
            return readAll(input);
        }
    }

    private static byte[] readAll(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        return output.toByteArray();
    }

    private void postToMain(Runnable action) {
        mainHandler.post(action);
    }
}
