'use strict';
// DACP targets are taken only from the verified RAOP session's private file.
// mDNS supplies its port, never a replacement address or a command/URL.
const fs = require('fs'), path = require('path'), net = require('net');
const http = require('http'), cp = require('child_process');
const ACTIONS = ['playPause', 'next', 'previous', 'shuffle', 'repeat'];
const MAX_BODY = 65536;

function empty() {
    return { epoch: null, controls: { playPause: false, next: false, previous: false, shuffle: false, repeat: false },
        playbackState: null, shuffle: null, repeat: null };
}
function ipv6Words(address) {
    if (net.isIP(address) !== 6) return null;
    if (address.indexOf('.') >= 0) {
        const at = address.lastIndexOf(':'), bytes = address.slice(at + 1).split('.').map(Number);
        address = address.slice(0, at + 1) + ((bytes[0] << 8) + bytes[1]).toString(16) + ':' + ((bytes[2] << 8) + bytes[3]).toString(16);
    }
    const split = address.split('::'), l = split[0] ? split[0].split(':') : [], r = split[1] ? split[1].split(':') : [];
    const words = split.length === 1 ? l : l.concat(Array(8 - l.length - r.length).fill('0'), r);
    return words.length === 8 ? words.map(s => parseInt(s, 16)) : null;
}
function private4(host) {
    if (net.isIP(host) !== 4) return false;
    const b = host.split('.').map(Number);
    return b[0] === 10 || (b[0] === 172 && b[1] >= 16 && b[1] <= 31) ||
        (b[0] === 192 && b[1] === 168) || (b[0] === 169 && b[1] === 254);
}
function localHost(host) {
    if (typeof host !== 'string' || host.length > 64 || !/^[0-9a-f:.]+(?:%[1-9][0-9]{0,9})?$/i.test(host)) return false;
    const parts = host.split('%'), bare = parts[0];
    if (parts.length > 1 && Number(parts[1]) > 4294967295) return false;
    if (net.isIP(bare) === 4) return parts.length === 1 && private4(bare);
    const w = ipv6Words(bare);
    if (!w) return false;
    if (w.slice(0, 5).every(v => v === 0) && w[5] === 65535)
        return parts.length === 1 && private4([w[6] >> 8, w[6] & 255, w[7] >> 8, w[7] & 255].join('.'));
    if ((w[0] & 0xffc0) === 0xfe80) return parts.length === 2;
    if ((w[0] & 0xfe00) === 0xfc00) return parts.length === 1;
    return false;
}

