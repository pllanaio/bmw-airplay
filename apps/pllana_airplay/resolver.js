'use strict';
// Only our receiver's mount namespace uses this resolver. Never alter BMW DNS.
const fs = require('fs'), net = require('net');
const OFFLINE = 'nameserver 127.0.0.1\noptions timeout:1 attempts:1\n';
function content(lease) {
    if (!lease || !Array.isArray(lease.dns)) return null;
    const servers = lease.dns.filter(ip => typeof ip === 'string' && net.isIP(ip) === 4 &&
        ip !== '0.0.0.0' && !ip.startsWith('127.')).slice(0, 3);
    return servers.length ? servers.map(ip => 'nameserver ' + ip + '\n').join('') + 'options timeout:2 attempts:2\n' : null;
}
function lease() {
    let fd;
    try {
        fd = fs.openSync('/run/mgu-uplink/lease.json', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const st = fs.fstatSync(fd);
        if (st.isFile() && st.uid === 0 && !(st.mode & 0o022) && st.size <= 16384)
            return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch (e) { /* No Internet lease: local AirPlay still works. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    return null;
}
function hasUplink() {
    const current = lease();
    return !!(current && typeof current.interface === 'string' && current.interface &&
        net.isIP(current.ip || '') === 4 && content(current));
}
function refresh() {
    let fd;
    try {
        const text = content(lease()) || OFFLINE;
        // A removed lease must not leave a previous hotspot's DNS in place.
        // A later USB/Wi-Fi lease replaces it without restarting the receiver.
        const target = '/run/mgu-airplay/resolv.conf';
        fd = fs.openSync(target, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
        const s = fs.fstatSync(fd);
        if (!s.isFile() || s.uid !== process.getuid() || s.nlink !== 1 || s.size > 4096) return;
        if (fs.readFileSync(fd, 'utf8') === text) return;
        // Keep the inode: /etc/resolv.conf is bound to it in our private namespace.
        fs.writeSync(fd, text, 0, 'utf8'); fs.ftruncateSync(fd, Buffer.byteLength(text));
    } catch (e) { /* Mirroring remains available without an Internet uplink. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = { refresh, content, hasUplink };
