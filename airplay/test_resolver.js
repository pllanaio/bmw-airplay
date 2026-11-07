'use strict';
const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
let lease = null, target = '', writes = 0, leaseOwner = 0, targetOwner = 12233;
const opened = [], closed = [];
const mockFs = {
    constants: fs.constants,
    openSync(file, flags) {
        assert(flags & fs.constants.O_NOFOLLOW, 'resolver inputs must not follow symlinks');
        opened.push(file);
        if (file === '/run/mgu-uplink/lease.json') {
            if (lease === null) throw Error('ENOENT');
            return 1;
        }
        assert.strictEqual(file, '/run/mgu-airplay/resolv.conf', 'never write BMW system DNS');
        return 2;
    },
    fstatSync(fd) { return { isFile: () => true, uid: fd === 1 ? leaseOwner : targetOwner,
        mode: 0o100600, nlink: 1, size: fd === 1 ? Buffer.byteLength(lease) : Buffer.byteLength(target) }; },
    readFileSync(fd) { return fd === 1 ? lease : target; },
    writeSync(fd, text, offset) { assert.strictEqual(fd, 2); assert.strictEqual(offset, 0); target = text; writes++; },
    ftruncateSync(fd, length) { assert.strictEqual(fd, 2); assert.strictEqual(length, Buffer.byteLength(target)); },
    closeSync(fd) { closed.push(fd); }
};
const context = { require: name => name === 'fs' ? mockFs : require(name), module: { exports: {} }, Buffer,
    process: { getuid: () => 12233 } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../apps/pllana_airplay/resolver.js'), 'utf8'), context);
const { refresh, content, hasUplink } = context.module.exports;
assert.strictEqual(content(null), null);
assert.strictEqual(content({ dns: ['0.0.0.0', '127.0.0.1', '::1', 'invalid'] }), null);
assert.strictEqual(hasUplink(), false);
refresh();
assert(target.includes('nameserver 127.0.0.1'), 'local mirroring starts without an Internet uplink');
lease = JSON.stringify({ interface: 'wlan0', ip: '172.20.10.2', dns: ['172.20.10.1'] }); refresh();
assert(target.includes('nameserver 172.20.10.1'));
assert.strictEqual(hasUplink(), true, 'online lease enables direct video on next connection');
const firstWrites = writes; refresh(); assert.strictEqual(writes, firstWrites, 'unchanged lease keeps the mounted resolver intact');
lease = null; assert.strictEqual(hasUplink(), false); refresh();
assert(!target.includes('172.20.10.1'), 'losing the hotspot clears stale DNS');
lease = JSON.stringify({ interface: 'vethuplink', ip: '192.168.8.100', dns: ['192.168.8.1', '1.1.1.1'] }); refresh();
assert(target.includes('nameserver 192.168.8.1\nnameserver 1.1.1.1'), 'USB Internet DNS is independent of the BMW WLAN sender');
lease = '{bad json'; refresh(); assert(target.includes('nameserver 127.0.0.1'));
lease = JSON.stringify({ dns: ['9.9.9.9'] }); leaseOwner = 12234; refresh();
assert(!target.includes('9.9.9.9'), 'untrusted leases are not consumed');
assert.strictEqual(hasUplink(), false);
leaseOwner = 0; targetOwner = 12234;
const beforeUnsafe = writes; refresh(); assert.strictEqual(writes, beforeUnsafe, 'do not write a resolver owned by another app');
assert.strictEqual(closed.filter(fd => fd === 2).length, opened.filter(p => p.endsWith('resolv.conf')).length);
console.log('Private resolver: offline mirroring, hotspot loss, USB/Wi-Fi DNS changes and inode-preserving updates passed');
