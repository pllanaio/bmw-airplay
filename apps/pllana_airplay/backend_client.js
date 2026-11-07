'use strict';
const EventEmitter = require('events'), net = require('net');
class BackendClient extends EventEmitter {
    constructor(socketPath) {
        super(); this.path = socketPath; this.socket = null; this.retry = null; this.timer = null; this.closed = false;
        this.state = { phase: 'stopped', pin: '', frame: null, file: '', audio: true, error: null };
    }
    update(s) { this.state = Object.assign({}, this.state, s); this.emit('state', this.state); }
    connect() {
        if (this.closed || this.socket) return;
        const s = net.createConnection(this.path); this.socket = s; s.setEncoding('utf8'); let pending = '';
        s.on('connect', () => { this.timer = setInterval(() => this.command('heartbeat'), 2000); });
        s.on('data', chunk => {
            pending += chunk;
            if (pending.length > 32768) { s.destroy(); return; }
            let at;
            while ((at = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, at); pending = pending.slice(at + 1);
                try { const m = JSON.parse(line); if (m && m.state) this.update(m.state); } catch (e) { s.destroy(); return; }
            }
        });
        s.on('error', () => this.update({ phase: 'error', error: 'backend_unavailable', pin: '', frame: null }));
        s.on('close', () => {
            clearInterval(this.timer); this.timer = null;
            if (this.socket === s) this.socket = null;
            this.update({ phase: 'stopped', pin: '', frame: null, file: '' });
            if (!this.closed) this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 2000);
        });
    }
    command(command) {
        if (!this.socket || this.socket.destroyed || this.socket.connecting) return false;
        this.socket.write(JSON.stringify({ command }) + '\n'); return true;
    }
    start() { return this.command('start'); }
    stop() { this.command('stop'); return Promise.resolve(); }
    destroy() {
        this.closed = true; clearTimeout(this.retry); clearInterval(this.timer);
        this.command('stop'); if (this.socket) this.socket.end();
        return Promise.resolve();
    }
}
module.exports = { BackendClient };
