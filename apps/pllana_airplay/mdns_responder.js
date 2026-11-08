'use strict';
// Bonjour (mDNS) responder for the Wi-Fi uplink (Node 8, no dependencies).
//
// The BMW mdnsd announces the receiver on the car's own interfaces only. When
// the head unit joins the iPhone's hotspot through mgu-uplink (wlan1, or
// wlan0 without a second radio), nobody announces it there and the iPhone
// cannot find "BMW AirPlay by pllana.io". This responder announces exactly
// the records UxPlay registered (MGU_DNSSD lines: name, port, TXT incl. its
// public key) on that one network: it answers only senders inside the
// uplink's private subnet and sends with the uplink address as interface.
const dgram = require('dgram'), EventEmitter = require('events');
const GROUP = '224.0.0.251', PORT = 5353;
const T = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 };
const TYPES = { raop: '_raop._tcp', airplay: '_airplay._tcp' };

function ipv4(value) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(value || ''));
    if (!m) return null;
    const b = m.slice(1).map(Number);
    return b.some(n => n > 255) ? null : ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}
function inSubnet(address, base, prefix) {
    const a = ipv4(address), n = ipv4(base);
    if (a === null || n === null || !(prefix >= 1 && prefix <= 32)) return false;
    const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
    return ((a & mask) >>> 0) === ((n & mask) >>> 0);
}
function privateLease(lease) {
    if (!lease || (lease.interface !== 'wlan0' && lease.interface !== 'wlan1')) return null;
    const prefix = Number(lease.prefix);
    if (ipv4(lease.ip) === null || !(prefix >= 8 && prefix <= 30)) return null;
    const ok = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16]].some(r => inSubnet(lease.ip, r[0], r[1]));
    return ok ? { interface: lease.interface, ip: lease.ip, prefix } : null;
}

// ---- DNS wire format ----
function encodeName(labels) {
    const parts = [];
    for (const label of labels) {
        const b = Buffer.from(label, 'utf8');
        if (!b.length || b.length > 63) throw Error('invalid_dns_label');
        parts.push(Buffer.from([b.length]), b);
    }
    parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
}
function readName(buf, offset) {
    const labels = [];
    let at = offset, end = null, jumps = 0;
    for (;;) {
        if (at >= buf.length) throw Error('truncated_name');
        const len = buf[at];
        if (len === 0) { at++; break; }
        if ((len & 0xc0) === 0xc0) {
            if (at + 1 >= buf.length || ++jumps > 16) throw Error('bad_pointer');
            if (end === null) end = at + 2;
            at = ((len & 0x3f) << 8) | buf[at + 1];
            continue;
        }
        if (len > 63 || at + 1 + len > buf.length) throw Error('bad_label');
        labels.push(buf.toString('utf8', at + 1, at + 1 + len));
        at += 1 + len;
    }
    return { labels, next: end === null ? at : end };
}
function parseQuery(buf) {
    if (buf.length < 12) return null;
    const id = buf.readUInt16BE(0), flags = buf.readUInt16BE(2), qd = buf.readUInt16BE(4);
    if (flags & 0x8000) return null; // a response, not a query
    const questions = [];
    let at = 12;
    for (let i = 0; i < qd && i < 32; i++) {
        const name = readName(buf, at);
        at = name.next;
        if (at + 4 > buf.length) return null;
        const type = buf.readUInt16BE(at), cls = buf.readUInt16BE(at + 2);
        at += 4;
        questions.push({ labels: name.labels, type, unicast: !!(cls & 0x8000) });
    }
    return { id, questions };
}
function record(labels, type, ttl, rdata, unique) {
    const head = Buffer.alloc(10);
    head.writeUInt16BE(type, 0);
    head.writeUInt16BE(1 | (unique ? 0x8000 : 0), 2);
    head.writeUInt32BE(ttl >>> 0, 4);
    head.writeUInt16BE(rdata.length, 8);
    return { labels, type, buf: Buffer.concat([encodeName(labels), head, rdata]) };
}
function message(id, answers, additionals, questions) {
    const head = Buffer.alloc(12);
    head.writeUInt16BE(id, 0);
    head.writeUInt16BE(0x8400, 2); // response, authoritative
    head.writeUInt16BE(questions ? questions.length : 0, 4);
    head.writeUInt16BE(answers.length, 6);
    head.writeUInt16BE(0, 8);
    head.writeUInt16BE(additionals.length, 10);
    const qs = (questions || []).map(q => { const t = Buffer.alloc(4); t.writeUInt16BE(q.type, 0); t.writeUInt16BE(1, 2); return Buffer.concat([encodeName(q.labels), t]); });
    return Buffer.concat([head].concat(qs, answers.map(r => r.buf), additionals.map(r => r.buf)));
}
const same = (a, b) => a.length === b.length && a.every((l, i) => l.toLowerCase() === b[i].toLowerCase());

