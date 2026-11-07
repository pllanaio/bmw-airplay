'use strict';
process.title = 'mgu-airplay';
const resolver = require('./resolver');
resolver.refresh();
setInterval(() => resolver.refresh(), 2000).unref();
const fs = require('fs'), net = require('net'), path = require('path');
const { Receiver } = require('./receiver');
const { AudioRoute, AUDIO_SINK } = require('./audio_route');
const signals = require('./kit/signals');
const root = path.resolve(__dirname, '..', '..');
const data = path.join(root, 'data', 'airplay');
if (!fs.existsSync(data)) fs.mkdirSync(data, 0o700);
const socketPath = path.join(data, 'control.sock');
if (fs.existsSync(socketPath)) {
    const s = fs.lstatSync(socketPath);
    if (!s.isSocket() || s.uid !== process.getuid()) throw Error('invalid_control_socket');
    fs.unlinkSync(socketPath);
}
const receiver = new Receiver({ dataDir: data, runtime: process.env.MGU_AIRPLAY_RUNTIME || '/var/opt/mgu-airplay/current/runtime', audioSink: AUDIO_SINK, authentication: 'password' });
const diagnostics = [];
receiver.on('diagnostic', code => {
    diagnostics.push({ time: new Date().toISOString(), code });
    if (diagnostics.length > 60) diagnostics.shift();
    try { fs.writeFileSync(path.join(data, 'diagnostic.json'), JSON.stringify(diagnostics), { mode: 0o600 }); } catch (e) {}
});
const route = new AudioRoute(signals);
// A frontend that disappears (app manager restart, stalled event loop, HMI
// focus change) no longer ends the phone's AirPlay session immediately. Only
// an explicit stop/close does; otherwise the receiver keeps running for a
// grace period and a reconnecting frontend simply resumes it.
const DISCONNECT_GRACE_MS = 30000, HEARTBEAT_TIMEOUT_MS = 12000;
// An unexpected receiver exit (native crash after a failed media download,
// pipeline error) restarts it with the same password and backoff.
const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000, 15000], STABLE_MS = 60000;
let queue = Promise.resolve(), client = null, heartbeat = 0, shuttingDown = false, intentionalStop = false, checking = false;
let wanted = false, graceTimer = null, restartTimer = null, stableTimer = null, failures = 0;
const enqueue = fn => { queue = queue.then(fn, fn).catch(() => send({ phase: 'error', error: 'backend_operation_failed', pin: '', frame: null })); return queue; };
async function ensureAudio() {
    if (!receiver.child || !client || shuttingDown || route.owned) return;
    try { await route.acquire(); receiver.update({ audio: true, audioError: null }); }
    catch (e) { receiver.update({ audio: false, audioError: 'audio_unavailable' }); }
}
receiver.on('media', () => enqueue(ensureAudio));
function send(state) {
    if (client && !client.destroyed) {
        if (client.writableLength > 32768) { client.destroy(); return; }
        client.write(JSON.stringify({ state: state || receiver.state }) + '\n');
    }
}
async function stop() {
    wanted = false; failures = 0;
    clearTimeout(graceTimer); clearTimeout(restartTimer); clearTimeout(stableTimer);
    graceTimer = restartTimer = stableTimer = null;
    intentionalStop = true;
    try { await receiver.stop(); await route.release(); }
    finally { intentionalStop = false; }
}
function startReceiver(keepPassword) {
    clearTimeout(restartTimer); restartTimer = null;
    if (!receiver.start(keepPassword ? { keepPassword: true } : undefined)) return false;
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => { stableTimer = null; if (receiver.child) failures = 0; }, STABLE_MS);
    receiver.update({ audio: false });
    return true;
}
function scheduleRestart() {
    if (!wanted || shuttingDown || restartTimer) return;
    const delay = RESTART_DELAYS_MS[Math.min(failures, RESTART_DELAYS_MS.length - 1)];
    failures++;
    receiver.emit('diagnostic', 'receiver_restart_' + failures);
    receiver.update({ phase: 'recovering', error: 'receiver_recovering' });
    restartTimer = setTimeout(() => enqueue(async () => {
        restartTimer = null;
        if (!wanted || shuttingDown || receiver.child) return;
        if (startReceiver(true)) await ensureAudio();
        else scheduleRestart();
    }), delay);
}
receiver.on('state', send);
receiver.on('ended', () => {
    if (intentionalStop) return;
    enqueue(() => route.release());
    const error = receiver.state.error;
    if (error !== 'runtime_missing' && error !== 'audio_not_configured') scheduleRestart();
});
const server = net.createServer(s => {
    if (client && !client.destroyed) { s.destroy(); return; }
    clearTimeout(graceTimer); graceTimer = null;
    client = s; heartbeat = Date.now(); s.setEncoding('utf8'); let pending = '';
    send();
    s.on('data', chunk => {
        pending += chunk;
        if (pending.length > 8192) { s.destroy(); return; }
        let at;
        while ((at = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, at); pending = pending.slice(at + 1);
            let request; try { request = JSON.parse(line); } catch (e) { s.destroy(); return; }
            if (!request || typeof request.command !== 'string') { s.destroy(); return; }
            heartbeat = Date.now();
            if (request.command === 'start') enqueue(async () => {
                if (shuttingDown) return;
                if (receiver.child) { wanted = true; await ensureAudio(); return; }
                if (s !== client || s.destroyed) return;
                // A manual start during a pending recovery starts at once and
                // keeps the password the phone already knows.
                const recovering = !!restartTimer;
                failures = 0;
                // Discovery and pairing must work even while another BMW
                // source owns the speaker route. Retry audio on media/start.
                if (startReceiver(recovering)) {
                    wanted = true;
                    await ensureAudio();
                }
            });
            else if (request.command === 'stop') enqueue(stop);
            else if (request.command !== 'heartbeat') { s.destroy(); return; }
        }
    });
    s.on('close', () => {
        if (client !== s) return;
        client = null;
        if (!receiver.child && !restartTimer) { enqueue(stop); return; }
        clearTimeout(graceTimer);
        graceTimer = setTimeout(() => { graceTimer = null; if (!client) enqueue(stop); }, DISCONNECT_GRACE_MS);
    });
    s.on('error', () => {});
});
server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
server.on('error', () => shutdown());
const timer = setInterval(() => {
    if (client && Date.now() - heartbeat > HEARTBEAT_TIMEOUT_MS) client.destroy();
    if (receiver.child && !checking && !shuttingDown) {
        checking = true;
        enqueue(async () => {
            try {
                if (!receiver.child || shuttingDown) return;
                if (route.owned && !await route.check()) {
                    await route.release();
                    receiver.update({ audio: false, audioError: 'audio_unavailable' });
                }
            } finally { checking = false; }
        });
    }
}, 2000);
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true; clearInterval(timer); clearTimeout(graceTimer); clearTimeout(restartTimer); clearTimeout(stableTimer);
    if (client) client.destroy();
    server.close();
    const hard = setTimeout(() => process.exit(1), 12000);
    enqueue(stop).then(() => {
        clearTimeout(hard);
        try { fs.unlinkSync(socketPath); } catch (e) {}
        process.exit(0);
    });
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
process.on('exit', () => receiver.signal(receiver.child, 'SIGTERM'));
