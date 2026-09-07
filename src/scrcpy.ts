// scrcpy device-side server integration (protocol version PINNED to 2.4).
//
// Why: the previous pipeline used `adb exec-out screenrecord` for video
// (~0.5-1s encoder latency, ~2fps on static screens, 3-minute self-termination)
// and `input motionevent`/`input keyevent` for input (each line spawns a JVM on
// the device, ~100-300ms per event). scrcpy's server instead streams a tuned
// low-latency H.264 feed (~35-70ms glass-to-glass, like the native scrcpy
// client) and injects input events over a binary control socket in ~1ms.
//
// The protocol is version-specific, so we always run ONE pinned server version.
// The server jar is self-contained: it does NOT need to match the scrcpy client
// installed on the host. Protocol facts below were verified against the v2.4
// sources (Server.java, Options.java, DesktopConnection.java,
// ControlMessage.java, ControlMessageReader.java):
//   - invocation: CLASSPATH=/data/local/tmp/scrcpy-server.jar \
//                 app_process / com.genymobile.scrcpy.Server 2.4 <key=value...>
//   - raw_stream=true -> no dummy byte, no device/codec/frame meta; the video
//     socket carries a pure H.264 Annex-B stream (same shape as screenrecord).
//   - with tunnel_forward=true and audio=false, the server accepts exactly two
//     connections on abstract socket "scrcpy", in order: video, then control.
//   - touch message (32 bytes, big-endian):
//       type=2, action u8 (0 DOWN,1 UP,2 MOVE,3 CANCEL), pointerId i64 (-1),
//       x i32, y i32, screenWidth u16, screenHeight u16, pressure u16
//       fixed-point (0xFFFF = 1.0, 0 on UP), actionButton i32, buttons i32.
//   - key message (14 bytes): type=0, action u8 (0 DOWN, 1 UP), keycode i32,
//     repeat i32, metaState i32.

import * as net from 'net';
import * as https from 'https';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const SCRCPY_SERVER_VERSION = '2.4';
const SCRCPY_SERVER_URL =
    'https://github.com/Genymobile/scrcpy/releases/download/v' +
    SCRCPY_SERVER_VERSION + '/scrcpy-server-v' + SCRCPY_SERVER_VERSION;
const DEVICE_JAR = '/data/local/tmp/scrcpy-server.jar';
const SOCKET_NAME = 'scrcpy'; // scid unset => plain "scrcpy" abstract socket

// Control message types (scrcpy 2.4 ControlMessage.java).
const TYPE_INJECT_KEYCODE = 0;
const TYPE_INJECT_TOUCH_EVENT = 2;
// MotionEvent.ACTION_* values.
const TOUCH_ACTIONS: Record<string, number> = { DOWN: 0, UP: 1, MOVE: 2, CANCEL: 3 };
// KeyEvent.ACTION_* values.
const KEY_ACTION_DOWN = 0;
const KEY_ACTION_UP = 1;

export interface ScrcpySession {
    /** The `adb shell ... app_process ...` child process (kill it to end the session). */
    serverProcess: ChildProcess;
    /** Subscribe to raw H.264 video chunks from the video socket. */
    onVideoData(cb: (chunk: Buffer) => void): void;
    /** Subscribe to device messages (e.g. clipboard replies) arriving on the control socket. */
    onControlData(cb: (chunk: Buffer) => void): void;
    /** Subscribe to session termination (process exit or socket close). */
    onExit(cb: () => void): void;
    /** Inject a touch event in device pixel coordinates of a screenWidth x screenHeight display. */
    sendTouch(action: string, x: number, y: number, screenWidth: number, screenHeight: number): void;
    /** Inject a key press (DOWN + UP) with an Android KEYCODE_*. */
    sendKey(keycode: number): void;
    /** Write a raw control-protocol message (advanced use). */
    sendRaw(buf: Buffer): void;
    /** Stop the session: kill the server, close sockets, remove the adb forward. Idempotent. */
    stop(): void;
}

// Run a short-lived command and collect its output. Local copy so this module
// has no dependency on extension.ts (avoids a circular import).
function run(cmd: string, args: string[], timeoutMs = 15000): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { shell: false });
        let stdout = '';
        let stderr = '';
        let done = false;
        const finish = (code: number) => { if (!done) { done = true; clearTimeout(t); resolve({ code, stdout, stderr }); } };
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', () => finish(127));
        child.on('exit', (code) => finish(code ?? 0));
        const t = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(124); }, timeoutMs);
    });
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
    });
}

