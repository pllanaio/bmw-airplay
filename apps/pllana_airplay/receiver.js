'use strict';
const EventEmitter = require('events');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AudioMetadata } = require('./audio_metadata');

function validVideoViewport(width, height) {
    return Number.isInteger(width) && Number.isInteger(height) && width >= 16 && height >= 16 &&
        width <= 2048 && height <= 2048 && !(width & 1) && !(height & 1) && width * height <= 2048 * 1080;
}

function writeVideoViewport(directory, file, viewport) {
    const uid = process.getuid ? process.getuid() : 0;
    const parent = fs.lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o077)) throw Error('invalid_viewport_directory');
    try {
        const current = fs.lstatSync(file);
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== uid || (current.mode & 0o777) !== 0o600)
            throw Error('invalid_viewport_file');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32LE(viewport.width, 0); bytes.writeUInt32LE(viewport.height, 4);
    const temporary = file + '.tmp-' + crypto.randomBytes(8).toString('hex');
    let fd = null, created = false;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
        created = true; fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, bytes);
        fs.closeSync(fd); fd = null; fs.renameSync(temporary, file); created = false;
    } finally {
        if (fd !== null) fs.closeSync(fd);
        if (created) try { fs.unlinkSync(temporary); } catch (e) {}
    }
}

function removeVideoViewport(file) {
    if (!file) return;
    try {
        const stat = fs.lstatSync(file), uid = process.getuid ? process.getuid() : 0;
        if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === uid) fs.unlinkSync(file);
    } catch (e) {}
}

function emptyMusic() {
    return { epoch: null, title: '', artist: '', album: '', artwork: null, playbackState: 'unknown', shuffle: null, repeat: null,
        controls: { playPause: false, next: false, previous: false, shuffle: false, repeat: false } };
}

