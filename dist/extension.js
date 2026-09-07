"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"));
var import_child_process2 = require("child_process");
var import_ws = require("ws");
var fs2 = __toESM(require("fs"));
var path2 = __toESM(require("path"));

// src/scrcpy.ts
var net = __toESM(require("net"));
var https = __toESM(require("https"));
var import_child_process = require("child_process");
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var SCRCPY_SERVER_VERSION = "2.4";
var SCRCPY_SERVER_URL = "https://github.com/Genymobile/scrcpy/releases/download/v" + SCRCPY_SERVER_VERSION + "/scrcpy-server-v" + SCRCPY_SERVER_VERSION;
var DEVICE_JAR = "/data/local/tmp/scrcpy-server.jar";
var SOCKET_NAME = "scrcpy";
var TYPE_INJECT_KEYCODE = 0;
var TYPE_INJECT_TOUCH_EVENT = 2;
var TOUCH_ACTIONS = { DOWN: 0, UP: 1, MOVE: 2, CANCEL: 3 };
var KEY_ACTION_DOWN = 0;
var KEY_ACTION_UP = 1;
function run(cmd, args, timeoutMs = 15e3) {
  return new Promise((resolve) => {
    const child = (0, import_child_process.spawn)(cmd, args, { shell: false });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code) => {
      if (!done) {
        done = true;
        clearTimeout(t);
        resolve({ code, stdout, stderr });
      }
    };
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", () => finish(127));
    child.on("exit", (code) => finish(code ?? 0));
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
      finish(124);
    }, timeoutMs);
  });
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}
function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      return reject(new Error("too many redirects"));
    }
    const req = https.get(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve(downloadFile(new URL(res.headers.location, url).toString(), dest, redirects + 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error("HTTP " + status));
        return;
      }
      const tmp = dest + ".tmp";
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on("finish", () => {
        out.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          try {
            const fd = fs.openSync(tmp, "r");
            const magic = Buffer.alloc(2);
            fs.readSync(fd, magic, 0, 2, 0);
            fs.closeSync(fd);
            if (magic.toString("ascii") !== "PK") {
              fs.unlinkSync(tmp);
              reject(new Error("downloaded file is not a jar"));
              return;
            }
            fs.renameSync(tmp, dest);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
      out.on("error", reject);
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}
function systemServerCandidates() {
  return [
    "/usr/share/scrcpy/scrcpy-server",
    // Fedora / Debian / Arch
    "/usr/local/share/scrcpy/scrcpy-server",
    // manual installs
    "/opt/homebrew/share/scrcpy/scrcpy-server",
    // macOS (Apple Silicon)
    "/usr/local/opt/scrcpy/share/scrcpy/scrcpy-server"
    // macOS (Intel)
  ];
}
async function getScrcpyServerJar(storageDir, log) {
  const cached = path.join(storageDir, "scrcpy-server-v" + SCRCPY_SERVER_VERSION);
  try {
    if (fs.existsSync(cached) && fs.statSync(cached).size > 1024) {
      return cached;
    }
  } catch {
  }
  const ver = await run("scrcpy", ["--version"], 5e3);
  const m = ver.stdout.match(/scrcpy\s+(\d+\.\d+)/);
  if (ver.code === 0 && m && m[1] === SCRCPY_SERVER_VERSION) {
    for (const cand of systemServerCandidates()) {
      try {
        if (fs.existsSync(cand) && fs.statSync(cand).size > 1024) {
          log("[scrcpy] using system server jar " + cand);
          return cand;
        }
      } catch {
      }
    }
  }
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    log("[scrcpy] downloading scrcpy-server v" + SCRCPY_SERVER_VERSION + " (one-time, cached for offline use) ...");
    await downloadFile(SCRCPY_SERVER_URL, cached);
    log("[scrcpy] server jar cached at " + cached);
    return cached;
  } catch (e) {
    log("[scrcpy] download failed: " + (e?.message ?? String(e)));
    try {
      fs.unlinkSync(cached + ".tmp");
    } catch {
    }
    return null;
  }
}
function connectWithRetry(port, what, log, timeoutMs = 15e3) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() > deadline) {
        reject(new Error("timeout connecting the " + what + " socket"));
        return;
      }
      const sock = net.connect(port, "127.0.0.1");
      const retry = (reason) => {
        clearTimeout(settled);
        sock.destroy();
        log("[scrcpy] " + what + " socket not ready yet (" + reason + "), retrying ...");
        setTimeout(attempt, 250);
      };
      const settled = setTimeout(() => {
        sock.removeListener("error", onError);
        sock.removeListener("close", onClose);
        resolve(sock);
      }, 400);
      const onError = (err) => retry(err.message);
      const onClose = () => retry("closed");
      sock.once("error", onError);
      sock.once("close", onClose);
    };
    attempt();
  });
}
function startScrcpySession(opts) {
  const { adbPath, serial, jarPath, log } = opts;
  const bitRate = opts.bitRate ?? 8e6;
  const maxFps = opts.maxFps ?? 60;
  return (async () => {
    const push = await run(adbPath, ["-s", serial, "push", jarPath, DEVICE_JAR], 3e4);
    if (push.code !== 0) {
      throw new Error("adb push failed: " + push.stderr.trim());
    }
    const port = await freePort();
    const fwd = await run(adbPath, ["-s", serial, "forward", "tcp:" + port, "localabstract:" + SOCKET_NAME], 5e3);
    if (fwd.code !== 0) {
      throw new Error("adb forward failed: " + fwd.stderr.trim());
    }
    const serverProcess = (0, import_child_process.spawn)(adbPath, [
      "-s",
      serial,
      "shell",
      "CLASSPATH=" + DEVICE_JAR,
      "app_process",
      "/",
      "com.genymobile.scrcpy.Server",
      SCRCPY_SERVER_VERSION,
      "log_level=info",
      "video=true",
      "audio=false",
      "control=true",
      "tunnel_forward=true",
      "raw_stream=true",
      "max_size=0",
      // native device resolution
      "video_bit_rate=" + bitRate,
      "max_fps=" + maxFps
    ]);
    serverProcess.stderr?.on("data", (d) => log("[scrcpy] " + d.toString().trim()));
    serverProcess.stdout?.on("data", (d) => {
      const s = d.toString().trim();
      if (s) {
        log("[scrcpy:server] " + s);
      }
    });
    serverProcess.on("error", (err) => log("[scrcpy] spawn error: " + err.message));
    let videoSocket;
    let controlSocket;
    try {
      videoSocket = await connectWithRetry(port, "video", log);
      controlSocket = await connectWithRetry(port, "control", log);
    } catch (e) {
      serverProcess.kill();
      await run(adbPath, ["-s", serial, "forward", "--remove", "tcp:" + port], 5e3);
      throw e instanceof Error ? e : new Error(String(e));
    }
    log("[scrcpy] session up (video+control on port " + port + ")");
    let stopped = false;
    let exited = false;
    const videoCbs = [];
    const controlCbs = [];
    const exitCbs = [];
    const cleanup = () => {
      if (exited) {
        return;
      }
      exited = true;
      try {
        videoSocket.destroy();
      } catch {
      }
      try {
        controlSocket.destroy();
      } catch {
      }
      run(adbPath, ["-s", serial, "forward", "--remove", "tcp:" + port], 5e3);
      for (const cb of exitCbs) {
        cb();
      }
    };
    videoSocket.on("data", (chunk) => {
      for (const cb of videoCbs) {
        cb(chunk);
      }
    });
    controlSocket.on("data", (chunk) => {
      for (const cb of controlCbs) {
        cb(chunk);
      }
    });
    videoSocket.on("error", () => {
    });
    controlSocket.on("error", () => {
    });
    videoSocket.on("close", cleanup);
    serverProcess.on("exit", (code) => {
      log("[scrcpy] server exited code=" + code);
      cleanup();
    });
    const writeControl = (buf) => {
      if (!stopped && controlSocket.writable) {
        try {
          controlSocket.write(buf);
        } catch {
        }
      }
    };
    return {
      serverProcess,
      onVideoData: (cb) => {
        videoCbs.push(cb);
      },
      onControlData: (cb) => {
        controlCbs.push(cb);
      },
      onExit: (cb) => {
        exitCbs.push(cb);
      },
      sendRaw(buf) {
        writeControl(buf);
      },
      sendTouch(action, x, y, screenWidth, screenHeight) {
        const code = TOUCH_ACTIONS[action.toUpperCase()];
        if (code === void 0 || screenWidth <= 0 || screenHeight <= 0) {
          return;
        }
        const buf = Buffer.alloc(32);
        buf.writeUInt8(TYPE_INJECT_TOUCH_EVENT, 0);
        buf.writeUInt8(code, 1);
        buf.writeBigInt64BE(-2n, 2);
        buf.writeInt32BE(Math.round(x), 10);
        buf.writeInt32BE(Math.round(y), 14);
        buf.writeUInt16BE(Math.min(65535, screenWidth), 18);
        buf.writeUInt16BE(Math.min(65535, screenHeight), 20);
        buf.writeUInt16BE(code === TOUCH_ACTIONS.UP ? 0 : 65535, 22);
        buf.writeInt32BE(0, 24);
        buf.writeInt32BE(code === TOUCH_ACTIONS.UP ? 0 : 1, 28);
        writeControl(buf);
      },
      sendKey(keycode) {
        const down = Buffer.alloc(14);
        down.writeUInt8(TYPE_INJECT_KEYCODE, 0);
        down.writeUInt8(KEY_ACTION_DOWN, 1);
        down.writeInt32BE(keycode, 2);
        down.writeInt32BE(0, 6);
        down.writeInt32BE(0, 10);
        const up = Buffer.alloc(14);
        up.writeUInt8(TYPE_INJECT_KEYCODE, 0);
        up.writeUInt8(KEY_ACTION_UP, 1);
        up.writeInt32BE(keycode, 2);
        up.writeInt32BE(0, 6);
        up.writeInt32BE(0, 10);
        writeControl(down);
        writeControl(up);
      },
      stop() {
        if (stopped) {
          return;
        }
        stopped = true;
        try {
          serverProcess.kill();
        } catch {
        }
        try {
          videoSocket.destroy();
        } catch {
        }
        try {
          controlSocket.destroy();
        } catch {
        }
        run(adbPath, ["-s", serial, "forward", "--remove", "tcp:" + port], 5e3);
      }
    };
  })();
}

