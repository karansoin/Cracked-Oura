"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const http_1 = __importDefault(require("http"));
const child_process_1 = require("child_process");
let mainWindow = null;
let pythonProcess = null;
// True when the backend was spawned in its own process group (dev mode, non-Windows),
// so that killing the group also takes down uvicorn's --reload worker.
let backendDetached = false;
let tray = null;
let isQuitting = false;
const isDev = process.env.NODE_ENV === 'development';
const BACKEND_PORT = 8000;
const BACKEND_HEALTH_URL = `http://127.0.0.1:${BACKEND_PORT}/api/health`;
const BACKEND_READY_TIMEOUT_MS = 60_000;
const BACKEND_POLL_INTERVAL_MS = 500;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
// Debug logging helper. The file is truncated once it grows past MAX_LOG_BYTES so a
// chatty backend cannot fill the user's Documents folder.
function logToDesktop(message) {
    try {
        const logPath = path_1.default.join(electron_1.app.getPath('documents'), 'cracked_oura_electron_debug.log');
        const stats = fs_1.default.statSync(logPath, { throwIfNoEntry: false });
        if (stats && stats.size > MAX_LOG_BYTES) {
            fs_1.default.truncateSync(logPath, 0);
            fs_1.default.appendFileSync(logPath, `[${new Date().toISOString()}] (log truncated: exceeded ${MAX_LOG_BYTES} bytes)\n`);
        }
        const timestamp = new Date().toISOString();
        fs_1.default.appendFileSync(logPath, `[${timestamp}] ${message}\n`);
    }
    catch (e) {
        console.error("Failed to write to log file", e);
    }
}
/** Show the dashboard window, creating it first if it does not exist yet
 *  (e.g. macOS `activate` can fire before `ready` has created it, or after `closed`). */
function showOrCreateWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        return;
    }
    createWindow();
}
function createTray() {
    // We are in shell/electron/main.ts (compiled to dist-electron/main.js)
    // So __dirname is shell/dist-electron
    // We need to go up to shell/public
    const iconPath = isDev
        ? path_1.default.join(__dirname, '../public/icon.png')
        : path_1.default.join(__dirname, '../dist/icon.png');
    console.log("Attempting to load Tray icon from:", iconPath);
    // Use a simple icon or fallback
    let icon = electron_1.nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
        console.error("Tray icon is EMPTY/MISSING at", iconPath);
        // Try to resize it if it's an SVG? Or maybe it just failed to load.
    }
    else {
        console.log("Tray icon loaded successfully. Size:", icon.getSize());
        // Resize for macOS tray (usually 16x16 or 22x22)
        icon = icon.resize({ width: 22, height: 22 });
    }
    tray = new electron_1.Tray(icon);
    tray.setToolTip('Cracked Oura');
    const contextMenu = electron_1.Menu.buildFromTemplate([
        {
            label: 'Open Dashboard',
            click: showOrCreateWindow
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                isQuitting = true;
                electron_1.app.quit();
            }
        }
    ]);
    tray.setContextMenu(contextMenu);
    tray.on('double-click', showOrCreateWindow);
}
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1280,
        height: 800,
        webPreferences: {
            // The renderer is a plain web app: it never touches Node APIs, so run it
            // fully isolated. (Verified: frontend/src has no require/process/window.electron.)
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
        backgroundColor: '#0f1115', // Match our dark theme
        show: false, // Don't show until ready
        title: 'Cracked Oura',
    });
    const devUrl = 'http://localhost:5173';
    const prodPath = path_1.default.join(__dirname, '../dist/index.html');
    if (isDev) {
        logToDesktop(`Loading DEV URL: ${devUrl}`);
        mainWindow.loadURL(devUrl);
        // mainWindow.webContents.openDevTools();
    }
    else {
        logToDesktop(`Loading PROD File: ${prodPath}`);
        mainWindow.loadFile(prodPath).catch(err => {
            logToDesktop(`FAILED to load file: ${errorMessage(err)}`);
        });
    }
    mainWindow.once('ready-to-show', () => {
        logToDesktop("Window ready to show");
        mainWindow?.show();
    });
    // Debug Renderer Crashes
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        logToDesktop(`PAGE LOAD FAILED: ${errorCode} - ${errorDescription}`);
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        logToDesktop(`Renderer Process GONE. Reason: ${details.reason}`);
    });
    // HIDE instead of close
    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow?.hide();
            return false;
        }
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}
function getPythonPath() {
    if (!isDev) {
        // Production: Backend is bundled inside the app
        // In macOS .app: Contents/Resources/backend/backend
        // In Windows/Linux: resources/backend/backend(.exe)
        const possiblePath = path_1.default.join(process.resourcesPath, 'backend', 'backend');
        // On Windows it might have .exe extension, but child_process.spawn handles it if we don't specify extension?
        // Best to check specific platform or try specific paths.
        if (process.platform === 'win32') {
            return path_1.default.join(process.resourcesPath, 'backend', 'backend.exe');
        }
        return possiblePath;
    }
    // Development: Use local venv
    // Check standard locations
    const venvRoot = path_1.default.join(__dirname, '../../backend/venv');
    const binPath = path_1.default.join(venvRoot, 'bin', 'python'); // Mac/Linux
    const scriptsPath = path_1.default.join(venvRoot, 'Scripts', 'python.exe'); // Windows
    // We can't easily check file existence synchronously in specific setups without 'fs',
    // but we can try to rely on platform.
    if (process.platform === 'win32') {
        return scriptsPath;
    }
    return binPath;
}
/** One GET of /api/health. Our backend answers 200 with a JSON body. */
function probeBackendHealth() {
    return new Promise(resolve => {
        const req = http_1.default.get(BACKEND_HEALTH_URL, { timeout: 2000 }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    resolve({ kind: 'foreign', detail: `HTTP ${res.statusCode}` });
                    return;
                }
                try {
                    JSON.parse(body);
                    resolve({ kind: 'ok' });
                }
                catch {
                    resolve({ kind: 'foreign', detail: `non-JSON body: ${body.slice(0, 120)}` });
                }
            });
        });
        req.on('timeout', () => {
            req.destroy();
            resolve({ kind: 'down' });
        });
        req.on('error', () => resolve({ kind: 'down' }));
    });
}
/**
 * Poll the backend's health endpoint until it is ready (or we time out). The window is
 * created regardless - this only logs readiness and flags a port conflict clearly.
 */
