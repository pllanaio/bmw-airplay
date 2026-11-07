'use strict';
// Only our receiver's mount namespace uses this resolver. Never alter BMW DNS.
const fs = require('fs'), net = require('net');
function content(lease) {
    if (!lease || !Array.isArray(lease.dns)) return null;
    const servers = lease.dns.filter(ip => typeof ip === 'string' && net.isIP(ip) === 4 &&
        ip !== '0.0.0.0' && !ip.startsWith('127.')).slice(0, 3);
    return servers.length ? servers.map(ip => 'nameserver ' + ip + '\n').join('') + 'options timeout:2 attempts:2\n' : null;
}
function refresh() {
    let fd;
    try {
        const leaseFile = '/run/mgu-uplink/lease.json', st = fs.lstatSync(leaseFile);
        if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || st.size > 16384) return;
        const text = content(JSON.parse(fs.readFileSync(leaseFile, 'utf8')));
        if (!text) return;
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
module.exports = { refresh, content };
