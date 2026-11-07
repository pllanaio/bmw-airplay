'use strict';
const EventEmitter = require('events');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function frameHeader(file) {
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const st = fs.fstatSync(fd), b = Buffer.alloc(64);
        if (!st.isFile() || st.nlink !== 1 || fs.readSync(fd, b, 0, 64, 0) !== 64) return null;
        const w = b.readUInt32LE(8), h = b.readUInt32LE(12), slots = b.readUInt32LE(24);
        if (b.readUInt32LE(0) !== 0x4656474d || b.readUInt32LE(4) !== 1 ||
            w < 16 || h < 16 || w > 2048 || h > 2048 || (w & 1) || (h & 1) ||
            slots < 1 || slots > 4 || b.readUInt32LE(20) >= slots || st.size < 64 + slots * w * h * 3 / 2)
            return null;
        return { width: w, height: h, sequence: b.readUInt32LE(16), generation: st.dev + ':' + st.ino };
    } catch (e) { return null; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}

class Receiver extends EventEmitter {
    constructor(options) {
        super();
        this.options = options || {};
        this.spawn = this.options.spawn || childProcess.spawn;
        this.runtime = this.options.runtime || path.join(__dirname, 'runtime');
        this.dataDir = this.options.dataDir || process.cwd();
        this.child = null; this.stopTimer = null; this.poll = null; this.session = 0;
        this.stopPromise = null; this.closed = false;
        this.state = { phase: 'stopped', mode: null, pin: '', frame: null, file: '', audio: false, error: null };
    }
    update(fields) { Object.assign(this.state, fields); this.emit('state', Object.assign({}, this.state)); }
    // options.keepPassword: an automatic restart after a receiver failure keeps
    // the password the iPhone already knows, so it can reconnect at once.
    start(options) {
        if (this.closed || this.child || this.stopPromise) return false;
        const launcher = path.join(this.runtime, 'bin/airplay-launch');
        const loader = path.join(this.runtime, 'lib/ld-linux-x86-64.so.2');
        const uxplay = path.join(this.runtime, 'bin/uxplay');
        if (!this.options.skipRuntimeCheck && ![launcher, loader, uxplay].every(p => fs.existsSync(p))) {
            this.update({ phase: 'error', error: 'runtime_missing', pin: '' }); return false;
        }
        if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { mode: 0o700 });
        const token = crypto.randomBytes(4).readUInt32LE(0);
        const passwordMode = this.options.authentication === 'password';
        const reuse = options && options.keepPassword && passwordMode && /^[0-9]{6}$/.test(this.lastPassword || '');
        const pin = reuse ? this.lastPassword : String(passwordMode ? 100000 + token % 900000 : 1000 + token % 9000);
        if (passwordMode) this.lastPassword = pin;
        const identityFile = path.join(this.dataDir, 'identity.json');
        let device;
        if (fs.existsSync(identityFile)) {
            const st = fs.lstatSync(identityFile);
            if (!st.isFile() || st.isSymbolicLink() || st.size > 1024) throw Error('invalid_receiver_identity');
            device = JSON.parse(fs.readFileSync(identityFile, 'utf8')).device;
            if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(device)) throw Error('invalid_receiver_identity');
        } else {
            const mac = crypto.randomBytes(6); mac[0] = (mac[0] & 0xfc) | 2;
            device = Array.from(mac).map(v => ('0' + v.toString(16)).slice(-2)).join(':');
            fs.writeFileSync(identityFile, JSON.stringify({ device }), { mode: 0o600, flag: 'wx' });
        }
        const register = path.join(this.dataDir, 'trusted-clients');
        if (!fs.existsSync(register)) fs.writeFileSync(register, '', { mode: 0o600, flag: 'wx' });
        const uid = process.getuid ? process.getuid() : 0;
        const file = '/dev/shm/mgu-video-airplay-' + uid + '-' + process.pid + '-' + (++this.session);
        const audio = this.options.audioSink;
        if (!audio) { this.update({ phase: 'error', error: 'audio_not_configured' }); return false; }
        const access = passwordMode ? ['-pw', pin] : ['-pin', pin, '-reg', register];
        const args = [loader, '--library-path', path.join(this.runtime, 'lib'), uxplay,
            '-n', 'BMW AirPlay by pllana.io', '-nh', '-m', device].concat(access).concat(['-s', '1280x720@30', '-fps', '30',
            '-avdec', '-hls', '2', '-lang', '0', '-vs', 'mguvideosink location=' + file, '-as', audio, '-p', '7100']);
        const env = Object.assign({}, process.env, {
            HOME: this.dataDir, XDG_CACHE_HOME: this.dataDir,
            GST_PLUGIN_SYSTEM_PATH_1_0: '', GST_PLUGIN_PATH_1_0: path.join(this.runtime, 'plugins'),
            GST_REGISTRY: path.join(this.dataDir, 'gst-registry.bin'), GST_REGISTRY_FORK: 'no',
            LD_LIBRARY_PATH: path.join(this.runtime, 'lib'),
            GST_DEBUG: '2', GST_DEBUG_NO_COLOR: '1',
            // GStreamer 1.22 can select hlsdemux2 even for playbin2. It requires
            // a streams-aware context; the legacy player must use hlsdemux.
            GST_PLUGIN_FEATURE_RANK: 'hlsdemux2:0',
            ALSA_PLUGIN_DIR: '/usr/lib/alsa-lib', DNSSD_UDS_PATH: '/run/mdnsd/mdnsd_uds',
            MGU_HLS_AUDIO_SINK: audio,
            GIO_MODULE_DIR: path.join(this.runtime, 'gio'),
            G_TLS_CA_FILE: path.join(this.runtime, 'etc/ca-certificates.crt'),
            SSL_CERT_FILE: path.join(this.runtime, 'etc/ca-certificates.crt'),
        });
        // No shell or privilege changes; the receiver identity and trusted
        // pairing keys live only in the app's private data directory.
        let child;
        try { child = this.spawn(launcher, args, { env, cwd: this.dataDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (e) { this.update({ phase: 'error', error: 'launch_failed', pin: '' }); return false; }
        this.child = child; this.features = {};
        this.update({ phase: 'starting', detached: false, mode: 'mirror', returnMode: 'waiting', pin, file, frame: null, error: null, audioError: null, audio: audio !== 'fakesink' });
        // Node 8 has no ChildProcess "spawn" event. spawn() already returns
        // a pid on success; still handle its asynchronous error event below.
        if (child.pid) this.update({ phase: 'waiting' });
        let ended = false;
        const finish = (error) => {
            if (ended) return; ended = true;
            clearInterval(this.poll); clearTimeout(this.stopTimer);
            this.poll = null; this.stopTimer = null;
            if (this.child === child) this.child = null;
            try {
                const st = fs.lstatSync(file);
                if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.uid === uid) fs.unlinkSync(file);
            } catch (e) {}
            this.update({ phase: error ? 'error' : 'stopped', mode: null, pin: '', frame: null, file: '', error: error || null });
            this.emit('ended');
        };
        child.once('error', () => finish('launch_failed'));
        child.once('close', (code, signal) => {
            if (this.state.phase !== 'stopping') this.emit('diagnostic', 'receiver_exit_' + (signal || code));
            finish((code || signal) && this.state.phase !== 'stopping' ? 'receiver_failed' : null);
        });
        // UxPlay may include client names, addresses and PINs in output. Drain it without persisting it.
        let pendingLog = '', wasMirroring = false, blockedGeneration = null;
        const hideOldFrame = () => {
            const frame = frameHeader(file);
            blockedGeneration = frame && frame.generation;
        };
        const consume = chunk => {
            if (this.child !== child || this.state.phase === 'stopping') return;
            const s = String(chunk);
            if (/No DNS-SD Server|DNSServiceRegister.*failed|Failed to.*DNS.?SD/i.test(s))
                this.update({ error: 'discovery_failed' });
            pendingLog = (pendingLog + s).slice(-8192);
            let at;
            while ((at = pendingLog.indexOf('\n')) >= 0) {
                const line = pendingLog.slice(0, at).trim(); pendingLog = pendingLog.slice(at + 1);
                if (/^MGU_CRASH$|^\S+\([^)]*\)\s*\[0x[0-9a-f]+\]$|^\[0x[0-9a-f]+\]$|GStreamer error \((video|audio)\):|assertion|assert.*failed|critical|error|could not|failed|cannot|not found|not-linked|not-negotiated|streaming stopped|Forbidden/i.test(line)) {
                    // Bounded error text only. Never persist a stream URL, IP or
                    // the current pairing password in the diagnostic ring.
                    const safe = line.replace(/https?:\S+/gi, '<url>')
                        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
                        .split(this.state.pin || '\0').join('<code>').slice(0, 300);
                    this.emit('diagnostic', safe);
                }
                if (line === 'MGU_CONN 0') {
                    hideOldFrame();
                    wasMirroring = false;
                    this.update({ phase: 'waiting', frame: null, returnMode: 'waiting' });
                }
                if (line === 'MGU_MODE waiting') {
                    hideOldFrame();
                    this.update({ phase: 'waiting', mode: 'waiting', frame: null, detached: false });
                }
                if (line === 'MGU_MEDIA_LOADING') {
                    hideOldFrame();
                    this.update({ phase: 'loading', frame: null, error: null });
                }
                if (line === 'MGU_MEDIA_PLAY') this.emit('media', 'hls');
                // Runtime 0.4.2+: detached video (see airplay/tools/patch_detach.py).
                if (line === 'MGU_FEATURES detach') this.features.detach = true;
                if (line === 'MGU_MEDIA_DETACHED') { this.update({ detached: true }); this.emit('diagnostic', 'video_detached_from_phone'); }
                if (line === 'MGU_PHONE_STOP_IGNORED' || line === 'MGU_PHONE_PAUSE_IGNORED') this.emit('diagnostic', line.toLowerCase());
                if (line === 'MGU_MEDIA_REJECTED')
                    this.update({ phase: 'waiting', frame: null, error: 'media_unsupported' });
                if (line === 'MGU_MEDIA_FAILED') {
                    hideOldFrame();
                    this.update({ phase: 'waiting', frame: null, error: 'media_failed' });
                }
                if (line === 'MGU_MODE hls' || line === 'MGU_MODE mirror') {
                    const mode = line.slice(9);
                    if (mode === 'mirror') { wasMirroring = true; blockedGeneration = null; }
                    else hideOldFrame();
                    this.update(Object.assign({ mode, returnMode: wasMirroring ? 'mirror' : 'waiting', error: null, detached: false },
                        mode === 'hls' ? { phase: 'loading', frame: null } : {}));
                    this.emit('diagnostic', 'playback_mode_' + mode);
                    this.emit('media', mode);
                }
                const actualPin = /CLIENT MUST NOW ENTER PIN = "([0-9]{4})"/.exec(line);
                if (actualPin) {
                    this.emit('diagnostic', actualPin[1] === this.state.pin ? 'pin_matches_display' : 'pin_display_synchronized');
                    if (actualPin[1] !== this.state.pin) this.update({ pin: actualPin[1] });
                }
                const checks = [
                    ['client requested pair-setup-pin', 'pair_setup_request'],
                    ['client proof not validated', 'pair_proof_rejected'],
                    ['client_proof_len', 'pair_proof_length_rejected'],
                    ['failed to create user', 'pair_srp_init_failed'],
                    ['step 3): client authentication failed', 'pair_confirmation_failed'],
                    ['Incorrect pair-verify signature', 'pair_signature_rejected'],
                    ['gst_parse_launch error', 'pipeline_parse_failed'],
                    ['Permission denied', 'device_permission_denied'],
                    ['Unacceptable TLS certificate', 'hls_certificate_rejected'],
                    ['Could not resolve', 'hls_dns_failed'],
                ];
                for (const check of checks) if (line.indexOf(check[0]) >= 0) this.emit('diagnostic', check[1]);
                const length = /client_proof_len (\d+) invalid/.exec(line);
                if (length) this.emit('diagnostic', 'pair_proof_length_' + length[1]);
            }
        };
        if (child.stdout) child.stdout.on('data', consume);
        if (child.stderr) child.stderr.on('data', consume);
        child.once('spawn', () => { if (this.child === child && this.state.phase === 'starting') this.update({ phase: 'waiting' }); });
        let lastSequence = '';
        this.poll = setInterval(() => {
            if (this.child !== child || this.state.phase === 'stopping') return;
            const frame = frameHeader(file);
            if (frame && frame.generation === blockedGeneration) return;
            const key = frame && [frame.generation, frame.sequence, frame.width, frame.height].join(':');
            if (frame && frame.sequence && key !== lastSequence) {
                lastSequence = key; this.update({ phase: 'mirroring', frame });
            }
        }, 100);
        return true;
    }
    // A video started from screen mirroring plays on while the phone is used
    // elsewhere. Only a runtime that announced the feature gets the signal:
    // an older UxPlay would be terminated by SIGUSR1.
    detach() {
        if (!this.child || !this.features || !this.features.detach || this.state.mode !== 'hls' || this.state.detached) return false;
        this.signal(this.child, 'SIGUSR1'); return true;
    }
    resumeMirror() {
        if (!this.child || !this.features || !this.features.detach || this.state.mode !== 'hls') return false;
        this.signal(this.child, 'SIGUSR2'); return true;
    }
    signal(child, signal) {
        if (!child || child !== this.child || !child.pid) return;
        try { process.kill(-child.pid, signal); }
        catch (e) { if (e.code !== 'ESRCH') { try { child.kill(signal); } catch (ignore) {} } }
    }
    stop() {
        if (this.stopPromise) return this.stopPromise;
        const child = this.child;
        if (!child) return Promise.resolve();
        this.update({ phase: 'stopping', pin: '', frame: null });
        this.stopPromise = new Promise(resolve => {
            this.once('ended', () => { this.stopPromise = null; resolve(); });
            this.signal(child, 'SIGTERM');
            this.stopTimer = setTimeout(() => this.signal(child, 'SIGKILL'), 3000);
        });
        return this.stopPromise;
    }
    destroy() { this.closed = true; return this.stop(); }
}
module.exports = { Receiver, frameHeader };
