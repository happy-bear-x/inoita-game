#!/usr/bin/env node
/**
 * 把 story-game/dist 打进一个离线 APK。
 *
 * 用法：
 *   node tools/build-apk.mjs              先构建网页产物，再打包
 *   node tools/build-apk.mjs --skip-web   复用现有 dist/，只重新打包 Android 壳
 *   node tools/build-apk.mjs --channel staging   打自测包，读取 latest-staging.json
 *
 * 工具链装在用户目录（默认 ~/.local/android-sdk），首次运行会自动下载
 * cmdline-tools、Android 34 平台和 build-tools；签名 keystore 只生成一次，
 * 保存在仓库外，重新打包用同一把钥匙，覆盖安装不会丢存档。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureUpdateKey } from './update-key.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(root, 'android');
const apkOut = path.join(root, 'apk-out');
const home = os.homedir();
const sdk = path.resolve(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(home, '.local/android-sdk'));
const javaHome = resolveJavaHome();
const skipWeb = process.argv.includes('--skip-web');

const BUILD_TOOLS = '34.0.0';
const PLATFORM = 'android-34';
const CMDLINE_TOOLS_URL = 'https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip';
const GRADLE_URL = 'https://services.gradle.org/distributions/gradle-8.7-bin.zip';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? `\n${result.stdout || ''}${result.stderr || ''}` : '';
    throw new Error(`命令失败（${result.status}）：${command} ${args.join(' ')}${detail}`);
  }
  return result;
}

function output(command, args, options = {}) {
  return (run(command, args, { ...options, capture: true }).stdout || '').trim();
}

function resolveJavaHome() {
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin/java'))) {
    return process.env.JAVA_HOME;
  }
  const javac = output('bash', ['-c', 'command -v javac']).split('\n').filter(Boolean).pop() || '';
  if (javac) return path.resolve(path.dirname(javac), '..');
  throw new Error('找不到 JDK 17，请设置 JAVA_HOME');
}

function has(file) {
  return fs.existsSync(file);
}

function sdkReady() {
  return has(path.join(sdk, 'platforms', PLATFORM, 'android.jar'))
    && has(path.join(sdk, 'build-tools', BUILD_TOOLS, 'aapt2'))
    && has(path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'));
}

function installSdk() {
  const sdkmanager = path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
  if (!has(sdkmanager)) {
    console.log(`[apk] 安装 cmdline-tools 到 ${sdk}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inoita-sdk-'));
    const zip = path.join(tmp, 'cmdline-tools.zip');
    run('curl', ['-fL', '--retry', '3', '-o', zip, CMDLINE_TOOLS_URL]);
    fs.rmSync(path.join(sdk, 'cmdline-tools', 'latest'), { recursive: true, force: true });
    fs.rmSync(path.join(sdk, 'cmdline-tools', 'unpack'), { recursive: true, force: true });
    fs.mkdirSync(path.join(sdk, 'cmdline-tools', 'unpack'), { recursive: true });
    run('unzip', ['-q', zip, '-d', path.join(sdk, 'cmdline-tools', 'unpack')]);
    fs.renameSync(path.join(sdk, 'cmdline-tools', 'unpack', 'cmdline-tools'), path.join(sdk, 'cmdline-tools', 'latest'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('[apk] 接受 Android SDK 许可并安装 ' + PLATFORM + ' / build-tools ' + BUILD_TOOLS);
  const licenses = spawnSync(sdkmanager, ['--sdk_root=' + sdk, '--licenses'], {
    input: 'y\n'.repeat(64), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, JAVA_HOME: javaHome },
  });
  if (licenses.status !== 0 && !/already accepted/i.test(`${licenses.stdout}${licenses.stderr}`)) {
    throw new Error(`sdkmanager 许可失败：${licenses.stdout || ''}${licenses.stderr || ''}`);
  }
  run(sdkmanager, ['--sdk_root=' + sdk, 'platform-tools', 'platforms;' + PLATFORM, 'build-tools;' + BUILD_TOOLS], {
    env: { JAVA_HOME: javaHome },
  });
}

function ensureGradleWrapper() {
  const gradlew = path.join(androidDir, 'gradlew');
  if (has(gradlew)) {
    fs.chmodSync(gradlew, 0o755);
    return gradlew;
  }
  const gradle = path.join(home, '.local', 'gradle-8.7', 'bin', 'gradle');
  if (!has(gradle)) {
    console.log('[apk] 下载 Gradle 8.7');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inoita-gradle-'));
    const zip = path.join(tmp, 'gradle.zip');
    run('curl', ['-fL', '--retry', '3', '-o', zip, GRADLE_URL]);
    run('unzip', ['-q', zip, '-d', path.join(home, '.local')]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('[apk] 生成 Gradle wrapper');
  run(gradle, ['wrapper', '--gradle-version', '8.7', '--distribution-type', 'bin', '--no-daemon'], {
    cwd: androidDir, env: { JAVA_HOME: javaHome, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
  });
  fs.chmodSync(gradlew, 0o755);
  return gradlew;
}

function ensureKeystore() {
  const propertiesFile = path.join(androidDir, 'keystore.properties');
  if (has(propertiesFile)) return propertiesFile;

  console.log('[apk] 首次打包：生成 release keystore（保存在仓库外）');
  const keystoreDir = path.join(home, '.config', 'inoita');
  fs.mkdirSync(keystoreDir, { recursive: true });
  const keystore = path.join(keystoreDir, 'android-release.jks');
  const password = crypto.randomBytes(18).toString('base64url');
  if (!has(keystore)) {
    run('keytool', [
      '-genkeypair', '-noprompt',
      '-keystore', keystore,
      '-storepass', password,
      '-keypass', password,
      '-alias', 'inoita',
      '-keyalg', 'RSA',
      '-keysize', '2048',
      '-validity', '10000',
      '-dname', 'CN=Inotia 4, OU=Personal, O=Personal, L=Unknown, ST=Unknown, C=CN',
    ], { env: { JAVA_HOME: javaHome } });
    fs.chmodSync(keystore, 0o600);
  }
  fs.writeFileSync(propertiesFile, [
    `storeFile=${keystore}`,
    `storePassword=${password}`,
    'keyAlias=inoita',
    `keyPassword=${password}`,
    '',
  ].join('\n'));
  fs.chmodSync(propertiesFile, 0o600);
  console.log(`[apk] keystore: ${keystore}`);
  return propertiesFile;
}

function versionName() {
  const gradle = fs.readFileSync(path.join(androidDir, 'app', 'build.gradle'), 'utf8');
  const match = gradle.match(/versionName\s+'([^']+)'/);
  return match ? match[1] : '1.0.0';
}

function versionCode() {
  const gradle = fs.readFileSync(path.join(androidDir, 'app', 'build.gradle'), 'utf8');
  return gradle.match(/versionCode\s+(\d+)/)?.[1] ?? 'unknown';
}

function channelFromArgs() {
  let channel = 'stable';
  for (let index = 0; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (value === '--channel') channel = process.argv[++index] ?? '';
    else if (value.startsWith('--channel=')) channel = value.slice('--channel='.length);
  }
  if (channel !== 'stable' && channel !== 'staging')
    throw new Error(`--channel 只能是 stable 或 staging，收到：${channel || '(空)'}`);
  return channel;
}

/** APK 的 assets/update 直接来自 dist/update；缺签名就直接失败，别打出无法热更的包。 */
function checkUpdateArtifacts() {
  const updateDir = path.join(root, 'dist', 'update');
  const requireFile = name => {
    const file = path.join(updateDir, name);
    if (!has(file)) throw new Error(`dist/update/${name} 不存在；先运行 npm run update:key 和 npm run build`);
    return file;
  };
  for (const pointer of ['latest.json', 'latest-staging.json']) {
    requireFile(pointer);
    requireFile(`${pointer}.sig`);
  }
  const latest = JSON.parse(fs.readFileSync(requireFile('latest.json'), 'utf8'));
  if (typeof latest.buildId !== 'string' || !/^[0-9a-f]{16}$/.test(latest.buildId))
    throw new Error('dist/update/latest.json 的 buildId 无效');
  requireFile(`${latest.buildId}.json`);
  requireFile(`${latest.buildId}.json.sig`);
  const staging = JSON.parse(fs.readFileSync(requireFile('latest-staging.json'), 'utf8'));
  if (staging.buildId !== latest.buildId) throw new Error('latest 与 latest-staging 没有指向同一份清单');
  return latest.buildId;
}