class UplinkResponder extends EventEmitter {
    constructor(options) {
        super();
        this.options = options || {};
        this.services = {};     // kind -> { name, port, txt }
        this.lease = null;
        this.socket = null;
        this.host = this.options.host || 'pllana-airplay';
        this.timers = [];
    }
    log(code) { this.emit('diagnostic', code); }
    records(ttlScale) {
        const s = ttlScale === 0 ? 0 : 1, out = [];
        if (!this.lease) return out;
        const hostLabels = [this.host, 'local'];
        for (const kind of Object.keys(TYPES)) {
            const svc = this.services[kind];
            if (!svc) continue;
            const type = TYPES[kind].split('.').concat('local'), instance = [svc.name].concat(type);
            const srv = Buffer.alloc(6);
            srv.writeUInt16BE(0, 0); srv.writeUInt16BE(0, 2); srv.writeUInt16BE(svc.port, 4);
            out.push({ kind, ptr: record(type, T.PTR, 4500 * s, encodeName(instance), false),
                srv: record(instance, T.SRV, 120 * s, Buffer.concat([srv, encodeName(hostLabels)]), true),
                txt: record(instance, T.TXT, 4500 * s, svc.txt.length ? svc.txt : Buffer.from([0]), true),
                type, instance });
        }
        const a = Buffer.alloc(4);
        a.writeUInt32BE(ipv4(this.lease.ip), 0);
        this.aRecord = record(hostLabels, T.A, 120 * s, a, true);
        return out;
    }
    allRecords(ttlScale) {
        const sets = this.records(ttlScale), list = [];
        for (const r of sets) list.push(r.ptr, r.srv, r.txt);
        if (sets.length) list.push(this.aRecord);
        return list;
    }
    answer(q) {
        const sets = this.records(1), answers = [], extra = [];
        const want = t => q.type === t || q.type === T.ANY;
        const enumName = ['_services', '_dns-sd', '_udp', 'local'];
        for (const r of sets) {
            if (want(T.PTR) && same(q.labels, r.type)) { answers.push(r.ptr); extra.push(r.srv, r.txt, this.aRecord); }
            if (same(q.labels, r.instance)) {
                if (want(T.SRV)) { answers.push(r.srv); extra.push(this.aRecord); }
                if (want(T.TXT)) answers.push(r.txt);
            }
            if (want(T.PTR) && same(q.labels, enumName)) {
                answers.push(record(enumName, T.PTR, 4500, encodeName(r.type), false));
            }
        }
        if (sets.length && want(T.A) && same(q.labels, [this.host, 'local'])) answers.push(this.aRecord);
        return { answers, extra };
    }
    onMessage(buf, rinfo) {
        const lease = this.lease;
        if (!lease || rinfo.address === lease.ip || !inSubnet(rinfo.address, lease.ip, lease.prefix)) return;
        let query;
        try { query = parseQuery(buf); } catch (e) { return; }
        if (!query || !query.questions.length) return;
        const answers = [], extra = [], seen = new Set();
        let unicast = rinfo.port !== PORT;
        for (const q of query.questions) {
            const r = this.answer(q);
            if (r.answers.length && q.unicast) unicast = true;
            for (const x of r.answers) if (!seen.has(x.buf.toString('hex'))) { seen.add(x.buf.toString('hex')); answers.push(x); }
            for (const x of r.extra) if (!seen.has(x.buf.toString('hex'))) { seen.add(x.buf.toString('hex')); extra.push(x); }
        }
        if (!answers.length) return;
        // Legacy (non-5353) queries get their id and question echoed back.
        const legacy = rinfo.port !== PORT;
        const packet = message(legacy ? query.id : 0, answers, extra, legacy ? query.questions : null);
        this.send(packet, unicast ? rinfo.address : GROUP, unicast ? rinfo.port : PORT);
    }
    send(packet, address, port) {
        if (!this.socket) return;
        try { this.socket.send(packet, 0, packet.length, port, address, () => {}); } catch (e) { /* closing */ }
    }
    announce() {
        this.timers.forEach(clearTimeout); this.timers = [];
        const once = () => { const list = this.allRecords(1); if (list.length) this.send(message(0, list, []), GROUP, PORT); };
        once();
        // RFC 6762: at least two announcements, one second apart.
        this.timers.push(setTimeout(once, 1000), setTimeout(once, 3000));
    }
    goodbye() {
        const list = this.allRecords(0);
        if (list.length) this.send(message(0, list, []), GROUP, PORT);
    }
    setServices(services) {
        const next = {};
        for (const kind of Object.keys(TYPES)) {
            const s = services && services[kind];
            if (s && typeof s.name === 'string' && s.name && Number.isInteger(s.port) && s.port > 0 && s.port < 65536 && Buffer.isBuffer(s.txt))
                next[kind] = { name: s.name.slice(0, 63), port: s.port, txt: s.txt };
        }
        const key = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k].name, o[k].port, o[k].txt.toString('hex')]));
        if (key(next) === key(this.services)) return;
        if (this.socket) this.goodbye();
        this.services = next;
        if (this.socket) this.announce();
    }
    setLease(raw) {
        const lease = privateLease(raw);
        const key = l => l ? l.interface + ' ' + l.ip + '/' + l.prefix : '';
        if (key(lease) === key(this.lease) && (this.socket || !lease)) return;
        this.stop();
        if (!lease) return;
        this.lease = lease;
        const socket = this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        socket.on('error', e => { this.log('uplink_mdns_error_' + (e.code || 'socket')); if (this.socket === socket) { this.socket = null; this.lease = null; try { socket.close(); } catch (x) {} } });
        socket.on('message', (buf, rinfo) => this.onMessage(buf, rinfo));
        socket.bind(PORT, () => {
            if (this.socket !== socket) return;
            try {
                socket.addMembership(GROUP, lease.ip);
                socket.setMulticastInterface(lease.ip);
                socket.setMulticastTTL(255);
                socket.setMulticastLoopback(!!this.options.loopback); // loopback only in tests
            } catch (e) { this.log('uplink_mdns_membership_failed'); }
            this.log('uplink_mdns_on_' + lease.interface);
            this.announce();
        });
    }
    stop() {
        this.timers.forEach(clearTimeout); this.timers = [];
        const socket = this.socket;
        if (socket) { this.goodbye(); this.socket = null; setTimeout(() => { try { socket.close(); } catch (e) {} }, 50); }
        this.lease = null;
    }
}
module.exports = { UplinkResponder, parseQuery, encodeName, readName, privateLease, inSubnet, message, T };