// Follow redirects (GitHub release assets redirect to a CDN) and download to a
// temp file that is only renamed into place after passing a sanity check.
function downloadFile(url: string, dest: string, redirects = 0): Promise<void> {
    return new Promise((resolve, reject) => {
        if (redirects > 5) { return reject(new Error('too many redirects')); }
        const req = https.get(url, (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                resolve(downloadFile(new URL(res.headers.location, url).toString(), dest, redirects + 1));
                return;
            }
            if (status !== 200) { res.resume(); reject(new Error('HTTP ' + status)); return; }
            const tmp = dest + '.tmp';
            const out = fs.createWriteStream(tmp);
            res.pipe(out);
            out.on('finish', () => {
                out.close((err) => {
                    if (err) { reject(err); return; }
                    try {
                        // A jar is a zip -> must start with "PK".
                        const fd = fs.openSync(tmp, 'r');
                        const magic = Buffer.alloc(2);
                        fs.readSync(fd, magic, 0, 2, 0);
                        fs.closeSync(fd);
                        if (magic.toString('ascii') !== 'PK') { fs.unlinkSync(tmp); reject(new Error('downloaded file is not a jar')); return; }
                        fs.renameSync(tmp, dest);
                        resolve();
                    } catch (e) { reject(e as Error); }
                });
            });
            out.on('error', reject);
            res.on('error', reject);
        });
        req.on('error', reject);
    });
}

function systemServerCandidates(): string[] {
    return [
        '/usr/share/scrcpy/scrcpy-server',            // Fedora / Debian / Arch
        '/usr/local/share/scrcpy/scrcpy-server',       // manual installs
        '/opt/homebrew/share/scrcpy/scrcpy-server',    // macOS (Apple Silicon)
        '/usr/local/opt/scrcpy/share/scrcpy/scrcpy-server' // macOS (Intel)
    ];
}

// Find or fetch the pinned scrcpy-server jar. Order:
//   1. previously downloaded copy in the extension global storage (offline-safe),
//   2. a host scrcpy install that ships exactly our pinned version,
//   3. a one-time download from GitHub releases (then cached forever).
// Returns null if no jar could be obtained (caller should fall back to the
// legacy screenrecord pipeline).
export async function getScrcpyServerJar(storageDir: string, log: (line: string) => void): Promise<string | null> {
    const cached = path.join(storageDir, 'scrcpy-server-v' + SCRCPY_SERVER_VERSION);
    try {
        if (fs.existsSync(cached) && fs.statSync(cached).size > 1024) { return cached; }
    } catch { /* fall through */ }

    // A host scrcpy of exactly our pinned version ships the same jar.
    const ver = await run('scrcpy', ['--version'], 5000);
    const m = ver.stdout.match(/scrcpy\s+(\d+\.\d+)/);
    if (ver.code === 0 && m && m[1] === SCRCPY_SERVER_VERSION) {
        for (const cand of systemServerCandidates()) {
            try {
                if (fs.existsSync(cand) && fs.statSync(cand).size > 1024) {
                    log('[scrcpy] using system server jar ' + cand);
                    return cand;
                }
            } catch { /* ignore */ }
        }
    }

    try {
        fs.mkdirSync(storageDir, { recursive: true });
        log('[scrcpy] downloading scrcpy-server v' + SCRCPY_SERVER_VERSION + ' (one-time, cached for offline use) ...');
        await downloadFile(SCRCPY_SERVER_URL, cached);
        log('[scrcpy] server jar cached at ' + cached);
        return cached;
    } catch (e: unknown) {
        log('[scrcpy] download failed: ' + ((e as Error)?.message ?? String(e)));
        try { fs.unlinkSync(cached + '.tmp'); } catch { /* ignore */ }
        return null;
    }
}