// src/extension.ts
var WS_PORT = 9225;
var outputChannel = vscode.window.createOutputChannel("android-emu");
var spawnedEmulators = [];
var activeRecordProcess = null;
var activeScrcpySession = null;
var activeInputShell = null;
var activeWss = null;
var activeSocket = null;
var rotateScreenFn = null;
process.on("exit", () => {
  for (const child of spawnedEmulators) {
    killProcessGroup(child);
  }
});
function activate(context) {
  context.subscriptions.push(outputChannel);
  const disposable = vscode.commands.registerCommand("android-emu.start", async () => {
    const emu = await ensureEmulator();
    if (!emu) {
      return;
    }
    startMirror(context, emu.serial, emu.adbPath);
  });
  context.subscriptions.push(disposable);
  const screenshotCmd = vscode.commands.registerCommand("android-emu.screenshot", () => {
    if (!activeSocket || activeSocket.readyState !== import_ws.WebSocket.OPEN) {
      vscode.window.showErrorMessage("android-emu: No active mirror session. Start the emulator first.");
      return;
    }
    activeSocket.send(JSON.stringify({ type: "screenshot" }));
    outputChannel.appendLine("[screenshot] requested");
  });
  context.subscriptions.push(screenshotCmd);
  const rotateLandscapeCmd = vscode.commands.registerCommand("android-emu.rotateLandscape", () => {
    if (rotateScreenFn) {
      rotateScreenFn("landscape");
    } else {
      vscode.window.showErrorMessage("android-emu: No active mirror session. Start the emulator first.");
    }
  });
  context.subscriptions.push(rotateLandscapeCmd);
  const rotatePortraitCmd = vscode.commands.registerCommand("android-emu.rotatePortrait", () => {
    if (rotateScreenFn) {
      rotateScreenFn("portrait");
    } else {
      vscode.window.showErrorMessage("android-emu: No active mirror session. Start the emulator first.");
    }
  });
  context.subscriptions.push(rotatePortraitCmd);
  const startExpoGoCmd = vscode.commands.registerCommand("android-emu.startExpoGo", async () => {
    const folder = findExpoWorkspace();
    if (!folder) {
      return;
    }
    if (!await commandExists("npx", ["--version"])) {
      vscode.window.showErrorMessage("android-emu: npx not found on PATH. Install Node.js (LTS) first.");
      return;
    }
    const emu = await ensureBootedEmulator(context);
    if (!emu) {
      return;
    }
    if (!await isPackageInstalled(emu.adbPath, emu.serial, "host.exp.exponent")) {
      vscode.window.showWarningMessage('android-emu: Expo Go is not installed on the emulator. Install it from the Play Store inside the emulator, then press "a" in the Expo terminal.');
    }
    outputChannel.appendLine("[expo] starting Expo dev server (Expo Go) in " + folder.uri.fsPath);
    runInTerminal("android-emu: Expo Go", folder.uri.fsPath, "npx expo start --android");
  });
  context.subscriptions.push(startExpoGoCmd);
  const startExpoNativeCmd = vscode.commands.registerCommand("android-emu.startExpoNative", async () => {
    const folder = findExpoWorkspace();
    if (!folder) {
      return;
    }
    if (!await commandExists("npx", ["--version"])) {
      vscode.window.showErrorMessage("android-emu: npx not found on PATH. Install Node.js (LTS) first.");
      return;
    }
    const emu = await ensureBootedEmulator(context);
    if (!emu) {
      return;
    }
    outputChannel.appendLine("[expo] building + installing the native binary (expo run:android) in " + folder.uri.fsPath);
    vscode.window.showInformationMessage("android-emu: Building the native binary with Gradle. The first build can take several minutes.");
    runInTerminal("android-emu: Expo Native", folder.uri.fsPath, "npx expo run:android");
  });
  context.subscriptions.push(startExpoNativeCmd);
}
function deactivate() {
  rotateScreenFn = null;
  try {
    activeScrcpySession?.stop();
  } catch {
  }
  activeScrcpySession = null;
  try {
    activeRecordProcess?.kill();
  } catch {
  }
  try {
    activeInputShell?.kill();
  } catch {
  }
  try {
    activeWss?.close();
  } catch {
  }
  for (const child of spawnedEmulators) {
    killProcessGroup(child);
  }
}
async function runDoctor() {
  const failures = [];
  let emulatorPath = "";
  let adbPath = "adb";
  const androidHome = process.env.ANDROID_HOME;
  if (!androidHome) {
    failures.push("ANDROID_HOME is not set.");
  } else if (!fs2.existsSync(androidHome)) {
    failures.push("ANDROID_HOME does not exist: " + androidHome);
  } else {
    emulatorPath = path2.join(androidHome, "emulator", "emulator");
    if (!fs2.existsSync(emulatorPath)) {
      failures.push("Emulator CLI not found at " + emulatorPath);
    } else {
      const r = await runCommand(emulatorPath, ["-list-avds"], 1e4);
      if (r.code !== 0) {
        failures.push('Emulator CLI did not run ("' + emulatorPath + ' -list-avds" failed).');
      }
    }
    const adbFull = path2.join(androidHome, "platform-tools", "adb");
    if (fs2.existsSync(adbFull)) {
      adbPath = adbFull;
    } else if (!await commandExists("adb", ["version"])) {
      failures.push("adb not found (neither $ANDROID_HOME/platform-tools/adb nor adb on PATH).");
    }
  }
  if (!await commandExists("scrcpy", ["--version"])) {
    failures.push('scrcpy not found on PATH ("scrcpy --version" failed).');
  }
  return { ok: failures.length === 0, report: failures.join("\n"), emulatorPath, adbPath };
}
async function listAvds(emulatorPath) {
  const r = await runCommand(emulatorPath, ["-list-avds"], 1e4);
  if (r.code !== 0) {
    return [];
  }
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}
async function getRunningEmulatorSerial(adbPath) {
  const r = await runCommand(adbPath, ["devices"], 5e3);
  if (r.code !== 0) {
    return null;
  }
  const lines = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("List of devices")) {
      continue;
    }
    const m = line.match(/^(emulator-\d+)\s+device\b/);
    if (m) {
      return m[1];
    }
  }
  return null;
}
async function waitForEmulatorSerial(adbPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await getRunningEmulatorSerial(adbPath);
    if (s) {
      return s;
    }
    await new Promise((r) => setTimeout(r, 2e3));
  }
  return null;
}
async function ensureEmulator() {
  const doctor = await runDoctor();
  if (!doctor.ok) {
    outputChannel.appendLine("[doctor] failed:\n" + doctor.report);
    vscode.window.showErrorMessage('android-emu doctor failed. See the "android-emu" output channel for details.');
    outputChannel.show(true);
    return null;
  }
  outputChannel.appendLine("[doctor] OK: scrcpy, emulator CLI, and Android SDK (ANDROID_HOME) all present.");
  let serial = await getRunningEmulatorSerial(doctor.adbPath);
  if (serial) {
    outputChannel.appendLine("[emu] using running emulator " + serial);
    vscode.window.showInformationMessage("android-emu: Using running emulator " + serial);
  } else {
    const avds = await listAvds(doctor.emulatorPath);
    if (avds.length === 0) {
      vscode.window.showErrorMessage("android-emu: No AVDs found. Create one with avdmanager first.");
      return null;
    }
    const picked = await vscode.window.showQuickPick(avds, { placeHolder: "Select an AVD to launch headless" });
    if (!picked) {
      return null;
    }
    outputChannel.appendLine("[emu] launching " + picked + " headless ...");
    const started = await launchEmulatorHeadless(doctor.emulatorPath, picked);
    if (!started) {
      vscode.window.showErrorMessage("android-emu: Failed to start the emulator process.");
      return null;
    }
    spawnedEmulators.push(started);
    serial = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "android-emu: Booting " + picked + " (headless) ..." },
      () => waitForEmulatorSerial(doctor.adbPath, 12e4)
    );
    if (!serial) {
      vscode.window.showErrorMessage("android-emu: Emulator did not come online within 120s.");
      return null;
    }
    outputChannel.appendLine("[emu] " + picked + " online as " + serial);
  }
  return { serial, adbPath: doctor.adbPath };
}
async function ensureBootedEmulator(context) {
  const emu = await ensureEmulator();
  if (!emu) {
    return null;
  }
  const booted = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "android-emu: Waiting for the emulator to finish booting ..." },
    () => waitForBootComplete(emu.adbPath, emu.serial, 18e4)
  );
  if (!booted) {
    vscode.window.showWarningMessage("android-emu: Emulator did not finish booting within 180s; the app may not open immediately.");
  }
  if (!activeWss) {
    startMirror(context, emu.serial, emu.adbPath);
  }
  return emu;
}
async function waitForBootComplete(adbPath, serial, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await runCommand(adbPath, ["-s", serial, "shell", "getprop", "sys.boot_completed"], 5e3);
    if (r.stdout.trim() === "1") {
      return true;
    }
    await new Promise((res) => setTimeout(res, 2e3));
  }
  return false;
}
async function isPackageInstalled(adbPath, serial, pkg) {
  const r = await runCommand(adbPath, ["-s", serial, "shell", "pm", "list", "packages", pkg], 1e4);
  return r.code === 0 && r.stdout.includes("package:" + pkg);
}
function launchEmulatorHeadless(emulatorPath, avd) {
  return new Promise((resolve) => {
    const child = (0, import_child_process2.spawn)(emulatorPath, [
      "-avd",
      avd,
      "-no-window",
      "-no-audio",
      "-gpu",
      "swangle",
      "-feature",
      "-Vulkan",
      "-no-boot-anim",
      "-no-snapshot-load",
      "-camera-back",
      "none",
      "-camera-front",
      "none"
    ], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    child.on("error", (err) => {
      outputChannel.appendLine("[emu] spawn error: " + err.message);
      resolve(null);
    });
    setTimeout(() => resolve(child), 500);
  });
}
function startMirror(context, serial, adbPath) {
  const panel = vscode.window.createWebviewPanel(
    "androidMirror",
    "Android Emulator",
    vscode.ViewColumn.Two,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const wss = new import_ws.WebSocketServer({ port: WS_PORT });
  activeWss = wss;
  let stopped = false;
  let manualRestart = false;
  function startScreenRecord() {
    if (stopped) {
      return;
    }
    activeRecordProcess = (0, import_child_process2.spawn)(adbPath, ["-s", serial, "exec-out", "screenrecord", "--output-format=h264", "-"]);
    activeRecordProcess.stdout?.on("data", (chunk) => {
      if (activeSocket && activeSocket.readyState === import_ws.WebSocket.OPEN) {
        activeSocket.send(chunk, { binary: true });
      }
    });
    activeRecordProcess.stderr?.on("data", (d) => outputChannel.appendLine("[screenrecord] " + d.toString().trim()));
    activeRecordProcess.on("error", (err) => outputChannel.appendLine("[screenrecord] " + err.message));
    activeRecordProcess.on("exit", (code) => {
      outputChannel.appendLine("[screenrecord] exited code=" + code + " " + (stopped ? "(stopped)" : "(restarting)"));
      if (!stopped && !manualRestart) {
        setTimeout(startScreenRecord, 300);
      }
      manualRestart = false;
    });
  }
  function ensureInputShell() {
    if (activeInputShell && !activeInputShell.killed && activeInputShell.stdin && !activeInputShell.stdin.destroyed) {
      return activeInputShell;
    }
    activeInputShell = (0, import_child_process2.spawn)(adbPath, ["-s", serial, "shell"], { stdio: ["pipe", "pipe", "pipe"] });
    activeInputShell.stdin?.setDefaultEncoding("utf-8");
    activeInputShell.stdout?.on("data", () => {
    });
    activeInputShell.stderr?.on("data", (d) => outputChannel.appendLine("[input-shell] " + d.toString().trim()));
    activeInputShell.on("error", (err) => outputChannel.appendLine("[input-shell] " + err.message));
    activeInputShell.on("exit", (code) => {
      outputChannel.appendLine("[input-shell] exited code=" + code);
      activeInputShell = null;
    });
    return activeInputShell;
  }
  function sendInput(line) {
    const sh = ensureInputShell();
    if (sh?.stdin && !sh.stdin.destroyed) {
      sh.stdin.write(line + "\n");
    }
  }
  let primed = false;
  function primeDisplay() {
    if (primed || stopped) {
      return;
    }
    primed = true;
    setTimeout(() => {
      if (stopped) {
        return;
      }
      sendInput("cmd statusbar expand-notifications");
      setTimeout(() => {
        if (stopped) {
          return;
        }
        sendInput("cmd statusbar collapse");
      }, 450);
    }, 600);
  }
  const jarReady = getScrcpyServerJar(context.globalStorageUri.fsPath, (l) => outputChannel.appendLine(l));
  jarReady.then((j) => outputChannel.appendLine(j ? "[scrcpy] low-latency video source enabled (scrcpy-server v2.4)" : "[scrcpy] server jar unavailable - using legacy screenrecord pipeline"));
  let scrcpyBroken = false;
  async function startVideoSource() {
    if (stopped) {
      return;
    }
    const jar = scrcpyBroken ? null : await jarReady;
    if (stopped) {
      return;
    }
    if (jar) {
      startScrcpyVideo(jar);
    } else {
      startScreenRecord();
    }
  }
  function stopVideoSource() {
    if (activeScrcpySession) {
      manualRestart = true;
      activeScrcpySession.stop();
      activeScrcpySession = null;
    }
    if (activeRecordProcess) {
      manualRestart = true;
      activeRecordProcess.kill();
      activeRecordProcess = null;
    }
  }
  function startScrcpyVideo(jar) {
    startScrcpySession({
      adbPath,
      serial,
      jarPath: jar,
      log: (line) => outputChannel.appendLine(line)
    }).then((session) => {
      if (stopped) {
        session.stop();
        return;
      }
      activeScrcpySession = session;
      activeRecordProcess = session.serverProcess;
      let gotScrcpyVideo = false;
      session.onVideoData((chunk) => {
        if (!gotScrcpyVideo) {
          gotScrcpyVideo = true;
          outputChannel.appendLine("[scrcpy] video stream flowing");
        }
        if (activeSocket && activeSocket.readyState === import_ws.WebSocket.OPEN) {
          activeSocket.send(chunk, { binary: true });
        }
      });
      setTimeout(() => {
        if (!gotScrcpyVideo && !stopped && activeScrcpySession === session) {
          outputChannel.appendLine("[scrcpy] no video data within 6s - falling back to screenrecord");
          scrcpyBroken = true;
          stopVideoSource();
          void startVideoSource();
        }
      }, 6e3);
      session.onExit(() => {
        if (activeScrcpySession === session) {
          activeScrcpySession = null;
        }
        if (activeRecordProcess === session.serverProcess) {
          activeRecordProcess = null;
        }
        if (!stopped && !manualRestart) {
          setTimeout(() => {
            void startVideoSource();
          }, 300);
        }
        manualRestart = false;
      });
    }).catch((err) => {
      outputChannel.appendLine("[scrcpy] failed to start (" + (err?.message ?? err) + "); falling back to screenrecord");
      scrcpyBroken = true;
      startScreenRecord();
    });
  }
  (async () => {
    const physicalSize = await queryDeviceSize(adbPath, serial);
    if (physicalSize) {
      outputChannel.appendLine("[mirror] physical size: " + physicalSize.width + "x" + physicalSize.height);
    } else {
      outputChannel.appendLine("[mirror] could not query device size; falling back to stream metadata.");
    }
    ensureInputShell();
    let currentRotation = await queryRotation(adbPath, serial);
    outputChannel.appendLine("[mirror] current rotation: " + currentRotation);
    function rotatedSize(rot) {
      if (!physicalSize) {
        return { width: 0, height: 0 };
      }
      return rot % 2 === 1 ? { width: physicalSize.height, height: physicalSize.width } : { width: physicalSize.width, height: physicalSize.height };
    }
    sendInput("input keyevent 224");
    sendInput("wm dismiss-keyguard");
    sendInput("input keyevent 3");
    wss.on("connection", (ws) => {
      activeSocket = ws;
      outputChannel.appendLine("Webview canvas hooked into stream server.");
      {
        const sz = rotatedSize(currentRotation);
        if (sz.width) {
          ws.send(JSON.stringify({ type: "size", width: sz.width, height: sz.height }));
        }
      }
      stopVideoSource();
      primed = false;
      void startVideoSource();
      primeDisplay();
      ws.on("message", (message) => {
        let event;
        try {
          event = JSON.parse(message);
        } catch {
          return;
        }
        if (event.type === "touch" && typeof event.action === "string") {
          const action = String(event.action).toUpperCase();
          const x = Math.round(Number(event.x));
          const y = Math.round(Number(event.y));
          if (Number.isFinite(x) && Number.isFinite(y)) {
            if (activeScrcpySession) {
              const dw = Number(event.w);
              const dh = Number(event.h);
              const sz = Number.isFinite(dw) && dw > 0 && Number.isFinite(dh) && dh > 0 ? { width: Math.round(dw), height: Math.round(dh) } : rotatedSize(currentRotation);
              if (sz.width > 0 && sz.height > 0) {
                activeScrcpySession.sendTouch(action, x, y, sz.width, sz.height);
              } else {
                sendInput("input motionevent " + action + " " + x + " " + y);
              }
            } else {
              sendInput("input motionevent " + action + " " + x + " " + y);
            }
          }
        } else if (event.type === "key") {
          if (event.action === "text" && typeof event.char === "string") {
            const escaped = event.char.replace(/'/g, "'\\''");
            sendInput("input text '" + escaped + "'");
          } else if (event.action === "keyevent" && typeof event.code === "number") {
            if (activeScrcpySession) {
              activeScrcpySession.sendKey(event.code);
            } else {
              sendInput("input keyevent " + event.code);
            }
          }
        } else if (event.type === "screenshot-data" && typeof event.data === "string") {
          writeScreenshot(event.data).catch((e) => outputChannel.appendLine("[screenshot] error: " + e));
        }
      });
      ws.on("close", () => {
        if (activeSocket === ws) {
          activeSocket = null;
        }
      });
    });
    rotateScreenFn = async (orientation) => {
      if (stopped || !physicalSize) {
        return;
      }
      const evenIsLandscape = physicalSize.width >= physicalSize.height;
      const isLandscape = currentRotation % 2 === 0 === evenIsLandscape;
      const alreadyThere = orientation === "landscape" && isLandscape || orientation === "portrait" && !isLandscape;
      if (alreadyThere) {
        outputChannel.appendLine("[rotate] already " + orientation + ", no-op");
        vscode.window.showInformationMessage("android-emu: Display is already in " + orientation + ".");
        return;
      }
      const spinDirection = orientation === "landscape" ? "right" : "left";
      currentRotation = spinDirection === "right" ? (currentRotation - 1 + 4) % 4 : (currentRotation + 1) % 4;
      if (activeSocket && activeSocket.readyState === import_ws.WebSocket.OPEN) {
        activeSocket.send(JSON.stringify({ type: "rotate", direction: spinDirection }));
      }
      sendInput("cmd window user-rotation lock " + currentRotation);
      outputChannel.appendLine("[rotate] " + orientation + " -> rotation " + currentRotation);
      await new Promise((r) => setTimeout(r, 2e3));
      if (stopped) {
        return;
      }
      stopVideoSource();
      if (activeSocket && activeSocket.readyState === import_ws.WebSocket.OPEN) {
        activeSocket.send(JSON.stringify({ type: "recreate" }));
      }
      primed = false;
      void startVideoSource();
      primeDisplay();
    };
    panel.webview.html = getWebviewContent();
    panel.onDidDispose(() => {
      stopped = true;
      rotateScreenFn = null;
      try {
        activeScrcpySession?.stop();
      } catch {
      }
      activeScrcpySession = null;
      activeRecordProcess?.kill();
      activeInputShell?.kill();
      wss.close();
      activeRecordProcess = null;
      activeInputShell = null;
      activeWss = null;
      activeSocket = null;
    }, null, context.subscriptions);
  })();
}
function queryDeviceSize(adbPath, serial) {
  return new Promise((resolve) => {
    const child = (0, import_child_process2.spawn)(adbPath, ["-s", serial, "shell", "wm", "size"]);
    let out = "";
    let done = false;
    const finish = (val) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(val);
      }
    };
    child.stdout?.on("data", (d) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d) => outputChannel.appendLine("[wm size] " + d.toString().trim()));
    child.on("error", () => finish(null));
    child.on("exit", () => {
      const override = out.match(/Override size:\s*(\d+)x(\d+)/);
      const physical = out.match(/Physical size:\s*(\d+)x(\d+)/);
      const m = override || physical;
      finish(m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : null);
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, 3e3);
  });
}
async function queryRotation(adbPath, serial) {
  const r = await runCommand(adbPath, ["-s", serial, "shell", "cmd", "window", "user-rotation"], 5e3);
  if (r.code !== 0) {
    return 0;
  }
  const m = r.stdout.match(/(\d+)/);
  return m ? parseInt(m[1], 10) % 4 : 0;
}
function runCommand(cmd, args, timeoutMs = 5e3) {
  return new Promise((resolve) => {
    const child = (0, import_child_process2.spawn)(cmd, args, { shell: false });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code) => {
      if (!done) {
        done = true;
        clearTimeout(t);
        resolve({ code, stdout, stderr });
      }
    };
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", () => finish(127));
    child.on("exit", (code) => finish(code ?? 0));
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
      finish(124);
    }, timeoutMs);
  });
}
async function commandExists(cmd, args) {
  const r = await runCommand(cmd, args, 5e3);
  return r.code === 0;
}
function killProcessGroup(child) {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
  }
  try {
    child.kill("SIGKILL");
  } catch {
  }
}
function findExpoWorkspace() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage("android-emu: No workspace folder open. Open your Expo project folder first.");
    return null;
  }
  const root = folder.uri.fsPath;
  let isExpo = false;
  try {
    const appJsonPath = path2.join(root, "app.json");
    if (fs2.existsSync(appJsonPath)) {
      const appJson = JSON.parse(fs2.readFileSync(appJsonPath, "utf8"));
      isExpo = !!appJson.expo;
    }
    if (!isExpo) {
      const pkgPath = path2.join(root, "package.json");
      if (fs2.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs2.readFileSync(pkgPath, "utf8"));
        const deps = { ...pkg.dependencies ?? {}, ...pkg.devDependencies ?? {} };
        isExpo = "expo" in deps;
      }
    }
  } catch {
  }
  if (!isExpo) {
    vscode.window.showErrorMessage('android-emu: This workspace does not look like an Expo project (no app.json "expo" config or "expo" dependency in package.json).');
    return null;
  }
  return folder;
}
function runInTerminal(name, cwd, command) {
  const terminal = vscode.window.createTerminal({ name, cwd });
  terminal.show(true);
  terminal.sendText(command, true);
  return terminal;
}
async function writeScreenshot(dataUrl) {
  if (!dataUrl) {
    vscode.window.showErrorMessage("android-emu: Screenshot failed - video feed not ready yet.");
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage("android-emu: No workspace folder open. Open a folder to save screenshots.");
    return;
  }
  const dir = path2.join(folder.uri.fsPath, ".android-emu", "screenshots");
  fs2.mkdirSync(dir, { recursive: true });
  const ts = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = ts.getFullYear() + "-" + p(ts.getMonth() + 1) + "-" + p(ts.getDate()) + "_" + p(ts.getHours()) + "-" + p(ts.getMinutes()) + "-" + p(ts.getSeconds()) + "-" + String(ts.getMilliseconds()).padStart(3, "0");
  const file = path2.join(dir, "screenshot_" + stamp + ".png");
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  fs2.writeFileSync(file, Buffer.from(base64, "base64"));
  outputChannel.appendLine("[screenshot] saved " + file);
  vscode.window.showInformationMessage("android-emu: Screenshot saved to " + file);
}
function getWebviewContent() {
  return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <!--
            Content-Security-Policy is REQUIRED in VS Code webviews.
            Without an explicit CSP, VS Code injects a restrictive default
            (default-src 'none') which silently blocks:
              - the external JMuxer script,
              - the inline script that drives the player,
              - the ws://localhost WebSocket, and
              - the blob: MediaSource URL that JMuxer assigns to <video>.
            All of those must be whitelisted here or nothing renders.
        -->
        <meta http-equiv="Content-Security-Policy" content="
            default-src 'none';
            img-src https: data: blob:;
            media-src https: blob:;
            style-src 'unsafe-inline' https:;
            script-src 'unsafe-inline' https://cdn.jsdelivr.net;
            connect-src ws://localhost:9225 wss://localhost:9225;
        ">
        <style>
            html, body { margin: 0; padding: 0; height: 100%; }
            body { display: flex; justify-content: center; align-items: center; background: #1e1e1e; font-family: sans-serif; overflow: hidden; user-select: none; }
            /* The wrapper is sized by JS to the device aspect ratio; no fixed px here. */
            #wrapper { position: relative; border: 3px solid #444; border-radius: 12px; overflow: hidden; background: #000; box-shadow: 0 10px 30px rgba(0,0,0,0.5); transition: transform 0.4s ease; }
            video { width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
            /* WebCodecs render target (low-latency path): the canvas bitmap is
               the decoded frame at native resolution; CSS stretches it to the
               wrapper, which is already aspect-fit to the device. */
            #playerCanvas { width: 100%; height: 100%; pointer-events: none; display: none; }
            /* Blurred-screenshot placeholder shown during rotation. It is a sibling
               layer that fills the VIEWPORT (wrapper) itself - not tied to the
               video's letterboxed content box - and is stretched 100% x 100% so it
               always matches the viewport's current aspect exactly (no cover-crop).
               Fades out once the new feed has its first frame. */
            #rotateBlur { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 20; opacity: 0; transition: opacity 0.3s ease; pointer-events: none; background-size: 100% 100%; background-position: center; filter: blur(8px) brightness(0.85); transform: scale(1.1); }
            #rotateBlur.visible { opacity: 1; }
            /* touch-action:none stops the browser from scrolling/panning/zooming so the
               overlay receives the full pointer stream, like a real touch surface. */
            #touchOverlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; cursor: pointer; z-index: 10; touch-action: none; outline: none; }
        </style>
        <!-- JMuxer from jsDelivr. The old https://jsdelivr.net URL was the bare
             domain (returns HTML), so JMuxer was undefined and the script crashed. -->
        <script src="https://cdn.jsdelivr.net/npm/jmuxer@2.1.3/dist/jmuxer.min.js"></script>
    </head>
    <body>
        <div id="wrapper">
            <video id="player" autoplay muted playsinline></video>
            <!-- WebCodecs decode target (shown instead of <video> when the
                 VideoDecoder API is available). -->
            <canvas id="playerCanvas"></canvas>
            <!-- Blurred-screenshot placeholder shown during screen rotation -->
            <div id="rotateBlur"></div>
            <!-- Overlay catcher prevents the video layer from muddying browser mouse coordinates -->
            <div id="touchOverlay" tabindex="0"></div>
        </div>

        <script>
            const touchOverlay = document.getElementById('touchOverlay');
            const video = document.getElementById('player');
            const wrapper = document.getElementById('wrapper');
            const rotateBlur = document.getElementById('rotateBlur');
            const ws = new WebSocket('ws://localhost:9225');
            ws.binaryType = 'arraybuffer'; // Crucial: tell websocket to expect binary data frames

            ws.onopen = () => console.log('[mirror] WebSocket connected to ws://localhost:9225');
            ws.onerror = (e) => console.error('[mirror] WebSocket error', e);
            ws.onclose = (e) => console.warn('[mirror] WebSocket closed', e.code, e.reason);

            // Initialize JMuxer to feed raw H.264 streams straight to the video element.
            // Guard the constructor: if the CDN script failed to load (old code pointed at
            // the bare https://jsdelivr.net domain) JMuxer is undefined and the throw used
            // to abort the ENTIRE inline script, taking the touch handlers down with it.
            let jmuxer = null;
            if (typeof JMuxer === 'undefined') {
                console.error('[mirror] JMuxer is undefined - the CDN script did not load. Check CSP script-src and the <script src>.');
            } else {
                jmuxer = new JMuxer({
                    node: 'player',
                    mode: 'video',
                    flushingTime: 0, // Set to 0 for near zero-latency instant local mirroring
                    clearBuffer: true
                });
            }

            // ---- WebCodecs low-latency decoder (preferred) ----------------------
            // JMuxer+MSE adds demux/buffer/compositor latency. When the WebCodecs
            // VideoDecoder API is available we instead parse the raw H.264 Annex-B
            // stream ourselves, decode with optimizeForLatency, and paint each
            // frame to a canvas the moment it is decoded - the lowest-latency
            // render path available in a webview. JMuxer remains the fallback.
            // 'let' (not const) because the watchdog below can demote to the
            // JMuxer path at runtime if decoding never starts.
            let useWebCodecs = (typeof VideoDecoder !== 'undefined');
            const canvas = document.getElementById('playerCanvas');
            const ctx2d = canvas.getContext('2d', { alpha: false });
            let decoder = null;
            let decoderReady = false;
            let sawKeyframe = false;
            let spsNAL = null;
            let ppsNAL = null;
            let auNals = [];       // NAL units (start code stripped) of the access unit in progress
            let auHasKey = false;
            let streamBuf = new Uint8Array(0); // unconsumed stream bytes (NALs straddle messages)
            let nalStart = -1;                 // index in streamBuf of the current NAL's first byte; -1 = none yet
            let hideBlurOnNextFrame = false;
            let blurHideFallback = null;
            let gotFirstFrame = false;         // watchdog bail-out once a frame has been painted

            if (useWebCodecs) {
                video.style.display = 'none';
                canvas.style.display = 'block';
                console.log('[mirror] using WebCodecs VideoDecoder (low latency)');
            }

            function hex2(n) { return (n < 16 ? '0' : '') + n.toString(16); }

            // Build an AVCDecoderConfigurationRecord ("avcC") from the SPS+PPS so
            // the decoder runs in AVCC mode (length-prefixed NAL units).
            function avcCDescription(sps, pps) {
                const d = new Uint8Array(11 + sps.length + pps.length);
                d[0] = 1;                 // version
                d[1] = sps[1];            // profile_idc
                d[2] = sps[2];            // constraint flags
                d[3] = sps[3];            // level_idc
                d[4] = 0xfc | 3;          // lengthSizeMinusOne = 3 (4-byte lengths)
                d[5] = 0xe0 | 1;          // 1 SPS
                d[6] = (sps.length >> 8) & 0xff;
                d[7] = sps.length & 0xff;
                d.set(sps, 8);
                d[8 + sps.length] = 1;    // 1 PPS
                d[9 + sps.length] = (pps.length >> 8) & 0xff;
                d[10 + sps.length] = pps.length & 0xff;
                d.set(pps, 11 + sps.length);
                return d;
            }

            // Tear the decoder down so the next SPS/PPS+IDR in the stream
            // reconfigures it from scratch. Used on decode errors (self-heal)
            // and before recreation on rotation.
            function resetDecoder() {
                try { if (decoder) { decoder.close(); } } catch (e) { /* already dead */ }
                decoder = null;
                decoderReady = false;
                sawKeyframe = false;
            }

            function configureDecoder() {
                decoder = new VideoDecoder({
                    output: function (frame) {
                        gotFirstFrame = true;
                        const w = frame.displayWidth || frame.codedWidth;
                        const h = frame.displayHeight || frame.codedHeight;
                        if (w && h) {
                            if (canvas.width !== frame.codedWidth || canvas.height !== frame.codedHeight) {
                                canvas.width = frame.codedWidth;
                                canvas.height = frame.codedHeight;
                            }
                            fitWrapper(w, h);
                            // The decoded frame is the AUTHORITATIVE display space:
                            // touch events are expressed (and size-tagged) in these
                            // dimensions, and the host's initial 'size' message can
                            // be stale (e.g. rotation changed since mirror start).
                            EMULATOR_WIDTH = w;
                            EMULATOR_HEIGHT = h;
                        }
                        ctx2d.drawImage(frame, 0, 0, frame.codedWidth, frame.codedHeight);
                        frame.close();
                        if (hideBlurOnNextFrame) {
                            hideBlurOnNextFrame = false;
                            clearTimeout(blurHideFallback);
                            hideRotateBlur();
                        }
                    },
                    error: function (e) {
                        console.error('[mirror] decoder error - resetting for the next keyframe', e);
                        resetDecoder();
                    }
                });
                decoder.configure({
                    codec: 'avc1.' + hex2(spsNAL[1]) + hex2(spsNAL[2]) + hex2(spsNAL[3]),
                    description: avcCDescription(spsNAL, ppsNAL),
                    optimizeForLatency: true // trade throughput for minimal decode latency
                });
                decoderReady = true;
            }

            // Flush the completed access unit to the decoder as one chunk.
            function flushAU() {
                if (auNals.length === 0) { auHasKey = false; return; }
                if (!decoderReady) {
                    if (spsNAL && ppsNAL) { configureDecoder(); }
                    else { auNals = []; auHasKey = false; return; }
                }
                if (!sawKeyframe && !auHasKey) {
                    // Never feed deltas before the first IDR of the stream.
                    auNals = []; auHasKey = false; return;
                }
                try {
                    // Annex-B -> AVCC: replace start codes with 4-byte lengths.
                    let total = 0;
                    for (let i = 0; i < auNals.length; i++) { total += 4 + auNals[i].length; }
                    const data = new Uint8Array(total);
                    let o = 0;
                    for (let i = 0; i < auNals.length; i++) {
                        const n = auNals[i];
                        data[o] = (n.length >>> 24) & 0xff;
                        data[o + 1] = (n.length >>> 16) & 0xff;
                        data[o + 2] = (n.length >>> 8) & 0xff;
                        data[o + 3] = n.length & 0xff;
                        data.set(n, o + 4);
                        o += 4 + n.length;
                    }
                    decoder.decode(new EncodedVideoChunk({
                        type: auHasKey ? 'key' : 'delta',
                        timestamp: Math.round(performance.now() * 1000),
                        data: data
                    }));
                } catch (e) {
                    console.error('[mirror] decode failed - resetting decoder', e);
                    resetDecoder(); // self-heal: reconfigure from the next SPS/PPS+IDR
                }
                auNals = [];
                auHasKey = false;
            }

            function handleNal(nal) {
                // Strip trailing zero bytes first: the extra zero of 4-byte start
                // codes (00 00 00 01) lands at the end of the preceding NAL.
                let end = nal.length;
                while (end > 1 && nal[end - 1] === 0) { end--; }
                if (end < 1) { return; }
                const n = nal.subarray(0, end);
                // n[0] is the NAL header; its low 5 bits are the unit type.
                const type = n[0] & 0x1f;
                if (type === 7) {          // SPS: new access unit + new config
                    flushAU();
                    spsNAL = n;
                    auNals.push(n);
                } else if (type === 8) {   // PPS: belongs to the current AU
                    ppsNAL = n;
                    auNals.push(n);
                } else if (type >= 1 && type <= 5) { // VCL slices
                    // A VCL NAL whose first slice-header byte has its MSB set has
                    // first_mb_in_slice == 0 => it STARTS a new access unit (a
                    // new frame). Continuation slices of a multi-slice frame have
                    // first_mb_in_slice > 0, i.e. MSB clear. Detecting frame
                    // boundaries this way (not just on IDR/SPS) is essential:
                    // encoders only emit IDR/SPS every GOP (~10s), so without it
                    // hundreds of frames would merge into a single chunk.
                    if (n.length > 1 && (n[1] & 0x80)) { flushAU(); }
                    if (type === 5) { sawKeyframe = true; auHasKey = true; }
                    auNals.push(n);
                } else if (type === 6) {   // SEI: keep with the current AU
                    auNals.push(n);
                }
                // Other NAL types (AUD 9, filler 12, ...) are ignored.
            }

            // Split the incoming Annex-B chunk into NAL units. All bytes are kept
            // in a persistent buffer because both NAL payloads AND their start
            // codes can straddle WebSocket message boundaries - a per-message
            // scan (the first version of this parser) merged NALs into garbage
            // whenever a start code straddled a boundary, which corrupted the
            // stream and left the viewport blank. A NAL is only complete once
            // the NEXT start code arrives, which costs at most one frame.
            function feedH264(bytes) {
                if (streamBuf.length === 0) {
                    streamBuf = bytes;
                } else {
                    const merged = new Uint8Array(streamBuf.length + bytes.length);
                    merged.set(streamBuf);
                    merged.set(bytes, streamBuf.length);
                    streamBuf = merged;
                }
                let i = nalStart >= 0 ? nalStart : 0;
                while (true) {
                    let sc = -1;
                    for (let k = i; k + 2 < streamBuf.length; k++) {
                        if (streamBuf[k] === 0 && streamBuf[k + 1] === 0 && streamBuf[k + 2] === 1) { sc = k; break; }
                    }
                    if (sc < 0) { break; }
                    if (nalStart >= 0) {
                        handleNal(streamBuf.subarray(nalStart, sc));
                    }
                    nalStart = sc + 3;
                    i = nalStart;
                }
                // Drop consumed bytes; copy so the merged parent isn't pinned.
                if (nalStart > 0) {
                    const keep = new Uint8Array(streamBuf.length - nalStart);
                    keep.set(streamBuf.subarray(nalStart));
                    streamBuf = keep;
                    nalStart = 0;
                }
            }

            // Safety net: if WebCodecs accepts the stream but never paints a
            // frame (unsupported profile, GPU/driver issue, parser mismatch),
            // transparently demote to the JMuxer path instead of a blank panel.
            let watchdogTimer = null;
            function armDecoderWatchdog() {
                if (gotFirstFrame || watchdogTimer !== null || !useWebCodecs) { return; }
                watchdogTimer = setTimeout(() => {
                    watchdogTimer = null;
                    if (!gotFirstFrame && useWebCodecs) {
                        console.error('[mirror] no decoded frame within 5s of stream data - switching to JMuxer');
                        switchToJmuxer();
                    }
                }, 5000);
            }

            function switchToJmuxer() {
                resetDecoder();
                spsNAL = null;
                ppsNAL = null;
                auNals = [];
                auHasKey = false;
                streamBuf = new Uint8Array(0);
                nalStart = -1;
                useWebCodecs = false;
                canvas.style.display = 'none';
                video.style.display = '';
                if (!jmuxer) {
                    console.error('[mirror] JMuxer is also unavailable - no decoder left to fall back to');
                }
            }


            // -- Viewport sizing -----------------------------------------------
            // The emulator real resolution is sent from the extension as a text control
            // frame ({type:'size', width, height}). We size the phone frame to that aspect
            // ratio (fit within the window) and use it to scale pointer coordinates back to
            // device pixels. Until it arrives we fall back to the actual video stream
            // dimensions (loadedmetadata), then to 1080x2400.
            let EMULATOR_WIDTH = 1080;
            let EMULATOR_HEIGHT = 2400;
            let gotDeviceSize = false;

            function fitWrapper(w, h) {
                if (!w || !h) { return; }
                const aspect = w / h;
                const maxH = window.innerHeight - 24;
                const maxW = window.innerWidth - 24;
                let dh = maxH;
                let dw = dh * aspect;
                if (dw > maxW) { dw = maxW; dh = dw / aspect; }
                wrapper.style.width = dw + 'px';
                wrapper.style.height = dh + 'px';
            }

            function setDeviceSize(w, h) {
                EMULATOR_WIDTH = w;
                EMULATOR_HEIGHT = h;
                gotDeviceSize = true;
                fitWrapper(w, h);
                console.log('[mirror] device size set', w, 'x', h);
            }

            // Destroy and recreate the JMuxer player. MSE cannot handle an H.264 SPS
            // resolution change mid-stream, so when the screen rotates we need a fresh
            // decoder for the new-orientation stream. This is called AFTER the viewport
            // has already been resized (so the user sees the new frame immediately) and
            // right before the new screenrecord stream begins.
            function recreatePlayer() {
                if (useWebCodecs) {
                    // Tear down the WebCodecs decoder; the fresh stream starts
                    // with a new SPS/PPS for the rotated resolution.
                    resetDecoder();
                    spsNAL = null;
                    ppsNAL = null;
                    auNals = [];
                    auHasKey = false;
                    streamBuf = new Uint8Array(0);
                    nalStart = -1;
                    hideBlurOnNextFrame = true;
                    clearTimeout(blurHideFallback);
                    // Safety: fade the blur out even if no frame ever arrives.
                    blurHideFallback = setTimeout(hideRotateBlur, 4000);
                    console.log('[mirror] WebCodecs decoder recreated for new resolution');
                    return;
                }
                if (jmuxer) { jmuxer.destroy(); jmuxer = null; }
                if (typeof JMuxer === 'undefined') {
                    console.error('[mirror] JMuxer is undefined - cannot recreate.');
                    return;
                }
                jmuxer = new JMuxer({
                    node: 'player',
                    mode: 'video',
                    flushingTime: 0,
                    clearBuffer: true
                });
                console.log('[mirror] JMuxer recreated for new resolution');
                // Hide the blurred placeholder once the new stream renders its first
                // frame. The 'playing' event fires after JMuxer's MediaSource has
                // decoded and displayed the first frame of the new-orientation stream.
                const onPlaying = () => {
                    video.removeEventListener('playing', onPlaying);
                    clearTimeout(blurFallback);
                    hideRotateBlur();
                };
                video.addEventListener('playing', onPlaying);
                // Safety: if 'playing' never fires (e.g. stream stalls), fade out
                // anyway so the blur doesn't get stuck on screen.
                const blurFallback = setTimeout(() => {
                    video.removeEventListener('playing', onPlaying);
                    hideRotateBlur();
                }, 4000);
            }

            // Animate a 90-degree viewport spin via CSS transform so the phone frame
            // looks like it physically rotates (instead of a jarring dimension swap).
            // The old video keeps playing during the spin; once it completes we reset
            // the transform to 0 and apply the swapped dimensions in the same frame,
            // which is visually seamless because a 90deg-rotated box already occupies
            // the swapped space. The device rotates underneath during/after the spin.
            // A blurred screenshot of the current frame is shown as a placeholder so
            // the transition looks polished (no black/janky gap while the new stream
            // arrives). It fades out once the recreated player gets its first frame.
            // Two versions of the screenshot are prepared: the frame as-is (shown
            // during the spin, rotating with the viewport) and a PRE-ROTATED copy
            // (swapped in at spin end) whose shape matches the swapped viewport, so
            // the placeholder keeps the viewport's aspect ratio after the rotation.
            let rotatedBlurUrl = null;
            function showRotateBlur(direction) {
                // In WebCodecs mode the live frame lives in playerCanvas, not in
                // the (hidden) <video> element used by the JMuxer fallback.
                const src = useWebCodecs
                    ? (canvas.width && canvas.height ? canvas : null)
                    : (video.videoWidth && video.videoHeight ? video : null);
                if (src) {
                    const sw = src.width || src.videoWidth;
                    const sh = src.height || src.videoHeight;
                    // Image 1: the frame as-is (current orientation aspect).
                    const c1 = document.createElement('canvas');
                    c1.width = sw;
                    c1.height = sh;
                    c1.getContext('2d').drawImage(src, 0, 0);
                    rotateBlur.style.backgroundImage = 'url(' + c1.toDataURL('image/png') + ')';
                    // Image 2: the same frame rotated +/-90deg into the new
                    // orientation's shape (width/height swapped).
                    const c2 = document.createElement('canvas');
                    c2.width = sh;
                    c2.height = sw;
                    const ctx = c2.getContext('2d');
                    if (direction === 'right') {
                        ctx.translate(sh, 0);
                        ctx.rotate(Math.PI / 2);
                    } else {
                        ctx.translate(0, sw);
                        ctx.rotate(-Math.PI / 2);
                    }
                    ctx.drawImage(src, 0, 0);
                    rotatedBlurUrl = c2.toDataURL('image/png');
                }
                rotateBlur.classList.add('visible');
            }

            function hideRotateBlur() {
                rotateBlur.classList.remove('visible');
            }

            function rotateViewport(direction) {
                const angle = direction === 'right' ? 90 : -90;
                // Capture the current frame and show the blurred placeholder BEFORE
                // the spin, so it covers the video throughout the rotation.
                showRotateBlur(direction);
                // Swap device dimensions so touch maps to the new orientation after.
                const tmpW = EMULATOR_WIDTH;
                EMULATOR_WIDTH = EMULATOR_HEIGHT;
                EMULATOR_HEIGHT = tmpW;
                let done = false;
                const onEnd = (e) => {
                    if (done) { return; }
                    // transitionend BUBBLES \u2014 #rotateBlur's opacity transition fires at
                    // 0.3s and would cut this 0.4s rotation short. Only respond to the
                    // wrapper's OWN transform transition so the blur rotates fully with it.
                    if (e && (e.target !== wrapper || e.propertyName !== 'transform')) { return; }
                    done = true;
                    wrapper.removeEventListener('transitionend', onEnd);
                    clearTimeout(fallback);
                    wrapper.style.transition = 'none';
                    wrapper.style.transform = '';
                    // Swap the blur to the PRE-ROTATED image in the same frame as the
                    // dimension swap: its content is exactly what the spinning image
                    // showed, now unrotated inside the swapped box - a pixel-perfect
                    // visual continuation that aspect-matches the new viewport (no
                    // cover-crop distortion during the hold until the new stream lands).
                    if (rotatedBlurUrl) { rotateBlur.style.backgroundImage = 'url(' + rotatedBlurUrl + ')'; }
                    fitWrapper(EMULATOR_WIDTH, EMULATOR_HEIGHT);
                    // Re-enable the transform transition on the next frame.
                    requestAnimationFrame(() => { wrapper.style.transition = ''; });
                };
                // Fallback in case transitionend doesn't fire (e.g. tab hidden).
                const fallback = setTimeout(onEnd, 600);
                wrapper.addEventListener('transitionend', onEnd);
                wrapper.style.transform = 'rotate(' + angle + 'deg)';
            }

            fitWrapper(EMULATOR_WIDTH, EMULATOR_HEIGHT);

            video.addEventListener('loadedmetadata', () => {
                if (video.videoWidth && video.videoHeight) {
                    fitWrapper(video.videoWidth, video.videoHeight);
                    if (!gotDeviceSize) {
                        EMULATOR_WIDTH = video.videoWidth;
                        EMULATOR_HEIGHT = video.videoHeight;
                    }
                }
            });

            window.addEventListener('resize', () => fitWrapper(EMULATOR_WIDTH, EMULATOR_HEIGHT));

            // -- Touch gestures ------------------------------------------------
            // Translate pointer events on the overlay into a real touch sequence on the
            // device: pointerdown -> DOWN, pointermove -> MOVE, pointerup -> UP,
            // pointercancel -> CANCEL. Moves are throttled to ~60Hz and only sent when the
            // position changed by >=1 device px, which keeps the stream smooth without
            // flooding adb. Pointer capture keeps tracking during a drag even if the cursor
            // leaves the frame, matching how the Android emulator handles touch.
            const MIN_MOVE_INTERVAL_MS = 16;
            const MIN_MOVE_DELTA_PX = 1;
            let dragging = false;
            let lastSent = 0;
            let lastX = 0;
            let lastY = 0;

            function toDevice(e) {
                const rect = touchOverlay.getBoundingClientRect();
                const x = ((e.clientX - rect.left) / rect.width) * EMULATOR_WIDTH;
                const y = ((e.clientY - rect.top) / rect.height) * EMULATOR_HEIGHT;
                return { x: Math.round(x), y: Math.round(y) };
            }

            function sendTouch(action, x, y) {
                if (ws.readyState === WebSocket.OPEN) {
                    // Include the display space the coordinates are expressed in
                    // (the mirrored video size). The scrcpy server DROPS touch
                    // events whose reported size doesn't match the video size it
                    // is currently producing ("generated for a different device
                    // size"), so this must be the live frame size, not a guess.
                    ws.send(JSON.stringify({ type: 'touch', action: action, x: x, y: y, w: EMULATOR_WIDTH, h: EMULATOR_HEIGHT }));
                }
            }

            touchOverlay.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                try { touchOverlay.setPointerCapture(e.pointerId); } catch (_) {}
                dragging = true;
                const p = toDevice(e);
                lastX = p.x; lastY = p.y; lastSent = performance.now();
                sendTouch('down', p.x, p.y);
            });

            touchOverlay.addEventListener('pointermove', (e) => {
                if (!dragging) { return; }
                const p = toDevice(e);
                const now = performance.now();
                const moved = Math.abs(p.x - lastX) >= MIN_MOVE_DELTA_PX ||
                              Math.abs(p.y - lastY) >= MIN_MOVE_DELTA_PX;
                if (moved && now - lastSent >= MIN_MOVE_INTERVAL_MS) {
                    lastX = p.x; lastY = p.y; lastSent = now;
                    sendTouch('move', p.x, p.y);
                }
            });

            function endDrag(e) {
                if (!dragging) { return; }
                dragging = false;
                const p = toDevice(e);
                // Ensure the final position is delivered so the drag ends exactly where
                // the pointer lifted, then release the touch sequence.
                if (p.x !== lastX || p.y !== lastY) {
                    sendTouch('move', p.x, p.y);
                }
                sendTouch('up', p.x, p.y);
                try { touchOverlay.releasePointerCapture(e.pointerId); } catch (_) {}
            }

            touchOverlay.addEventListener('pointerup', endDrag);
            touchOverlay.addEventListener('pointercancel', (e) => {
                if (!dragging) { return; }
                dragging = false;
                const p = toDevice(e);
                sendTouch('cancel', p.x, p.y);
                try { touchOverlay.releasePointerCapture(e.pointerId); } catch (_) {}
            });

            // Focus the overlay on pointerdown so keyboard events are captured.
            touchOverlay.addEventListener('pointerdown', () => { touchOverlay.focus(); });

            // ---- Keyboard capture -------------------------------------------
            // Forward keystrokes to the Android emulator. Special keys map to
            // input keyevent <code>; printable characters use input text.
            // Ctrl/Cmd/Alt combos are left for the browser (copy, paste, etc.).
            const KEYCODE_MAP = {
                'Enter': 66, 'Backspace': 67, 'Delete': 112,
                'ArrowUp': 19, 'ArrowDown': 20, 'ArrowLeft': 21, 'ArrowRight': 22,
                'Tab': 61, 'Escape': 4, 'Home': 3, 'End': 122,
                'PageUp': 92, 'PageDown': 93
            };
            window.addEventListener('keydown', (e) => {
                if (e.ctrlKey || e.metaKey || e.altKey) { return; }
                if (KEYCODE_MAP[e.key] !== undefined) {
                    e.preventDefault();
                    ws.send(JSON.stringify({ type: 'key', action: 'keyevent', code: KEYCODE_MAP[e.key] }));
                } else if (e.key.length === 1) {
                    e.preventDefault();
                    ws.send(JSON.stringify({ type: 'key', action: 'text', char: e.key }));
                }
            });

            // Feed inbound binary frames to JMuxer; handle text control frames here.
            ws.onmessage = (event) => {
                if (typeof event.data === 'string') {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.type === 'size' && msg.width && msg.height) {
                            setDeviceSize(msg.width, msg.height);
                        } else if (msg.type === 'rotate' && (msg.direction === 'left' || msg.direction === 'right')) {
                            rotateViewport(msg.direction);
                        } else if (msg.type === 'recreate') {
                            recreatePlayer();
                        } else if (msg.type === 'screenshot') {
                            // Capture the current frame to a canvas and send
                            // the PNG back as a base64 data URL for the extension to save.
                            if (useWebCodecs && canvas.width && canvas.height) {
                                // The live frame already IS the canvas bitmap.
                                ws.send(JSON.stringify({ type: 'screenshot-data', data: canvas.toDataURL('image/png') }));
                            } else if (video.videoWidth && video.videoHeight) {
                                const canvas = document.createElement('canvas');
                                canvas.width = video.videoWidth;
                                canvas.height = video.videoHeight;
                                canvas.getContext('2d').drawImage(video, 0, 0);
                                ws.send(JSON.stringify({ type: 'screenshot-data', data: canvas.toDataURL('image/png') }));
                            } else {
                                ws.send(JSON.stringify({ type: 'screenshot-data', data: '' }));
                            }
                        }
                    } catch (err) {
                        console.error('[mirror] bad control message', event.data, err);
                    }
                } else if (event.data instanceof ArrayBuffer) {
                    const bytes = new Uint8Array(event.data);
                    if (useWebCodecs) {
                        armDecoderWatchdog(); // one-shot bail-out to JMuxer if nothing ever decodes
                        feedH264(bytes);
                    } else if (jmuxer) {
                        jmuxer.feed({ video: bytes });
                    }
                }
            };
        </script>
    </body>
    </html>`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
