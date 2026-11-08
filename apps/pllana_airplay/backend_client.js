'use strict';
const EventEmitter = require('events'), net = require('net');
class BackendClient extends EventEmitter {
    constructor(socketPath) {
        super(); this.path = socketPath; this.socket = null; this.retry = null; this.timer = null; this.closed = false;
        this.stopRequest = null; this.requestSequence = 0;
        this.state = { phase: 'stopped', profile: 'auto', mode: null, origin: null, supportsVideoStop: false, supportsAutomaticMedia: false, pin: '', frame: null, file: '', audio: true, error: null };
    }
    update(s) { this.state = Object.assign({}, this.state, s); this.emit('state', this.state); }
    connect() {
        if (this.closed || this.socket) return;
        const s = net.createConnection(this.path); this.socket = s; s.setEncoding('utf8'); let pending = '';
        s.on('connect', () => {
            if (this.closed) { s.end(); return; }
            this.timer = setInterval(() => this.command('heartbeat'), 2000);
        });
        s.on('data', chunk => {
            pending += chunk;
            if (pending.length > 32768) { s.destroy(); return; }
            let at;
            while ((at = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, at); pending = pending.slice(at + 1);
                try {
                    const m = JSON.parse(line);
                    if (m && m.state) this.update(m.state);
                    if (m && m.reply && m.reply.command === 'stop' && this.stopRequest &&
                        this.stopRequest.socket === s && m.reply.id === this.stopRequest.id) {
                        this.finishStop(m.reply.ok === true ? null : 'receiver_stop_failed');
                    }
                } catch (e) { s.destroy(); return; }
            }
        });
        s.on('error', () => this.update({ phase: 'error', error: 'backend_unavailable', pin: '', frame: null }));
        s.on('close', () => {
            if (this.stopRequest && this.stopRequest.socket === s) this.finishStop('backend_unavailable');
            clearInterval(this.timer); this.timer = null;
            if (this.socket === s) this.socket = null;
            this.update({ phase: 'stopped', pin: '', frame: null, file: '' });
            // The backend keeps the receiver alive for a grace period; reconnect
            // quickly so the running session resumes without a visible gap.
            if (!this.closed) this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 500);
        });
    }
    command(command, fields) {
        if (this.closed || !this.socket || this.socket.destroyed || this.socket.connecting) return false;
        try { this.socket.write(JSON.stringify(Object.assign({}, fields || {}, { command })) + '\n'); return true; }
        catch (e) { return false; }
    }
    start(profile) {
        profile = profile === undefined ? 'auto' : profile;
        if (profile !== 'auto' && profile !== 'video' && profile !== 'audio') return false;
        return this.command('start', { profile });
    }
    musicControl(action, value) {
        const music = this.state.music;
        if (this.stopRequest || this.state.phase === 'stopping' || (this.state.mode !== 'audio' && this.state.profile !== 'audio') || !music || !music.controls || music.controls[action] !== true ||
            typeof music.epoch !== 'string' || !music.epoch || music.epoch.length > 128) return false;
        const transport = action === 'playPause' || action === 'next' || action === 'previous';
        if (!(transport && (value === undefined || value === null)) &&
            !(action === 'shuffle' && (value === 0 || value === 1)) &&
            !(action === 'repeat' && Number.isInteger(value) && value >= 0 && value <= 2)) return false;
        const fields = { action, epoch: music.epoch };
        if (value !== undefined) fields.value = value;
        return this.command('music-control', fields);
    }
    endVideo() {
        if (!this.state.supportsVideoStop || this.state.profile === 'audio' ||
            (this.state.mode !== 'hls' && this.state.phase !== 'loading' && !this.state.playlistPending)) return false;
        return this.command('end-video');
    }
    resumeMirror() { return this.command('resume-mirror'); }
    finishStop(error) {
        const request = this.stopRequest;
        if (!request) return;
        this.stopRequest = null; clearTimeout(request.timer);
        if (error) request.reject(Error(error)); else request.resolve();
    }
    stop() {
        if (this.stopRequest) return this.stopRequest.promise;
        const id = 'stop-' + (++this.requestSequence);
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        const request = { id, socket: this.socket, promise, resolve, reject, timer: null };
        this.stopRequest = request;
        request.timer = setTimeout(() => this.finishStop('receiver_stop_timeout'), 12000);
        if (!this.command('stop', { id })) this.finishStop('backend_unavailable');
        return promise;
    }
    // Losing the UI is distinct from the driver's explicit disconnect. The
    // backend keeps an audio-only session alive after this socket closes.
    disconnect() {
        this.finishStop('backend_unavailable');
        this.closed = true; clearTimeout(this.retry); clearInterval(this.timer);
        this.retry = this.timer = null;
        if (this.socket && !this.socket.destroyed) this.socket.end();
        return Promise.resolve();
    }
    destroy() { return this.stop().then(() => this.disconnect()); }
}
module.exports = { BackendClient };