async function waitForBackend() {
    const startedAt = Date.now();
    let warnedForeign = false;
    while (Date.now() - startedAt < BACKEND_READY_TIMEOUT_MS) {
        const probe = await probeBackendHealth();
        if (probe.kind === 'ok') {
            logToDesktop(`Backend is healthy at ${BACKEND_HEALTH_URL} (after ${Date.now() - startedAt} ms)`);
            return true;
        }
        if (probe.kind === 'foreign' && !warnedForeign) {
            warnedForeign = true;
            logToDesktop(`ERROR: port ${BACKEND_PORT} is answering but does not look like the Cracked Oura backend ` +
                `(${probe.detail}). Another process is probably using the port; the dashboard will not work ` +
                `until it is stopped.`);
        }
        await new Promise(resolve => setTimeout(resolve, BACKEND_POLL_INTERVAL_MS));
    }
    logToDesktop(`ERROR: backend did not become healthy within ${BACKEND_READY_TIMEOUT_MS / 1000} s`);
    return false;
}
// ---------------------------------------------------------------------------
// Backend process
// ---------------------------------------------------------------------------
function startPythonBackend() {
    const exePath = getPythonPath();
    console.log('Starting Backend from:', exePath);
    logToDesktop(`Attempting to start backend from: ${exePath}`);
    if (isDev) {
        logToDesktop("Running in DEV mode");
        // Run with uvicorn via python -m. On POSIX, start it in its own process group so
        // that the --reload supervisor AND its worker child can be killed together on quit.
        backendDetached = process.platform !== 'win32';
        pythonProcess = (0, child_process_1.spawn)(exePath, [
            '-m', 'uvicorn',
            'backend.src.api.main:app',
            '--host', '127.0.0.1',
            '--port', String(BACKEND_PORT),
            '--reload'
        ], {
            cwd: path_1.default.join(__dirname, '../../'),
            stdio: 'inherit',
            detached: backendDetached
        });
    }
    else {
        logToDesktop("Running in PROD mode");
        // Production: Run the compiled executable directly
        if (!fs_1.default.existsSync(exePath)) {
            logToDesktop(`CRITICAL ERROR: Backend executable NOT FOUND at ${exePath}`);
        }
        else {
            logToDesktop(`Backend executable confirmed at ${exePath}`);
        }
        try {
            // It starts uvicorn internally (if main.py calls uvicorn.run)
            pythonProcess = (0, child_process_1.spawn)(exePath, [], {
                cwd: path_1.default.dirname(exePath), // Run from its own directory to find dependencies/relative files
                stdio: ['ignore', 'pipe', 'pipe'], // Capture stdout/stderr
                env: { ...process.env, PORT: String(BACKEND_PORT) } // Pass port if needed
            });
            logToDesktop(`Backend process spawned with PID: ${pythonProcess ? pythonProcess.pid : 'NULL'}`);
        }
        catch (spawnError) {
            logToDesktop(`CRITICAL SPAWN ERROR: ${errorMessage(spawnError)}`);
        }
    }
    if (pythonProcess) {
        // Capture Standard Output
        if (pythonProcess.stdout) {
            pythonProcess.stdout.on('data', (data) => {
                logToDesktop(`[STDOUT] ${data.toString().trim()}`);
            });
        }
        // Capture Standard Error (Critical for startup crashes)
        if (pythonProcess.stderr) {
            pythonProcess.stderr.on('data', (data) => {
                logToDesktop(`[STDERR] ${data.toString().trim()}`);
            });
        }
        pythonProcess.on('error', (err) => {
            console.error('Failed to start Python backend:', err);
            logToDesktop(`Backend Process ERROR: ${err.message}`);
        });
        pythonProcess.on('close', (code) => {
            console.log(`Python backend exited with code ${code}`);
            logToDesktop(`Backend Process EXITED with code: ${code}`);
        });
    }
    else {
        logToDesktop("pythonProcess is undefined after attempt!");
    }
}
function stopPythonBackend() {
    if (!pythonProcess)
        return;
    const pid = pythonProcess.pid;
    try {
        pythonProcess.kill();
    }
    catch (err) {
        logToDesktop(`Failed to kill backend process: ${errorMessage(err)}`);
    }
    // Only a detached child is its own group leader; killing -pid on a non-detached child
    // would signal Electron's own process group.
    if (backendDetached && pid && process.platform !== 'win32') {
        try {
            process.kill(-pid, 'SIGTERM');
            logToDesktop(`Sent SIGTERM to backend process group ${pid}`);
        }
        catch (err) {
            // ESRCH: the group is already gone - nothing to do.
            logToDesktop(`Backend process group ${pid} not signalled: ${errorMessage(err)}`);
        }
    }
    pythonProcess = null;
}
// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
electron_1.app.on('ready', () => {
    startPythonBackend();
    // Create the window immediately; the renderer retries its own requests while the
    // backend comes up. Readiness (or a port conflict) is logged in the background.
    createWindow();
    createTray();
    waitForBackend().catch(err => logToDesktop(`waitForBackend failed: ${errorMessage(err)}`));
});
electron_1.app.on('window-all-closed', () => {
    // Do NOT quit. We want to stay alive in the tray.
    if (process.platform !== 'darwin') {
        // On Windows/Linux we might want to quit if tray is not used,
        // but here we ARE using tray, so we stay alive.
        // app.quit();
    }
});
electron_1.app.on('activate', showOrCreateWindow);
electron_1.app.on('before-quit', () => {
    isQuitting = true;
});
electron_1.app.on('will-quit', () => {
    stopPythonBackend();
});