function gitSummary() {
  const head = run('git', ['rev-parse', '--short', 'HEAD'], { allowFailure: true, capture: true }).stdout?.trim() || 'unknown';
  const dirty = run('git', ['status', '--porcelain'], { allowFailure: true, capture: true }).stdout?.trim();
  return dirty ? `${head}（工作区有未提交改动）` : head;
}

try {
  const channel = channelFromArgs();
  console.log(`[apk] SDK: ${sdk}`);
  console.log(`[apk] JDK: ${javaHome}`);
  if (!sdkReady()) installSdk();
  if (!sdkReady()) throw new Error('Android SDK 安装后仍缺少 platforms 或 build-tools');

  ensureKeystore();
  ensureUpdateKey();
  const gradlew = ensureGradleWrapper();

  if (!skipWeb) {
    console.log('[apk] 构建网页产物');
    run('npm', ['run', 'build'], { cwd: root });
  } else if (!has(path.join(root, 'dist', 'index.html'))) {
    throw new Error('dist/ 不存在，去掉 --skip-web 先构建网页产物');
  }
  const buildId = checkUpdateArtifacts();
  console.log(`[apk] 热更基线: ${buildId}（${channel}）`);

  console.log('[apk] Gradle assembleRelease');
  run(gradlew, [':app:assembleRelease', '--no-daemon', `-PupdateChannel=${channel}`], {
    cwd: androidDir,
    env: { JAVA_HOME: javaHome, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
  });

  const source = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  if (!has(source)) throw new Error('没有找到 app-release.apk');
  fs.mkdirSync(apkOut, { recursive: true });
  const target = path.join(apkOut, `Inotia-4-${versionName()}.apk`);
  fs.copyFileSync(source, target);

  const bytes = fs.statSync(target).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  console.log('');
  console.log('[apk] 完成');
  console.log(`  文件: ${target}`);
  console.log(`  大小: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  sha256: ${sha256}`);
  console.log(`  热更通道: ${channel}`);
  console.log(`  versionCode: ${versionCode()}（分发新 APK 前必须递增）`);
  console.log(`  源码: ${gitSummary()}`);
  console.log(`  安装: adb install -r "${target}"`);
} catch (error) {
  console.error(`[apk] 失败: ${error.message}`);
  process.exit(1);
}