function readSender(directory) {
    let fd;
    try {
        if (typeof directory !== 'string' || !path.isAbsolute(directory)) return null;
        const dir = fs.lstatSync(directory), uid = process.getuid ? process.getuid() : dir.uid;
        if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o077)) return null;
        fd = fs.openSync(path.join(directory, 'control.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || st.uid !== uid || (st.mode & 0o077) || st.size > 1024) return null;
        const data = Buffer.alloc(1025), count = fs.readSync(fd, data, 0, data.length, 0);
        if (count > 1024 || count !== st.size) return null;
        const value = JSON.parse(data.toString('utf8', 0, count));
        if (!value || typeof value.epoch !== 'string' || !/^[0-9-]{1,96}$/.test(value.epoch) ||
            typeof value.dacpId !== 'string' || !/^[0-9a-f]{1,16}$/i.test(value.dacpId) ||
            typeof value.activeRemote !== 'string' || !/^[0-9]{1,20}$/.test(value.activeRemote) ||
            !localHost(value.host)) return null;
        return { epoch: value.epoch, host: value.host, dacpId: value.dacpId, activeRemote: value.activeRemote };
    } catch (e) { return null; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}

function parseStatus(body) {
    if (!Buffer.isBuffer(body) || body.length < 8 || body.length > MAX_BODY || body.toString('ascii', 0, 4) !== 'cmst' ||
        body.readUInt32BE(4) !== body.length - 8) throw Error('music_bad_status');
    const fields = {};
    for (let offset = 8; offset < body.length;) {
        if (offset + 8 > body.length) throw Error('music_bad_status');
        const tag = body.toString('ascii', offset, offset + 4), length = body.readUInt32BE(offset + 4);
        offset += 8;
        if (length > body.length - offset) throw Error('music_bad_status');
        if (['mstt', 'caps', 'cash', 'carp', 'caas', 'caar'].indexOf(tag) >= 0) {
            if (fields[tag] !== undefined || (length !== 1 && length !== 4)) throw Error('music_bad_status');
            fields[tag] = length === 1 ? body[offset] : body.readUInt32BE(offset);
        }
        offset += length;
    }
    if (fields.mstt !== 200 || [2, 3, 4].indexOf(fields.caps) < 0) throw Error('music_bad_status');
    return fields;
}

class MusicControls {
    constructor(options) {
        this.options = options || {};
        this.spawn = this.options.spawn || cp.spawn;
        this.http = this.options.http || http;
        this.sender = null; this.port = 0; this.generation = 0; this.pending = null;
        this.state = empty(); this.disabled = {}; this.requests = []; this.resolver = null; this.closed = false;
    }
    directory() { return typeof this.options.directory === 'function' ? this.options.directory() : this.options.directory; }
    snapshot() { return Object.assign({}, this.state, { controls: Object.assign({}, this.state.controls) }); }
    emit(fields) {
        const before = JSON.stringify(this.state);
        Object.assign(this.state, fields);
        if (JSON.stringify(this.state) !== before && this.options.onState) this.options.onState(this.snapshot());
        return this.snapshot();
    }
    cancel() {
        this.generation++;
        for (const req of this.requests.slice()) req.destroy();
        this.requests = [];
        if (this.resolver) this.resolver.kill('SIGTERM');
        this.resolver = null;
    }
    clear() {
        this.cancel(); this.sender = null; this.port = 0; this.disabled = {};
        this.emit(empty());
    }
    sync() {
        const next = this.closed ? null : readSender(this.directory());
        if (JSON.stringify(next) !== JSON.stringify(this.sender)) {
            this.clear(); this.sender = next;
            if (next) this.emit({ epoch: next.epoch });
        }
        return this.sender;
    }
    current(generation) {
        this.sync();
        if (!this.sender || this.generation !== generation || this.closed) throw Error('music_session_changed');
        return this.sender;
    }
    resolve(generation) {
        const sender = this.current(generation), binary = this.options.resolveBinary;
        if (!Array.isArray(binary) || !binary.length || binary.some(v => typeof v !== 'string')) return Promise.reject(Error('music_resolver_missing'));
        return new Promise((resolve, reject) => {
            let output = '', settled = false, child, timer;
            const finish = (error, port) => {
                if (settled) return; settled = true; clearTimeout(timer);
                if (this.resolver === child) this.resolver = null;
                if (error) reject(Error(error)); else resolve(port);
            };
            try {
                child = this.spawn(binary[0], binary.slice(1).concat([sender.dacpId]), {
                    env: Object.assign({}, process.env, { DNSSD_UDS_PATH: '/run/mdnsd/mdnsd_uds' }),
                    stdio: ['ignore', 'pipe', 'ignore'],
                });
                this.resolver = child;
            } catch (e) { finish('music_resolve_failed'); return; }
            timer = setTimeout(() => { child.kill('SIGTERM'); finish('music_resolve_timeout'); }, 4000);
            child.on('error', () => finish('music_resolve_failed'));
            if (child.stdout) child.stdout.on('data', data => {
                output += data.toString('ascii');
                if (output.length > 16) { child.kill('SIGTERM'); finish('music_resolve_failed'); }
            });
            child.once('close', code => {
                if (code !== 0 || !/^[0-9]{1,5}\n?$/.test(output)) { finish('music_resolve_failed'); return; }
                const port = Number(output.trim());
                if (port < 1024 || port > 65535) { finish('music_resolve_failed'); return; }
                try { this.current(generation); } catch (e) { finish('music_session_changed'); return; }
                finish(null, port);
            });
        });
    }
    request(route, generation) {
        const sender = this.current(generation), port = this.port;
        if (!port) return Promise.reject(Error('music_unavailable'));
        return new Promise((resolve, reject) => {
            let settled = false, timer, req;
            const finish = (error, body) => {
                if (settled) return; settled = true; clearTimeout(timer);
                const index = this.requests.indexOf(req); if (index >= 0) this.requests.splice(index, 1);
                if (error) reject(Error(error)); else resolve(body);
            };
            try {
                req = this.http.request({ method: 'GET', hostname: sender.host, port,
                    family: net.isIP(sender.host.split('%')[0]), path: '/ctrl-int/1/' + route,
                    agent: false, headers: { 'Active-Remote': sender.activeRemote, Connection: 'close' } }, response => {
                    const chunks = []; let size = 0;
                    response.on('data', data => {
                        size += data.length;
                        if (size > MAX_BODY) { finish('music_response_large'); req.destroy(); }
                        else chunks.push(data);
                    });
                    response.on('error', () => finish('music_request_failed'));
                    response.on('end', () => {
                        try { this.current(generation); } catch (e) { finish('music_session_changed'); return; }
                        if (response.statusCode !== 200 && response.statusCode !== 204) { finish('music_command_rejected'); return; }
                        finish(null, Buffer.concat(chunks));
                    });
                });
                this.requests.push(req);
                timer = setTimeout(() => { finish('music_request_timeout'); req.destroy(); }, 1200);
                req.once('error', () => finish('music_request_failed'));
                req.end();
            } catch (e) { finish('music_request_failed'); }
        });
    }
    status(generation) {
        // Revision 1 requests an immediate snapshot, avoiding a long poll.
        return this.request('playstatusupdate?revision-number=1', generation).then(body => {
            const fields = parseStatus(body);
            this.current(generation);
            const shuffle = [0, 1].indexOf(fields.cash) >= 0 ? fields.cash : null;
            const repeat = [0, 1, 2].indexOf(fields.carp) >= 0 ? fields.carp : null;
            const controls = { playPause: !this.disabled.playPause, next: !this.disabled.next, previous: !this.disabled.previous,
                shuffle: !this.disabled.shuffle && shuffle !== null && (fields.caas & 2) === 2,
                repeat: !this.disabled.repeat && repeat !== null && (fields.caar & 6) === 6 };
            this.emit({ controls, playbackState: { 2: 'stopped', 3: 'paused', 4: 'playing' }[fields.caps], shuffle, repeat });
            return this.snapshot();
        });
    }
    poll() {
        const sender = this.sync();
        if (!sender || this.pending || this.closed) return Promise.resolve(this.snapshot());
        const generation = this.generation;
        const operation = (this.port ? Promise.resolve(this.port) : this.resolve(generation)).then(port => {
            this.current(generation); this.port = port; return this.status(generation);
        }).catch(() => {
            if (this.generation === generation) {
                this.port = 0;
                this.emit(Object.assign(empty(), { epoch: sender.epoch }));
            }
            return this.snapshot();
        });
        this.pending = operation;
        return operation.then(state => { if (this.pending === operation) this.pending = null; return state; });
    }
    execute(action, value, epoch) {
        if (ACTIONS.indexOf(action) < 0 || ((action === 'shuffle' || action === 'repeat') ?
            !Number.isInteger(value) || value < 0 || value > (action === 'shuffle' ? 1 : 2) : value !== undefined && value !== null))
            return Promise.reject(Error('music_invalid_command'));
        const before = this.pending || Promise.resolve();
        const operation = before.catch(() => {}).then(() => {
            const sender = this.sync();
            if (!sender || sender.epoch !== epoch || !this.state.controls[action] || this.closed) throw Error('music_unavailable');
            const generation = this.generation;
            const routes = { playPause: 'playpause', next: 'nextitem', previous: 'previtem',
                shuffle: 'setproperty?dacp.shufflestate=' + value, repeat: 'setproperty?dacp.repeatstate=' + value };
            return this.request(routes[action], generation).then(() => this.status(generation)).then(state => {
                if ((action === 'shuffle' || action === 'repeat') && state[action] !== value) throw Error('music_unconfirmed');
                return state;
            }).catch(error => {
                if (this.generation === generation) {
                    this.disabled[action] = true;
                    const controls = Object.assign({}, this.state.controls); controls[action] = false;
                    this.emit({ controls });
                }
                throw Error(error.message === 'music_unconfirmed' ? 'music_unconfirmed' : 'music_command_failed');
            });
        });
        this.pending = operation;
        return operation.then(state => {
            if (this.pending === operation) this.pending = null;
            return state;
        }, error => {
            if (this.pending === operation) this.pending = null;
            throw error;
        });
    }
    close() { this.closed = true; this.clear(); }
}
module.exports = { MusicControls, readSender, parseStatus, localHost };
