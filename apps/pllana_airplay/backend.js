'use strict';
process.title = 'mgu-airplay';
const resolver = require('./resolver');
resolver.refresh();
setInterval(() => resolver.refresh(), 2000).unref();
const fs = require('fs'), net = require('net'), path = require('path'), childProcess = require('child_process');
const { Receiver, validVideoViewport } = require('./receiver');
const { MusicControls } = require('./music_controls');
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
const receiver = new Receiver({ dataDir: data, runtime: process.env.MGU_AIRPLAY_RUNTIME || (fs.existsSync('/var/opt/pllana-airplay-receiver/current/runtime') ? '/var/opt/pllana-airplay-receiver/current/runtime' : '/var/opt/mgu-airplay/current/runtime'), audioSink: AUDIO_SINK, authentication: 'password', hls: () => resolver.hasUplink() });
// Android: a DLNA/UPnP media renderer plays URLs from the phone through the
// same BMW video and audio path. It is announced only while reception is on.
const { MediaPlayer } = require('./media_player');
const { DlnaRenderer } = require('./dlna_renderer');
const player = new MediaPlayer({ runtime: receiver.runtime, dataDir: data, audioSink: AUDIO_SINK });
// PllanaCast for BMW app (e.g. Pixel phones, whose system "Cast" is Google Cast):
// screen and sound, authenticated with the code shown in the car.
const { CastReceiver, PORT: CAST_PORT } = require('./cast_receiver');
const screenCast = new CastReceiver({ runtime: receiver.runtime, dataDir: data, audioSink: AUDIO_SINK, code: () => receiver.state.pin || receiver.lastPassword });
const dlna = new DlnaRenderer({ player, dataDir: data, castPort: CAST_PORT });
const castPresentation = () => (wanted ? dlna.presentation() : null);
const mirrorPresentation = () => (wanted ? screenCast.presentation() : null);
const music = new MusicControls({
    directory: () => receiver.musicDirectory,
    resolveBinary: [path.join(receiver.runtime, 'lib/ld-linux-x86-64.so.2'), '--library-path', path.join(receiver.runtime, 'lib'), path.join(receiver.runtime, 'bin/mgu-dacp-resolve')],
    onState: remote => {
        if (!receiver.child || receiver.state.phase === 'stopping') return;
        const current = receiver.state.music || {};
        const next = Object.assign({}, current, remote);
        if (remote.epoch !== current.epoch) next.controlError = null;
        receiver.update({ music: next });
    },
});
let musicPolling = false, musicQueued = 0, musicQueue = Promise.resolve();
function pollMusic() {
    if (musicPolling || receiver.state.phase === 'stopping') return;
    musicPolling = true;
    Promise.resolve().then(() => music.poll()).catch(() => {}).then(() => { musicPolling = false; });
}
receiver.on('music-directory', () => { music.clear(); pollMusic(); });
function musicRequest(request) {
    const action = request.action, value = request.value;
    const transport = action === 'playPause' || action === 'next' || action === 'previous';
    return typeof request.epoch === 'string' && request.epoch.length > 0 && request.epoch.length <= 128 &&
        !/[\x00-\x1f\x7f]/.test(request.epoch) &&
        ((transport && (value === undefined || value === null)) ||
         (action === 'shuffle' && (value === 0 || value === 1)) ||
         (action === 'repeat' && Number.isInteger(value) && value >= 0 && value <= 2));
}
function controllableMedia(state) {
    return (state.mode === 'audio' && (state.phase === 'audio' || state.phase === 'waiting')) ||
        (state.mode === 'hls' && (state.phase === 'loading' || state.phase === 'mirroring')) ||
        (state.mode === 'waiting' && state.phase === 'waiting' && state.connected === true &&
            state.playlistPending === true && state.returnMode === 'waiting');
}
function currentMusicRequest(request) {
    const current = receiver.state.music;
    return wanted && !intentionalStop && receiver.child && receiver.state.phase !== 'stopping' &&
        controllableMedia(receiver.state) && current && current.epoch === request.epoch &&
        current.controls && current.controls[request.action] === true;
}
function musicError(code) {
    if (receiver.state.music) receiver.update({ music: Object.assign({}, receiver.state.music, { controlError: code }) });
}
function remoteMusic(request) {
    if (!currentMusicRequest(request)) { musicError('music_control_stale'); return; }
    if (musicQueued >= 4) { musicError('music_control_busy'); return; }
    musicQueued++;
    const run = async () => {
        if (shuttingDown || !currentMusicRequest(request)) { musicQueued--; return; }
        const directory = receiver.musicDirectory;
        let timeout;
        try {
            // Even a broken remote endpoint cannot hold up stop/close and
            // subsequent commands indefinitely. The module also bounds I/O.
            await Promise.race([
                music.execute(request.action, request.value, request.epoch),
                new Promise((resolve, reject) => { timeout = setTimeout(() => reject(Error('music_timeout')), 5500); }),
            ]);
            if (directory === receiver.musicDirectory && currentMusicRequest(request)) musicError(null);
        } catch (e) {
            if (directory === receiver.musicDirectory && currentMusicRequest(request)) musicError('music_control_failed');
        } finally { clearTimeout(timeout); musicQueued--; }
    };
    // Remote phone requests have their own serialized queue. A slow phone
    // must never delay the driver's receiver stop or a profile change.
    musicQueue = musicQueue.then(run, run);
}
const diagnostics = [];
receiver.on('diagnostic', code => {
    diagnostics.push({ time: new Date().toISOString(), code });
    if (diagnostics.length > 60) diagnostics.shift();
    try { fs.writeFileSync(path.join(data, 'diagnostic.json'), JSON.stringify(diagnostics), { mode: 0o600 }); } catch (e) {}
});
// Inspect fixed local firmware definitions once, outside the receiver's queue.
// The child writes its detailed report only to private app storage; its output
// never enters UI state or diagnostics, and failure cannot delay AirPlay.
let reportChild = null;
function inspectBmwMediaOnce() {
    let child, timeout, finished = false;
    const finish = ok => {
        if (finished) return;
        finished = true; clearTimeout(timeout);
        if (reportChild === child) reportChild = null;
        receiver.emit('diagnostic', ok ? 'bmw_contract_report_saved' : 'bmw_contract_report_failed');
    };
    try {
        child = childProcess.spawn(process.execPath, [path.join(__dirname, 'inspect_bmw_contracts.js'), '--output-dir', data],
            { cwd: __dirname, stdio: ['ignore', 'ignore', 'ignore'] });
        reportChild = child;
        timeout = setTimeout(() => {
            finish(false);
            try { child.kill('SIGKILL'); } catch (e) {}
        }, 5000);
        if (timeout && timeout.unref) timeout.unref();
        child.once('error', () => finish(false));
        child.once('close', code => finish(code === 0));
    } catch (e) { finish(false); }
}
inspectBmwMediaOnce();
const route = new AudioRoute(signals);
// A frontend that disappears (app manager restart, stalled event loop, HMI
// focus change) no longer ends the phone's AirPlay session immediately. Only
// an explicit stop/close does. Video has a grace period; detected standalone
// audio survives a UI restart or leaving the app until explicit stop.
const DISCONNECT_GRACE_MS = 30000, HEARTBEAT_TIMEOUT_MS = 12000;
// An unexpected receiver exit (native crash after a failed media download,
// pipeline error) restarts it with the same password and backoff.
const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000, 15000], STABLE_MS = 60000;
let queue = Promise.resolve(), client = null, heartbeat = 0, shuttingDown = false, intentionalStop = 0, checking = false;
let wanted = false, graceTimer = null, restartTimer = null, stableTimer = null, failures = 0;
let selectedProfile = 'auto', selectedViewport, standaloneAudio = false, operationEpoch = 0, priorityStopping = null;
const enqueue = fn => { queue = queue.then(fn, fn).catch(() => send({ phase: 'error', error: 'backend_operation_failed', pin: '', frame: null })); return queue; };
const persistsWithoutUI = () => selectedProfile === 'audio' || (selectedProfile === 'auto' && standaloneAudio) ||
    !!(castPresentation() && castPresentation().media === 'audio');