// The server's LocalServerSocket may not be listening yet when we first connect
// (it starts a few hundred ms after the shell command). adb accepts the TCP
// connection and immediately closes it if the abstract socket doesn't exist,
// so treat "connected then quickly closed" or "connect error" as "retry".
function connectWithRetry(port: number, what: string, log: (line: string) => void, timeoutMs = 15000): Promise<net.Socket> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            if (Date.now() > deadline) { reject(new Error('timeout connecting the ' + what + ' socket')); return; }
            const sock = net.connect(port, '127.0.0.1');
            const retry = (reason: string) => {
                clearTimeout(settled);
                sock.destroy();
                log('[scrcpy] ' + what + ' socket not ready yet (' + reason + '), retrying ...');
                setTimeout(attempt, 250);
            };
            const settled = setTimeout(() => {
                // Still connected after 400ms => the server accepted us.
                sock.removeListener('error', onError);
                sock.removeListener('close', onClose);
                resolve(sock);
            }, 400);
            const onError = (err: Error) => retry(err.message);
            const onClose = () => retry('closed');
            sock.once('error', onError);
            sock.once('close', onClose);
        };
        attempt();
    });
}

// Push the jar, forward a local port to the server's abstract socket, run the
// server, and connect its two sockets (video, then control - audio disabled).
export function startScrcpySession(opts: {
    adbPath: string;
    serial: string;
    jarPath: string;
    bitRate?: number;
    maxFps?: number;
    log: (line: string) => void;
}): Promise<ScrcpySession> {
    const { adbPath, serial, jarPath, log } = opts;
    const bitRate = opts.bitRate ?? 8000000;
    const maxFps = opts.maxFps ?? 60;

    return (async () => {
        // 1. Push the jar every start: it is tiny (~100KB) and the server deletes
        //    it on clean exit (cleanup=true), so this guarantees the pinned version.
        const push = await run(adbPath, ['-s', serial, 'push', jarPath, DEVICE_JAR], 30000);
        if (push.code !== 0) { throw new Error('adb push failed: ' + push.stderr.trim()); }

        // 2. Forward a free local port to the server's abstract socket.
        const port = await freePort();
        const fwd = await run(adbPath, ['-s', serial, 'forward', 'tcp:' + port, 'localabstract:' + SOCKET_NAME], 5000);
        if (fwd.code !== 0) { throw new Error('adb forward failed: ' + fwd.stderr.trim()); }

        // 3. Run the server. raw_stream=true => pure H.264 Annex-B on the video
        //    socket (no dummy byte / device meta / codec meta / frame meta), so
        //    the webview decoder sees the exact same stream shape as screenrecord.
        const serverProcess = spawn(adbPath, [
            '-s', serial, 'shell',
            'CLASSPATH=' + DEVICE_JAR, 'app_process', '/', 'com.genymobile.scrcpy.Server', SCRCPY_SERVER_VERSION,
            'log_level=info',
            'video=true',
            'audio=false',
            'control=true',
            'tunnel_forward=true',
            'raw_stream=true',
            'max_size=0',            // native device resolution
            'video_bit_rate=' + bitRate,
            'max_fps=' + maxFps
        ]);
        serverProcess.stderr?.on('data', (d: Buffer) => log('[scrcpy] ' + d.toString().trim()));
        // The scrcpy server writes its Ln logs to STDOUT (adb shell merges the
        // remote stdout into ours). Pipe it: (a) it is the only place errors
        // like "unable to convert position" (dropped touch events!) appear, and
        // (b) leaving a stdio pipe unread can fill its buffer and stall the
        // server process entirely.
        serverProcess.stdout?.on('data', (d: Buffer) => {
            const s = d.toString().trim();
            if (s) { log('[scrcpy:server] ' + s); }
        });
        serverProcess.on('error', (err: Error) => log('[scrcpy] spawn error: ' + err.message));

        // 4. Connect video, then control (the server accepts in this order).
        let videoSocket: net.Socket;
        let controlSocket: net.Socket;
        try {
            videoSocket = await connectWithRetry(port, 'video', log);
            controlSocket = await connectWithRetry(port, 'control', log);
        } catch (e) {
            serverProcess.kill();
            await run(adbPath, ['-s', serial, 'forward', '--remove', 'tcp:' + port], 5000);
            throw e instanceof Error ? e : new Error(String(e));
        }

        log('[scrcpy] session up (video+control on port ' + port + ')');

        // ---- Session object -------------------------------------------------
        let stopped = false;
        let exited = false;
        const videoCbs: Array<(chunk: Buffer) => void> = [];
        const controlCbs: Array<(chunk: Buffer) => void> = [];
        const exitCbs: Array<() => void> = [];

        const cleanup = () => {
            if (exited) { return; }
            exited = true;
            try { videoSocket.destroy(); } catch { /* ignore */ }
            try { controlSocket.destroy(); } catch { /* ignore */ }
            // Fire-and-forget: remove the forward so ports don't leak.
            run(adbPath, ['-s', serial, 'forward', '--remove', 'tcp:' + port], 5000);
            for (const cb of exitCbs) { cb(); }
        };

        videoSocket.on('data', (chunk: Buffer) => { for (const cb of videoCbs) { cb(chunk); } });
        controlSocket.on('data', (chunk: Buffer) => { for (const cb of controlCbs) { cb(chunk); } });
        // 'error' MUST be listened for: an unhandled socket 'error' event (e.g.
        // adb dying mid-session) would crash the extension host. Cleanup runs
        // via the 'close' event that follows.
        videoSocket.on('error', () => { /* see comment above */ });
        controlSocket.on('error', () => { /* see comment above */ });
        videoSocket.on('close', cleanup);
        serverProcess.on('exit', (code: number | null) => {
            log('[scrcpy] server exited code=' + code);
            cleanup();
        });

        const writeControl = (buf: Buffer) => {
            if (!stopped && controlSocket.writable) {
                try { controlSocket.write(buf); } catch { /* session dying */ }
            }
        };

        return {
            serverProcess,
            onVideoData: (cb: (chunk: Buffer) => void) => { videoCbs.push(cb); },
            onControlData: (cb: (chunk: Buffer) => void) => { controlCbs.push(cb); },
            onExit: (cb: () => void) => { exitCbs.push(cb); },
            sendRaw(buf: Buffer) {
                writeControl(buf);
            },
            sendTouch(action: string, x: number, y: number, screenWidth: number, screenHeight: number) {
                const code = TOUCH_ACTIONS[action.toUpperCase()];
                if (code === undefined || screenWidth <= 0 || screenHeight <= 0) { return; }
                const buf = Buffer.alloc(32);
                buf.writeUInt8(TYPE_INJECT_TOUCH_EVENT, 0);
                buf.writeUInt8(code, 1);
                // pointerId: -2 = POINTER_ID_GENERIC_FINGER (scrcpy control_msg.h).
                // IMPORTANT: -1 is POINTER_ID_MOUSE in scrcpy >= 2.0 - the server
                // then injects SOURCE_MOUSE/TOOL_TYPE_MOUSE events, which do not
                // behave like touch (no gestures, no show_touches indicator).
                buf.writeBigInt64BE(-2n, 2);
                buf.writeInt32BE(Math.round(x), 10);
                buf.writeInt32BE(Math.round(y), 14);
                buf.writeUInt16BE(Math.min(0xffff, screenWidth), 18);
                buf.writeUInt16BE(Math.min(0xffff, screenHeight), 20);
                buf.writeUInt16BE(code === TOUCH_ACTIONS.UP ? 0 : 0xffff, 22); // pressure fixed-point
                buf.writeInt32BE(0, 24);                            // actionButton
                buf.writeInt32BE(code === TOUCH_ACTIONS.UP ? 0 : 1, 28);       // buttons (server zeroes for finger events)
                writeControl(buf);
            },
            sendKey(keycode: number) {
                const down = Buffer.alloc(14);
                down.writeUInt8(TYPE_INJECT_KEYCODE, 0);
                down.writeUInt8(KEY_ACTION_DOWN, 1);
                down.writeInt32BE(keycode, 2);
                down.writeInt32BE(0, 6);   // repeat
                down.writeInt32BE(0, 10);  // metaState
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
                if (stopped) { return; }
                stopped = true;
                try { serverProcess.kill(); } catch { /* ignore */ }
                try { videoSocket.destroy(); } catch { /* ignore */ }
                try { controlSocket.destroy(); } catch { /* ignore */ }
                run(adbPath, ['-s', serial, 'forward', '--remove', 'tcp:' + port], 5000);
            }
        } satisfies ScrcpySession;
    })();
}


