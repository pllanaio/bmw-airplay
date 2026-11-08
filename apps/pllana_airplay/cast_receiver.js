'use strict';
// Receiver for the PllanaCast for BMW Android app: the phone's screen (H.264) and
// sound (PCM) over the local WLAN or the phone hotspot, for Android phones
// without Miracast/DLNA mirroring (e.g. Pixel, where "Cast" is Google Cast).
//
// TCP 7104, private IPv4 peers only, one phone at a time, only while
// reception is on. The phone proves it knows the code shown on the iDrive
// display (HMAC-SHA256 over a fresh nonce) before any media is accepted.
// Media is then piped unchanged to the native mgu-cast-receiver, which never
// touches the network.
const EventEmitter = require('events');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { frameHeader } = require('./receiver');
const { privatePeer } = require('./dlna_renderer');

const PORT = 7104, PROTOCOL = 'pllana-cast/1';
const HANDSHAKE_MS = 15000, IDLE_MS = 10000, MAX_FAILURES = 5, FAILURE_WINDOW_MS = 60000;

function proof(code, nonce) { return crypto.createHmac('sha256', String(code)).update(nonce).digest('hex'); }
function equal(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class CastReceiver extends EventEmitter {
    constructor(options) {
        super();
        this.options = options || {};
        this.spawn = this.options.spawn || childProcess.spawn;
        this.runtime = this.options.runtime;
        this.dataDir = this.options.dataDir;
        this.port = this.options.port === undefined ? PORT : this.options.port;
        this.code = this.options.code || (() => '');
        this.name = this.options.name || 'PllanaCast for BMW';
        this.server = null; this.running = false; this.session = null; this.serial = 0; this.failures = new Map();
    }
    available() {
        if (this.options.skipRuntimeCheck) return true;
        return ['bin/airplay-launch', 'lib/ld-linux-x86-64.so.2', 'bin/mgu-cast-receiver'].every(p => fs.existsSync(path.join(this.runtime, p)));
    }
    start() {
        if (this.running) return Promise.resolve();
        this.running = true;
        return new Promise(resolve => {
            const server = net.createServer(socket => this.accept(socket));
            this.server = server;
            server.on('error', () => { this.emit('diagnostic', 'cast_port_unavailable'); resolve(); });
            server.listen(this.port, this.options.host || '0.0.0.0', () => { if (!this.port) this.port = server.address().port; resolve(); });
        });
    }
    stop() {
        if (!this.running) return Promise.resolve();
        this.running = false;
        const server = this.server; this.server = null;
        if (server) server.close();
        return this.endSession('stopped');
    }
    presentation() {
        const s = this.session;
        if (!s || !s.child) return null;
        return { device: s.device, frame: s.frame, file: s.file, audio: s.audio, error: null };
    }
    rateLimited(address) {
        const now = Date.now(), list = (this.failures.get(address) || []).filter(t => now - t < FAILURE_WINDOW_MS);
        this.failures.set(address, list);
        return list.length >= MAX_FAILURES;
    }
    accept(socket) {
        const address = String(socket.remoteAddress || '').replace(/^::ffff:/i, '');
        if (!this.running || !privatePeer(address, this.options.allowLoopback)) { socket.destroy(); return; }
        socket.setNoDelay(true);
        socket.on('error', () => {});
        const reply = (fields, close) => {
            if (socket.destroyed) return;
            socket.write(JSON.stringify(fields) + '\n');
            if (close) socket.end();
        };
        if (this.rateLimited(address)) { reply({ ok: false, error: 'too_many_attempts' }, true); return; }
        const nonce = crypto.randomBytes(16).toString('hex');
        reply({ proto: PROTOCOL, name: this.name, nonce });
        let pending = Buffer.alloc(0), done = false;
        const deadline = setTimeout(() => { if (!done) socket.destroy(); }, HANDSHAKE_MS);
        const onData = chunk => {
            pending = Buffer.concat([pending, chunk]);
            const at = pending.indexOf(10);
            if (at < 0) { if (pending.length > 4096) socket.destroy(); return; }
            done = true; clearTimeout(deadline); socket.removeListener('data', onData);
            let hello = null;
            try { hello = JSON.parse(pending.slice(0, at).toString('utf8')); } catch (e) { hello = null; }
            const rest = pending.slice(at + 1);
            if (!hello || hello.proto !== PROTOCOL || typeof hello.auth !== 'string') { reply({ ok: false, error: 'protocol' }, true); return; }
            const code = String(this.code() || '');
            if (!/^[0-9]{4,8}$/.test(code)) { reply({ ok: false, error: 'not_ready' }, true); return; }
            if (!equal(hello.auth.toLowerCase(), proof(code, nonce))) {
                this.failures.get(address).push(Date.now());
                this.emit('diagnostic', 'cast_code_rejected');
                reply({ ok: false, error: 'code_wrong' }, true); return;
            }
            if (this.session) { reply({ ok: false, error: 'busy' }, true); return; }
            const device = typeof hello.device === 'string' ? Array.from(hello.device.replace(/[\x00-\x1f\x7f]/g, '')).slice(0, 40).join('') : '';
            if (!this.begin(socket, device, hello.audio === true)) { reply({ ok: false, error: 'receiver_unavailable' }, true); return; }
            reply({ ok: true });
            if (rest.length) this.forward(rest);
        };
        socket.on('data', onData);
        socket.on('close', () => clearTimeout(deadline));
    }
    begin(socket, device, audio) {
        if (!this.available()) return false;
        const uid = process.getuid ? process.getuid() : 0;
        const file = '/dev/shm/mgu-video-cast-' + uid + '-' + process.pid + '-' + (++this.serial);
        const env = Object.assign({}, process.env, {
            HOME: this.dataDir, XDG_CACHE_HOME: this.dataDir,
            GST_PLUGIN_SYSTEM_PATH_1_0: '', GST_PLUGIN_PATH_1_0: path.join(this.runtime, 'plugins'),
            GST_REGISTRY: path.join(this.dataDir, 'gst-cast-registry.bin'), GST_REGISTRY_FORK: 'no',
            LD_LIBRARY_PATH: path.join(this.runtime, 'lib'), GST_DEBUG: '1', GST_DEBUG_NO_COLOR: '1',
            ALSA_PLUGIN_DIR: '/usr/lib/alsa-lib', MGU_HLS_AUDIO_SINK: this.options.audioSink || 'fakesink',
        });
        const args = [path.join(this.runtime, 'lib/ld-linux-x86-64.so.2'), '--library-path', path.join(this.runtime, 'lib'),
            path.join(this.runtime, 'bin/mgu-cast-receiver'), 'mguvideosink location=' + file, audio ? 'audio' : 'noaudio'];
        let child;
        try { child = this.spawn(path.join(this.runtime, 'bin/airplay-launch'), args, { env, cwd: this.dataDir, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
        catch (e) { this.emit('diagnostic', 'cast_launch_failed'); return false; }
        const session = { socket, child, device, audio, file, frame: null, lastFrame: '', poll: null, idle: null, ended: false };
        this.session = session;
        if (child.stdin && child.stdin.on) child.stdin.on('error', () => {});
        if (child.stderr) child.stderr.on('data', () => {});
        let output = '';
        if (child.stdout) child.stdout.on('data', chunk => {
            output = (output + String(chunk)).slice(-4096);
            let at;
            while ((at = output.indexOf('\n')) >= 0) {
                const line = output.slice(0, at).trim(); output = output.slice(at + 1);
                const error = /^MGU_CAST error ([a-z_]{1,32})$/.exec(line);
                if (error) this.emit('diagnostic', 'cast_' + error[1]);
            }
        });
        child.once('error', () => { if (!child.pid) this.endSession('launch_failed'); });
        child.once('close', () => { session.child = null; this.endSession('receiver_ended'); });
        socket.on('data', chunk => this.forward(chunk));
        socket.on('close', () => this.endSession('phone_disconnected'));
        const touch = () => { clearTimeout(session.idle); session.idle = setTimeout(() => this.endSession('phone_timeout'), IDLE_MS); };
        socket.on('data', touch); touch();
        // Once a second: what the car shows, displayed in the phone app.
        session.status = setInterval(() => {
            if (socket.destroyed) return;
            const f = session.frame;
            try { socket.write(JSON.stringify({ type: 'status', shown: f ? f.sequence : 0, width: f ? f.width : 0, height: f ? f.height : 0 }) + '\n'); } catch (e) {}
        }, 1000);
        session.poll = setInterval(() => {
            const frame = frameHeader(file);
            const key = frame && [frame.generation, frame.sequence, frame.width, frame.height].join(':');
            if (frame && frame.sequence && key !== session.lastFrame) { session.lastFrame = key; session.frame = frame; this.publish(); }
        }, 100);
        this.emit('diagnostic', 'cast_connected');
        this.publish();
        return true;
    }
    forward(chunk) {
        const s = this.session;
        if (!s || !s.child || !s.child.stdin || s.child.stdin.destroyed) return;
        // Backpressure: the phone pauses (and its encoder drops frames)
        // while the decoder catches up.
        if (!s.child.stdin.write(chunk) && s.socket.pause) {
            s.socket.pause();
            s.child.stdin.once('drain', () => { if (this.session === s && s.socket.resume) s.socket.resume(); });
        }
    }
    endSession(reason) {
        const s = this.session;
        if (!s || s.ended) return Promise.resolve();
        s.ended = true; this.session = null;
        clearInterval(s.poll); clearInterval(s.status); clearTimeout(s.idle);
        if (s.socket && !s.socket.destroyed) {
            if (reason === 'stopped' || reason === 'ended_by_driver') try { s.socket.end(JSON.stringify({ type: 'stop' }) + '\n'); } catch (e) {}
            setTimeout(() => { if (!s.socket.destroyed) s.socket.destroy(); }, 500);
        }
        this.emit('diagnostic', 'cast_' + reason);
        this.publish();
        const child = s.child;
        const cleanup = () => {
            try { const st = fs.lstatSync(s.file); if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1) fs.unlinkSync(s.file); } catch (e) {}
        };
        if (!child) { cleanup(); return Promise.resolve(); }
        return new Promise(resolve => {
            let finished = false;
            const finish = () => { if (finished) return; finished = true; clearTimeout(kill); cleanup(); resolve(); };
            const signal = name => { try { process.kill(-child.pid, name); } catch (e) { try { child.kill(name); } catch (ignore) {} } };
            const kill = setTimeout(() => { signal('SIGKILL'); setTimeout(finish, 200); }, 2000);
            child.once('close', finish);
            try { child.stdin.end(); } catch (e) {}
            signal('SIGTERM');
        });
    }
    // "Video beenden" / "Zur Spiegelung" from the car.
    stopSession() { return this.endSession('ended_by_driver'); }
    publish() { this.emit('state', this.presentation()); }
}
module.exports = { CastReceiver, proof, PORT, PROTOCOL };