// The state the frontend sees: an active Android (DLNA) playback takes the
// screen and the music view; otherwise the AirPlay receiver's own state.
function presented() {
    const base = receiver.state, mirror = mirrorPresentation();
    if (mirror) return Object.assign({}, base, { connected: true, sender: 'android', origin: 'android', mode: 'mirror',
        phase: mirror.frame ? 'mirroring' : 'loading', file: mirror.file, frame: mirror.frame, returnMode: 'waiting', playlistPending: false,
        detached: false, music: null, error: null, device: mirror.device });
    const cast = castPresentation();
    if (!cast) return base;
    const fields = { connected: true, sender: 'android', origin: 'android', playlistPending: false, detached: false, error: cast.error ? 'media_failed' : null };
    if (cast.media === 'audio') Object.assign(fields, {
        phase: cast.transport === 'PLAYING' ? 'audio' : 'waiting', mode: 'audio', frame: null,
        music: { epoch: cast.epoch, title: cast.title, artist: cast.artist, album: cast.album, artwork: null, metadata: null,
            playbackState: cast.transport === 'PLAYING' ? 'playing' : cast.transport === 'PAUSED_PLAYBACK' ? 'paused' : 'unknown', shuffle: null, repeat: null,
            controls: { playPause: true, next: cast.next, previous: false, shuffle: false, repeat: false } } });
    else Object.assign(fields, { phase: cast.frame ? 'mirroring' : 'loading', mode: 'hls', file: cast.file, frame: cast.frame,
        returnMode: base.mode === 'mirror' ? 'mirror' : 'waiting', music: null });
    return Object.assign({}, base, fields);
}
async function ensureAudio() {
    if (!wanted || !receiver.child || (!client && !persistsWithoutUI()) || shuttingDown || intentionalStop || route.owned) return;
    const epoch = operationEpoch;
    try {
        await route.acquire();
        // Explicit stop can overtake an in-flight BMW audio acquisition.
        // Release any late grant before acknowledging that stop.
        if (epoch !== operationEpoch || !wanted || !receiver.child || intentionalStop) { await route.release(); return; }
        receiver.update({ audio: true, audioError: null });
    } catch (e) {
        if (epoch === operationEpoch && wanted && receiver.child) receiver.update({ audio: false, audioError: 'audio_unavailable' });
    }
}
receiver.on('media', () => enqueue(ensureAudio));
// Only the historical runtime needs this fallback. Origin-aware runtimes
// own phone controls and the return destination; never force their detach.
receiver.on('media', mode => {
    if (mode === 'hls' && !(receiver.features && (receiver.features.nativeDetach || receiver.features.videoModes || receiver.features.mediaStop)) &&
        receiver.state.returnMode === 'mirror' && !receiver.state.detached) receiver.detach();
});
function send(state) {
    if (client && !client.destroyed) {
        if (client.writableLength > 32768) { client.destroy(); return; }
        client.write(JSON.stringify({ state: state || presented() }) + '\n');
    }
}
function cancelReception() {
    operationEpoch++; standaloneAudio = false;
    wanted = false; failures = 0;
    clearTimeout(graceTimer); clearTimeout(restartTimer); clearTimeout(stableTimer);
    graceTimer = restartTimer = stableTimer = null;
    music.clear();
}
async function finishStop(priorOperations) {
    intentionalStop++;
    try {
        // Start closing native sockets immediately, even when a BMW audio
        // request is still pending in the ordinary operation queue.
        const native = Promise.resolve().then(() => receiver.stop()).then(() => null, error => error);
        // Android playback ends with the session; never blocks the stop.
        const cast = Promise.resolve().then(() => Promise.all([dlna.stop(), screenCast.stop()])).then(() => player.close()).catch(() => {});
        const cleanup = Promise.resolve(priorOperations).then(() => route.release()).then(() => null, error => error);
        const results = await Promise.all([native, cleanup, cast]);
        if (!results[1]) receiver.update({ audio: false });
        if (results[0] || results[1]) throw results[0] || results[1];
    } finally { intentionalStop--; }
}
function stop() {
    cancelReception(); return finishStop();
}
function priorityStop() {
    cancelReception();
    if (priorityStopping) return priorityStopping;
    const pending = finishStop(queue);
    priorityStopping = pending;
    // Later starts wait for cleanup; starts already queued carry an old
    // epoch and cannot resurrect the just-disconnected receiver.
    queue = pending.catch(() => {});
    const finished = () => { if (priorityStopping === pending) priorityStopping = null; };
    pending.then(finished, finished);
    return pending;
}
function replyStop(socket, id, operation) {
    if (id === undefined) { operation.catch(() => {}); return; }
    let timeout, replied = false;
    const reply = ok => {
        if (replied) return; replied = true; clearTimeout(timeout);
        if (socket.destroyed) return;
        if (socket.writableLength > 32768) { socket.destroy(); return; }
        const result = { command: 'stop', id, ok };
        if (!ok) result.error = 'receiver_stop_failed';
        socket.write(JSON.stringify({ reply: result }) + '\n');
    };
    timeout = setTimeout(() => reply(false), 10000);
    operation.then(() => reply(true), () => reply(false));
}
function startReceiver(keepPassword) {
    clearTimeout(restartTimer); restartTimer = null;
    resolver.refresh();
    if (!receiver.start({ profile: selectedProfile, viewport: selectedViewport, keepPassword: !!keepPassword })) return false;
    if (!dlna.running) {
        player.video = selectedProfile !== 'audio';
        if (selectedViewport) player.setViewport(selectedViewport.width, selectedViewport.height);
        dlna.start().catch(() => receiver.emit('diagnostic', 'dlna_start_failed'));
    }
    if (!screenCast.running && selectedProfile !== 'audio') screenCast.start().catch(() => receiver.emit('diagnostic', 'cast_start_failed'));
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
function graceWithoutUI() {
    if (client || !wanted || persistsWithoutUI()) {
        clearTimeout(graceTimer); graceTimer = null; return;
    }
    if (!graceTimer) graceTimer = setTimeout(() => {
        graceTimer = null; if (!client && !persistsWithoutUI()) priorityStop().catch(() => {});
    }, DISCONNECT_GRACE_MS);
}
receiver.on('state', state => {
    if (wanted && state.mode === 'audio') standaloneAudio = true;
    else if (wanted && (state.mode === 'mirror' || state.mode === 'hls')) standaloneAudio = false;
    graceWithoutUI(); send(presented());
});
let castAudioPending = false;
dlna.on('diagnostic', code => receiver.emit('diagnostic', code));
screenCast.on('diagnostic', code => receiver.emit('diagnostic', code));
const androidState = () => {
    const cast = castPresentation(), mirror = mirrorPresentation();
    if (((cast && cast.transport === 'PLAYING') || (mirror && mirror.audio)) && !route.owned && !castAudioPending) {
        castAudioPending = true;
        enqueue(() => { castAudioPending = false; return ensureAudio(); });
    }
    graceWithoutUI(); send(presented());
};
dlna.on('state', androidState);
screenCast.on('state', androidState);
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
        if (s !== client || s.destroyed) return;
        pending += chunk;
        if (pending.length > 8192) { s.destroy(); return; }
        let at;
        while ((at = pending.indexOf('\n')) >= 0) {
            if (s !== client || s.destroyed) return;
            const line = pending.slice(0, at); pending = pending.slice(at + 1);
            let request; try { request = JSON.parse(line); } catch (e) { s.destroy(); return; }
            if (!request || typeof request.command !== 'string') { s.destroy(); return; }
            heartbeat = Date.now();
            if (request.command === 'start') {
                const profile = request.profile === undefined ? 'auto' : request.profile;
                if (profile !== 'auto' && profile !== 'video' && profile !== 'audio') { s.destroy(); return; }
                if (request.viewport !== undefined) {
                    if (!request.viewport || !validVideoViewport(request.viewport.width, request.viewport.height)) { s.destroy(); return; }
                    selectedViewport = { width: request.viewport.width, height: request.viewport.height };
                    if (receiver.child) receiver.setVideoViewport(selectedViewport.width, selectedViewport.height);
                    player.setViewport(selectedViewport.width, selectedViewport.height);
                }
                let epoch = operationEpoch;
                enqueue(async () => {
                    if (shuttingDown || epoch !== operationEpoch) return;
                    if (s !== client || s.destroyed) return;
                    const interruptedStop = receiver.state.phase === 'stopping' || receiver.stoppingChild;
                    if (receiver.child && selectedProfile === profile && !interruptedStop) { wanted = true; await ensureAudio(); return; }
                    // A manual start during a pending recovery starts at once and
                    // keeps the password the phone already knows. Changing the
                    // advertised audio/video capabilities deliberately restarts
                    // the receiver too, retaining that same pairing password.
                    const switching = selectedProfile !== profile && (receiver.child || wanted || restartTimer);
                    const keepPassword = !!restartTimer || !!switching || !!interruptedStop;
                    if (switching || interruptedStop) { const stopped = stop(); epoch = operationEpoch; await stopped; }
                    if (shuttingDown || epoch !== operationEpoch || ((s !== client || s.destroyed) && profile !== 'audio')) return;
                    selectedProfile = profile;
                    if (profile === 'audio') { clearTimeout(graceTimer); graceTimer = null; }
                    failures = 0;
                    // Discovery and pairing must work even while another BMW
                    // source owns the speaker route. Retry audio on media/start.
                    if (startReceiver(keepPassword)) {
                        wanted = true;
                        await ensureAudio();
                    }
                });
            }
            else if (request.command === 'video-viewport') {
                if (!validVideoViewport(request.width, request.height)) { s.destroy(); return; }
                selectedViewport = { width: request.width, height: request.height };
                receiver.setVideoViewport(request.width, request.height);
                player.setViewport(request.width, request.height);
            }
            else if (request.command === 'stop') {
                if (request.id !== undefined && (typeof request.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(request.id))) { s.destroy(); return; }
                replyStop(s, request.id, priorityStop());
            }
            else if (request.command === 'end-video') { if (mirrorPresentation()) screenCast.stopSession(); else if (castPresentation()) dlna.stopPlayback(false); else receiver.endVideo(); }
            else if (request.command === 'resume-mirror') { if (mirrorPresentation()) screenCast.stopSession(); else if (castPresentation()) dlna.stopPlayback(false); else receiver.resumeMirror(); }
            else if (request.command === 'music-control') {
                if (!musicRequest(request)) { s.destroy(); return; }
                const cast = castPresentation();
                if (/^dlna-/.test(request.epoch)) {
                    // Android music: the renderer itself is the transport.
                    if (cast && cast.media === 'audio' && cast.epoch === request.epoch) {
                        if (request.action === 'playPause') dlna.togglePause();
                        else if (request.action === 'next' && cast.next) dlna.advance();
                    }
                } else remoteMusic(request);
            }
            else if (request.command !== 'heartbeat') { s.destroy(); return; }
        }
    });
    s.on('close', () => {
        if (client !== s) return;
        client = null;
        if (!receiver.child && !restartTimer && !intentionalStop) { priorityStop().catch(() => {}); return; }
        graceWithoutUI();
    });
    s.on('error', () => {});
});
// An app update (Store / mgu-deploy) moves the old app home, including this
// socket, to a trash folder and installs the new code. A backend that kept
// running would then listen on the moved socket while the new frontend finds
// none ("Empfangsdienst startet ..."). Watch for that and restart, so the
// service manager starts the new backend code on a fresh socket.
const identity = p => { try { const s = fs.statSync(p); return s.dev + ':' + s.ino + ':' + s.mtime.getTime(); } catch (e) { return null; } };
let ownCode = identity(__filename), ownSocket = null;
server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); ownSocket = identity(socketPath); });
server.on('error', () => shutdown());
const timer = setInterval(() => {
    if (!shuttingDown && ownSocket && (identity(socketPath) !== ownSocket || identity(__filename) !== ownCode)) {
        receiver.emit('diagnostic', 'app_updated_restarting_backend');
        shutdown(75);
        return;
    }
    if (client && Date.now() - heartbeat > HEARTBEAT_TIMEOUT_MS) client.destroy();
    pollMusic();
    if (receiver.child && !checking && !shuttingDown) {
        checking = true;
        enqueue(async () => {
            try {
                if (!receiver.child || shuttingDown || intentionalStop || !wanted) return;
                if (route.owned && !await route.check()) {
                    await route.release();
                    receiver.update({ audio: false, audioError: 'audio_unavailable' });
                }
            } finally { checking = false; }
        });
    }
}, 2000);
// A non-zero code (app update) makes systemd start the backend again, also
// under the older unit's Restart=on-failure.
function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true; clearInterval(timer); clearTimeout(graceTimer); clearTimeout(restartTimer); clearTimeout(stableTimer);
    music.close();
    if (reportChild) { try { reportChild.kill('SIGKILL'); } catch (e) {} reportChild = null; }
    if (client) client.destroy();
    server.close();
    const hard = setTimeout(() => process.exit(1), 12000);
    priorityStop().then(() => {
        clearTimeout(hard);
        // Never delete a socket a newer backend already created at this path.
        try { if (identity(socketPath) === ownSocket) fs.unlinkSync(socketPath); } catch (e) {}
        process.exit(typeof code === 'number' ? code : 0);
    }, () => { clearTimeout(hard); process.exit(1); });
}
process.on('SIGTERM', () => shutdown()); process.on('SIGINT', () => shutdown());
process.on('exit', () => receiver.signal(receiver.child, 'SIGTERM'));