function liveProcessGroup(pid) {
    try { process.kill(-pid, 0); }
    catch (e) { if (e.code === 'ESRCH') return false; throw e; }
    // A launcher can exit before a descendant that closed its inherited
    // pipes. Zombies retain a group number but cannot retain phone sockets.
    return fs.readdirSync('/proc').some(name => {
        if (!/^[0-9]+$/.test(name)) return false;
        try {
            const stat = fs.readFileSync('/proc/' + name + '/stat', 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
            return Number(fields[2]) === pid && fields[0] !== 'Z' && fields[0] !== 'X';
        } catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return false; throw e; }
    });
}

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
        this.child = null; this.stopTimer = null; this.stopFailTimer = null; this.poll = null; this.session = 0;
        this.stopPromise = null; this.closed = false; this.stoppingChild = null; this.closedChild = null;
        this.musicDirectory = ''; this.musicPoll = null;
        this.videoViewport = { width: 1920, height: 720 }; this.viewportFile = ''; this.viewportApplied = '';
        this.state = { phase: 'stopped', profile: 'auto', mode: null, connected: false, supportsSessionStatus: false, origin: null, supportsVideoStop: false, supportsAutomaticMedia: false, playlistPending: false, music: null, pin: '', frame: null, file: '', audio: false, error: null };
    }
    update(fields) { Object.assign(this.state, fields); this.emit('state', Object.assign({}, this.state)); }
    setVideoViewport(width, height) {
        if (!validVideoViewport(width, height) || this.closed || this.stopPromise || this.stoppingChild) return false;
        this.videoViewport = { width, height };
        const key = width + ':' + height;
        if (this.viewportFile && this.child && this.state.profile !== 'audio' && this.viewportApplied !== key) {
            try {
                writeVideoViewport(this.dataDir, this.viewportFile, this.videoViewport);
                this.viewportApplied = key;
            } catch (e) {
                this.update({ viewportError: 'video_viewport_failed', error: this.state.error || 'video_viewport_failed' });
                this.emit('diagnostic', 'video_viewport_failed'); return false;
            }
        }
        const fields = { videoViewport: this.videoViewport, viewportError: null };
        if (this.state.error === 'video_viewport_failed') fields.error = null;
        this.update(fields); return true;
    }
    // options.keepPassword: an automatic restart after a receiver failure keeps
    // the password the iPhone already knows, so it can reconnect at once.
    start(options) {
        if (this.closed || this.child || this.stopPromise || this.stoppingChild) return false;
        let profile = options && options.profile;
        if (profile === undefined) profile = typeof this.options.profile === 'function' ? this.options.profile() : this.options.profile;
        if (profile === undefined) profile = 'auto';
        if (profile !== 'auto' && profile !== 'video' && profile !== 'audio') {
            this.update({ phase: 'error', error: 'invalid_profile', pin: '' }); return false;
        }
        const viewport = options && options.viewport;
        if (viewport !== undefined && (!viewport || !validVideoViewport(viewport.width, viewport.height))) {
            this.update({ phase: 'error', error: 'invalid_video_viewport', pin: '' }); return false;
        }
        if (viewport) this.videoViewport = { width: viewport.width, height: viewport.height };
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
        const file = profile !== 'audio' ? '/dev/shm/mgu-video-airplay-' + uid + '-' + process.pid + '-' + (++this.session) : '';
        const audio = this.options.audioSink;
        if (!audio) { this.update({ phase: 'error', error: 'audio_not_configured' }); return false; }
        // Without receiver Internet, YouTube must keep sending mirrored
        // pixels over the BMW WLAN instead of handing us unreachable CDN URLs.
        // Decide per session; never restart an active stream on a lease change.
        const directVideo = profile !== 'audio' && (typeof this.options.hls === 'function' ? this.options.hls() : this.options.hls !== false);
        const access = passwordMode ? ['-pw', pin] : ['-pin', pin, '-reg', register];
        const args = [loader, '--library-path', path.join(this.runtime, 'lib'), uxplay,
            '-n', 'BMW AirPlay by pllana.io', '-nh', '-m', device].concat(access)
            .concat(profile !== 'audio' ? ['-s', '1280x720@30', '-fps', '30', '-avdec'] : [])
            .concat(directVideo ? ['-hls', '2', '-lang', '0'] : [])
            .concat(['-vs', profile === 'audio' ? '0' : 'mguvideosink location=' + file, '-as', audio, '-p', '7100']);
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
            MGU_AUDIO_ONLY: profile === 'audio' ? '1' : '0',
            MGU_AUTO_MEDIA: profile === 'auto' ? '1' : '0',
        });
        const viewportFile = profile !== 'audio' ? path.join(this.dataDir, 'video-viewport-' + process.pid + '-' + crypto.randomBytes(8).toString('hex')) : '';
        let viewportError = null;
        this.viewportApplied = '';
        if (viewportFile) {
            env.MGU_HLS_VIEWPORT_FILE = viewportFile;
            try {
                writeVideoViewport(this.dataDir, viewportFile, this.videoViewport);
                this.viewportApplied = this.videoViewport.width + ':' + this.videoViewport.height;
            } catch (e) { viewportError = 'video_viewport_failed'; this.emit('diagnostic', viewportError); }
        } else delete env.MGU_HLS_VIEWPORT_FILE;
        let metadata = null, metadataEnv = null;
        if (profile !== 'video') {
            try {
                metadata = this.options.metadataFactory ? this.options.metadataFactory(this.dataDir, this.runtime) :
                    new AudioMetadata(this.dataDir, { runtime: this.runtime, env });
                metadataEnv = metadata.env(); Object.assign(env, metadataEnv);
            } catch (e) {
                if (metadata) metadata.close(); metadata = null; metadataEnv = null;
                this.emit('diagnostic', 'audio_metadata_unavailable');
            }
        }
        // No shell or privilege changes; the receiver identity and trusted
        // pairing keys live only in the app's private data directory.
        let child;
        try { child = this.spawn(launcher, args, { env, cwd: this.dataDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (e) { if (metadata) metadata.close(); removeVideoViewport(viewportFile); this.update({ phase: 'error', error: 'launch_failed', pin: '' }); return false; }
        this.child = child; this.closedChild = null; this.features = {};
        this.viewportFile = viewportFile;
        this.musicDirectory = metadataEnv && metadataEnv.MGU_MUSIC_DIR || '';
        this.update({ phase: 'starting', profile, directVideo, videoViewport: this.videoViewport, viewportError, connected: false, supportsSessionStatus: false, origin: null, supportsVideoStop: false, supportsAutomaticMedia: false, detached: false, playlistPending: false, music: profile !== 'video' ? emptyMusic() : null, mode: profile === 'audio' ? 'audio' : 'waiting', returnMode: 'waiting', pin, file, frame: null, error: viewportError, audioError: null, audio: audio !== 'fakesink' });
        this.emit('music-directory', this.musicDirectory);
        // Node 8 has no ChildProcess "spawn" event. spawn() already returns
        // a pid on success; still handle its asynchronous error event below.
        if (child.pid) this.update({ phase: 'waiting' });
        let ended = false;
        const finish = (error) => {
            if (ended) return; ended = true;
            clearInterval(this.poll); clearInterval(this.musicPoll);
            this.poll = this.musicPoll = null;
            if (this.stoppingChild !== child) {
                clearTimeout(this.stopTimer); clearTimeout(this.stopFailTimer);
                this.stopTimer = this.stopFailTimer = null;
            }
            if (this.child === child) this.child = null;
            removeVideoViewport(viewportFile);
            if (this.viewportFile === viewportFile) { this.viewportFile = ''; this.viewportApplied = ''; }
            if (metadata) metadata.close();
            this.musicDirectory = ''; this.emit('music-directory', '');
            if (file) try {
                const st = fs.lstatSync(file);
                if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.uid === uid) fs.unlinkSync(file);
            } catch (e) {}
            this.update({ phase: error ? 'error' : 'stopped', mode: null, connected: false, supportsSessionStatus: false, origin: null, supportsVideoStop: false, supportsAutomaticMedia: false, detached: false, playlistPending: false, music: null, pin: '', frame: null, file: '', viewportError: null, error: error || null });
            this.emit('ended');
        };
        child.once('error', () => {
            // A failed signal can emit error on a live child. Its sockets are
            // closed only once Node has reaped the process and its pipes.
            if (!child.pid) finish('launch_failed');
            else this.emit('diagnostic', 'receiver_process_error');
        });
        child.once('close', (code, signal) => {
            this.closedChild = child;
            if (this.state.phase !== 'stopping') this.emit('diagnostic', 'receiver_exit_' + (signal || code));
            finish((code || signal) && this.state.phase !== 'stopping' ? 'receiver_failed' : null);
        });
        // UxPlay may include client names, addresses and PINs in output. Drain it without persisting it.
        let pendingLog = '', wasMirroring = false, nativeOrigin = null, blockedGeneration = null;
        const hideOldFrame = () => {
            if (!file) return;
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
                if (line === 'MGU_FEATURES detach') this.features.detach = true;
                if (line === 'MGU_FEATURES native-detach') this.features.nativeDetach = true;
                if (line === 'MGU_FEATURES video-modes') this.features.videoModes = true;
                if (line === 'MGU_FEATURES media-stop') { this.features.mediaStop = true; this.update({ supportsVideoStop: true }); }
                if (line === 'MGU_FEATURES playlist') this.features.playlist = true;
                if (line === 'MGU_FEATURES audio-only') this.features.audioOnly = true;
                if (line === 'MGU_FEATURES auto-media') { this.features.autoMedia = true; this.update({ supportsAutomaticMedia: true }); }
                if (line === 'MGU_FEATURES session-status') { this.features.sessionStatus = true; this.update({ supportsSessionStatus: true }); }
                if (line === 'MGU_SESSION connected' || line === 'MGU_SESSION disconnected') {
                    this.features.sessionStatus = true;
                    this.update({ connected: line === 'MGU_SESSION connected', supportsSessionStatus: true });
                }
                if (line === 'MGU_CONN 0' && !this.features.sessionStatus && this.state.mode !== 'hls') this.update({ connected: false });
                if (profile !== 'video' && line === 'MGU_MODE audio') {
                    hideOldFrame(); wasMirroring = false; nativeOrigin = null;
                    this.update({ phase: 'waiting', mode: 'audio', origin: null, returnMode: 'waiting', frame: null, playlistPending: false });
                }
                if (profile !== 'video' && line === 'MGU_AUDIO_PLAY') {
                    this.update(Object.assign({ phase: 'audio', mode: 'audio', frame: null, error: null },
                        this.features.sessionStatus ? {} : { connected: true }));
                    this.emit('media', 'audio');
                }
                if (profile !== 'video' && this.state.mode === 'audio' && (line === 'MGU_AUDIO_WAITING' || line === 'MGU_CONN 0'))
                    this.update({ phase: 'waiting', mode: 'audio', frame: null });
                // An audio profile never exposes video transitions or frames,
                // even if an older runtime still prints its video-mode markers.
                if (profile === 'audio' && /^(?:MGU_MODE (?:hls|mirror|waiting)|MGU_MEDIA_|MGU_ORIGIN |MGU_RETURN )/.test(line)) continue;
                // A renderer rebuild may finish after a standalone audio
                // handoff. Only accepted video can leave that audio mode.
                if (profile === 'auto' && this.state.mode === 'audio' && /^(?:MGU_MODE waiting|MGU_RETURN (?:mirror|waiting))$/.test(line)) continue;
                if (line === 'MGU_ORIGIN mirror' || line === 'MGU_ORIGIN direct') {
                    nativeOrigin = line.slice(11);
                    this.update({ origin: nativeOrigin, returnMode: nativeOrigin === 'mirror' ? 'mirror' : 'waiting', detached: false });
                }
                if (line === 'MGU_RETURN mirror' || line === 'MGU_RETURN waiting') {
                    const destination = line.slice(11);
                    hideOldFrame(); wasMirroring = false; nativeOrigin = null;
                    this.update({ phase: 'waiting', mode: 'waiting', origin: null, returnMode: destination, frame: null, detached: false });
                }
                // HLS fetches media independently. Losing the phone's last
                // control/mirror socket must not blank a still-running video.
                if (profile !== 'audio' && line === 'MGU_CONN 0' && this.state.mode !== 'hls' && this.state.mode !== 'audio') {
                    hideOldFrame();
                    wasMirroring = false;
                    this.update({ phase: 'waiting', frame: null, playlistPending: false, returnMode: 'waiting' });
                }
                if (line === 'MGU_MODE waiting') {
                    hideOldFrame();
                    // A later direct video needs a fresh mirror packet. Keep
                    // returnMode for the UI's transition until that packet arrives.
                    wasMirroring = false;
                    this.update({ phase: 'waiting', mode: 'waiting', frame: null, detached: false });
                }
                if (line === 'MGU_MEDIA_LOADING') {
                    hideOldFrame();
                    this.update(Object.assign({ phase: 'loading', frame: null, error: null },
                        profile === 'auto' && this.state.mode === 'audio' ? { mode: 'hls' } : {}));
                }
                if (line === 'MGU_MEDIA_PLAY') {
                    if (!this.features.sessionStatus) this.update({ connected: true });
                    this.emit('media', 'hls');
                }
                // Older runtimes used this marker for detached mirror-origin
                // videos. New runtimes report origin and honor phone controls.
                if (line === 'MGU_MEDIA_DETACHED' && this.state.mode === 'hls' && !this.features.videoModes) { this.update({ detached: true, returnMode: 'mirror' }); this.emit('diagnostic', 'video_detached_from_phone'); }
                if (line === 'MGU_PHONE_STOP_IGNORED' || line === 'MGU_PHONE_PAUSE_IGNORED') this.emit('diagnostic', line.toLowerCase());
                if (line === 'MGU_MEDIA_ENDED') { this.update({ playlistPending: true }); this.emit('diagnostic', 'mgu_media_ended'); }
                if (line === 'MGU_PLAYLIST_INSERT' || line === 'MGU_PLAYLIST_CANCELLED') {
                    this.update({ playlistPending: false }); this.emit('diagnostic', line.toLowerCase());
                }
                if (line === 'MGU_MEDIA_REJECTED')
                    this.update({ phase: 'waiting', frame: null, error: 'media_unsupported' });
                if (line === 'MGU_MEDIA_FAILED') {
                    hideOldFrame();
                    this.update({ phase: 'waiting', frame: null, playlistPending: false, error: 'media_failed' });
                }
                if (line === 'MGU_MODE hls' || line === 'MGU_MODE mirror') {
                    const mode = line.slice(9);
                    if (mode === 'mirror') { wasMirroring = true; blockedGeneration = null; }
                    else hideOldFrame();
                    const origin = mode === 'hls' ? (this.features.videoModes ? nativeOrigin || 'direct' : wasMirroring ? 'mirror' : 'direct') : null;
                    this.update(Object.assign({ mode, origin, returnMode: origin === 'mirror' || (mode === 'mirror' && wasMirroring) ? 'mirror' : 'waiting', error: null, detached: false },
                        mode === 'hls' ? { phase: 'loading', frame: null, playlistPending: false } : {}));
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
        if (profile !== 'audio') this.poll = setInterval(() => {
            if (this.child !== child || this.state.phase === 'stopping' || this.state.mode === 'audio') return;
            const frame = frameHeader(file);
            if (frame && frame.generation === blockedGeneration) return;
            const key = frame && [frame.generation, frame.sequence, frame.width, frame.height].join(':');
            if (frame && frame.sequence && key !== lastSequence) {
                lastSequence = key; this.update(Object.assign({ phase: 'mirroring', frame }, this.features.sessionStatus ? {} : { connected: true }));
            }
        }, 100);
        if (metadata) {
            let previous = '';
            this.musicPoll = setInterval(() => {
                if (this.child !== child || this.state.phase === 'stopping') return;
                try {
                    const next = metadata.poll(), key = JSON.stringify(next);
                    if (!next || key === previous) return;
                    previous = key;
                    // Metadata and confirmed remote-control state arrive on
                    // separate paths. Keep controller capabilities and epoch.
                    const music = Object.assign({}, this.state.music || emptyMusic());
                    for (const field of ['revision', 'title', 'artist', 'album', 'artwork']) if (next[field] !== undefined) music[field] = next[field];
                    this.update({ music });
                } catch (e) { this.emit('diagnostic', 'audio_metadata_unavailable'); }
            }, 500);
        }
        return true;
    }
    // A video started from screen mirroring plays on while the phone is used
    // elsewhere. Only a runtime that announced the feature gets the signal:
    // an older UxPlay would be terminated by SIGUSR1.
    detach() {
        if (!this.child || !this.features || !this.features.detach || this.features.videoModes || this.state.mode !== 'hls' || this.state.detached) return false;
        this.signal(this.child, 'SIGUSR1'); return true;
    }
    endVideo() {
        if (!this.child || this.state.profile === 'audio' || !this.features || !this.features.mediaStop ||
            (this.state.mode !== 'hls' && this.state.phase !== 'loading' && !this.state.playlistPending)) return false;
        this.signal(this.child, 'SIGWINCH'); return true;
    }
    resumeMirror() {
        if (!this.child || this.state.profile === 'audio' || !this.features || !this.features.detach ||
            (this.state.mode !== 'hls' && !(this.features.playlist && this.state.playlistPending))) return false;
        this.signal(this.child, 'SIGUSR2'); return true;
    }
    signal(child, signal) {
        if (!child || (child !== this.child && child !== this.stoppingChild) || !child.pid) return;
        try { process.kill(-child.pid, signal); }
        catch (e) { try { child.kill(signal); } catch (ignore) {} }
    }
    stop() {
        if (this.stopPromise) return this.stopPromise;
        const child = this.child || this.stoppingChild;
        if (!child) return Promise.resolve();
        this.stoppingChild = child;
        this.update({ phase: 'stopping', connected: false, pin: '', frame: null });
        const pending = new Promise((resolve, reject) => {
            let groupPoll = null;
            const cleanup = () => {
                child.removeListener('close', closed);
                clearTimeout(this.stopTimer); clearTimeout(this.stopFailTimer); clearTimeout(groupPoll);
                this.stopTimer = this.stopFailTimer = null;
            };
            const fail = () => {
                cleanup(); this.update({ error: 'receiver_stop_failed' });
                this.emit('diagnostic', 'receiver_stop_failed'); reject(Error('receiver_stop_failed'));
            };
            const drained = () => {
                try {
                    if (child.pid && liveProcessGroup(child.pid)) {
                        groupPoll = setTimeout(drained, 25); return;
                    }
                } catch (e) { fail(); return; }
                cleanup(); this.stoppingChild = null; resolve();
            };
            const closed = () => {
                try {
                    if (child.pid && liveProcessGroup(child.pid)) this.signal(child, 'SIGKILL');
                } catch (e) { fail(); return; }
                drained();
            };
            child.once('close', closed);
            this.stopTimer = setTimeout(() => this.signal(child, 'SIGKILL'), 3000);
            this.stopFailTimer = setTimeout(fail, 5000);
            this.signal(child, 'SIGTERM');
            if (this.closedChild === child) closed();
        });
        this.stopPromise = pending;
        const finished = () => { if (this.stopPromise === pending) this.stopPromise = null; };
        pending.then(finished, finished);
        return pending;
    }
    destroy() { this.closed = true; return this.stop(); }
}
module.exports = { Receiver, frameHeader, validVideoViewport };
