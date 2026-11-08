'use strict';
// Controls the native URL player (runtime bin/mgu-media-player) used for
// Android/DLNA senders. Video goes through the same private shared-memory
// frame transport as AirPlay, audio through the same BMW ALSA sink. The child
// runs without a shell or privilege changes; its output carries no URLs.
const EventEmitter = require('events');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { frameHeader, writeVideoViewport, removeVideoViewport, validVideoViewport } = require('./receiver');

function validUri(uri) {
    return typeof uri === 'string' && uri.length >= 8 && uri.length <= 8192 && /^https?:\/\//i.test(uri) && !/[\x00-\x20\x7f]/.test(uri);
}
function idle() { return { state: 'stopped', media: null, position: 0, duration: -1, frame: null, file: '', error: null }; }

class MediaPlayer extends EventEmitter {
    constructor(options) {
        super();
        this.options = options || {};
        this.spawn = this.options.spawn || childProcess.spawn;
        this.runtime = this.options.runtime;
        this.dataDir = this.options.dataDir;
        this.child = null; this.session = 0; this.pending = ''; this.poll = null; this.lastFrame = '';
        this.viewport = { width: 1920, height: 720 }; this.viewportFile = ''; this.video = true;
        this.state = idle();
    }
    available() {
        if (this.options.skipRuntimeCheck) return true;
        return ['bin/airplay-launch', 'lib/ld-linux-x86-64.so.2', 'bin/mgu-media-player'].every(p => fs.existsSync(path.join(this.runtime, p)));
    }
    update(fields) { Object.assign(this.state, fields); this.emit('state', Object.assign({}, this.state)); }
    setViewport(width, height) {
        if (!validVideoViewport(width, height)) return false;
        this.viewport = { width, height };
        if (this.viewportFile && this.child) {
            try { writeVideoViewport(this.dataDir, this.viewportFile, this.viewport); } catch (e) { this.emit('diagnostic', 'player_viewport_failed'); return false; }
        }
        return true;
    }
    ensure() {
        if (this.child) return true;
        if (!this.available()) { this.update({ state: 'stopped', error: 'player_missing' }); return false; }
        const uid = process.getuid ? process.getuid() : 0;
        const file = this.video ? '/dev/shm/mgu-video-android-' + uid + '-' + process.pid + '-' + (++this.session) : '';
        const viewportFile = this.video ? path.join(this.dataDir, 'player-viewport-' + process.pid + '-' + crypto.randomBytes(8).toString('hex')) : '';
        const audio = this.options.audioSink || 'fakesink';
        const env = Object.assign({}, process.env, {
            HOME: this.dataDir, XDG_CACHE_HOME: this.dataDir,
            GST_PLUGIN_SYSTEM_PATH_1_0: '', GST_PLUGIN_PATH_1_0: path.join(this.runtime, 'plugins'),
            GST_REGISTRY: path.join(this.dataDir, 'gst-player-registry.bin'), GST_REGISTRY_FORK: 'no',
            LD_LIBRARY_PATH: path.join(this.runtime, 'lib'), GST_DEBUG: '1', GST_DEBUG_NO_COLOR: '1',
            GST_PLUGIN_FEATURE_RANK: 'hlsdemux2:0',
            ALSA_PLUGIN_DIR: '/usr/lib/alsa-lib', MGU_HLS_AUDIO_SINK: audio,
            GIO_MODULE_DIR: path.join(this.runtime, 'gio'),
            G_TLS_CA_FILE: path.join(this.runtime, 'etc/ca-certificates.crt'),
            SSL_CERT_FILE: path.join(this.runtime, 'etc/ca-certificates.crt'),
        });
        if (viewportFile) {
            env.MGU_HLS_VIEWPORT_FILE = viewportFile;
            try { writeVideoViewport(this.dataDir, viewportFile, this.viewport); } catch (e) { this.emit('diagnostic', 'player_viewport_failed'); }
        } else delete env.MGU_HLS_VIEWPORT_FILE;
        const args = [path.join(this.runtime, 'lib/ld-linux-x86-64.so.2'), '--library-path', path.join(this.runtime, 'lib'),
            path.join(this.runtime, 'bin/mgu-media-player'), file ? 'mguvideosink location=' + file : 'none'];
        let child;
        try { child = this.spawn(path.join(this.runtime, 'bin/airplay-launch'), args, { env, cwd: this.dataDir, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
        catch (e) { removeVideoViewport(viewportFile); this.update({ state: 'stopped', error: 'player_failed' }); return false; }
        this.child = child; this.pending = ''; this.viewportFile = viewportFile; this.file = file; this.lastFrame = '';
        if (child.stdin && child.stdin.on) child.stdin.on('error', () => {});
        const consume = chunk => {
            if (this.child !== child) return;
            this.pending = (this.pending + String(chunk)).slice(-8192);
            let at;
            while ((at = this.pending.indexOf('\n')) >= 0) {
                const line = this.pending.slice(0, at).trim(); this.pending = this.pending.slice(at + 1);
                this.line(line);
            }
        };
        if (child.stdout) child.stdout.on('data', consume);
        if (child.stderr) child.stderr.on('data', () => {});
        let ended = false;
        const finish = () => {
            if (ended) return; ended = true;
            if (this.child !== child) return;
            this.child = null; clearInterval(this.poll); this.poll = null;
            removeVideoViewport(viewportFile); this.viewportFile = '';
            if (file) try {
                const st = fs.lstatSync(file);
                if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.uid === uid) fs.unlinkSync(file);
            } catch (e) {}
            const failed = !this.closing && this.state.state !== 'stopped';
            this.closing = false;
            this.update(Object.assign(idle(), failed ? { error: 'player_failed' } : {}));
            if (failed) this.emit('diagnostic', 'player_exited');
        };
        child.once('error', () => { if (!child.pid) finish(); });
        child.once('close', finish);
        if (file) this.poll = setInterval(() => this.checkFrame(), 100);
        return true;
    }
    checkFrame() {
        if (!this.child || !this.file || this.state.state === 'stopped' || this.state.media === 'audio') return;
        const frame = frameHeader(this.file);
        const key = frame && [frame.generation, frame.sequence, frame.width, frame.height].join(':');
        if (frame && frame.sequence && key !== this.lastFrame) { this.lastFrame = key; this.update({ frame, file: this.file }); }
    }
    line(line) {
        const state = /^MGU_PLAYER state (loading|buffering|playing|paused|stopped|ended)$/.exec(line);
        if (state) {
            const fields = { state: state[1] };
            if (state[1] === 'loading') Object.assign(fields, { media: null, position: 0, duration: -1, frame: null, error: null });
            if (state[1] === 'stopped') Object.assign(fields, { media: null, frame: null });
            this.update(fields); return;
        }
        const media = /^MGU_PLAYER media (video|audio)$/.exec(line);
        if (media) { this.update({ media: media[1] }); return; }
        const position = /^MGU_PLAYER position ([0-9]{1,12}) (-1|[0-9]{1,12})$/.exec(line);
        if (position) { this.state.position = Number(position[1]) / 1000; this.state.duration = position[2] === '-1' ? -1 : Number(position[2]) / 1000; this.emit('position'); return; }
        const error = /^MGU_PLAYER error ([a-z_]{1,32})$/.exec(line);
        if (error) { this.update({ error: 'player_' + error[1] }); this.emit('diagnostic', 'player_' + error[1]); }
    }
    send(text) {
        if (!this.child || !this.child.stdin || this.child.stdin.destroyed) return false;
        try { this.child.stdin.write(text + '\n'); return true; } catch (e) { return false; }
    }
    // this.video (set before the player starts) selects a video sink; audio
    // URLs play the same way and simply report "media audio".
    load(uri, start) {
        if (!validUri(uri)) return false;
        if (!this.ensure()) return false;
        if (this.viewportFile) try { writeVideoViewport(this.dataDir, this.viewportFile, this.viewport); } catch (e) {}
        this.update({ state: 'loading', media: null, position: 0, duration: -1, frame: null, error: null });
        this.send('uri ' + uri);
        if (start > 0 && isFinite(start)) this.send('start ' + start.toFixed(3));
        return true;
    }
    play() { return this.send('play'); }
    pause() { return this.send('pause'); }
    seek(seconds) { return Number.isFinite(seconds) && seconds >= 0 && this.send('seek ' + seconds.toFixed(3)); }
    volume(value) { return Number.isInteger(value) && value >= 0 && value <= 100 && this.send('volume ' + value); }
    mute(on) { return this.send('mute ' + (on ? 1 : 0)); }
    stop() {
        if (!this.child) { if (this.state.state !== 'stopped') this.update(idle()); return; }
        this.send('stop');
        this.update({ state: 'stopped', media: null, frame: null });
    }
    // Ends the native player; resolves when its process group has exited.
    close() {
        const child = this.child;
        if (!child) return Promise.resolve();
        this.closing = true;
        this.send('quit');
        return new Promise(resolve => {
            let done = false;
            const finish = () => { if (done) return; done = true; clearTimeout(term); clearTimeout(kill); resolve(); };
            const signal = name => { try { process.kill(-child.pid, name); } catch (e) { try { child.kill(name); } catch (ignore) {} } };
            const term = setTimeout(() => signal('SIGTERM'), 1000);
            const kill = setTimeout(() => { signal('SIGKILL'); setTimeout(finish, 200); }, 3000);
            child.once('close', finish);
        });
    }
}
module.exports = { MediaPlayer, validUri };
