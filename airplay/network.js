'use strict';
// Root-only, bounded firewall setup. Change only our tagged rules, only local
// WLAN subnets and the receiver's fixed TCP/UDP ports; no table flush/policies.
const cp = require('child_process'), os = require('os'), fs = require('fs'), path = require('path');
if (process.getuid() !== 0) throw Error('root_setup_required');
const action = process.argv[2], uid = Number(process.argv[3]);
if (!['apply', 'remove', 'status'].includes(action)) throw Error('invalid_network_action');
if (action === 'apply' && (!Number.isInteger(uid) || uid < 12203 || uid > 65535)) throw Error('invalid_receiver_uid');
const tag = 'mgu-airplay';
function nft(args, input) {
    const r = cp.spawnSync('/usr/sbin/nft', args, { input, encoding: 'utf8', timeout: 5000, maxBuffer: 262144 });
    if (r.status !== 0) throw Error('nft_' + (r.stderr || 'failed').slice(0, 300));
    return r.stdout || '';
}
const chains = [
    ['ip', 'filter', 'highprioinput'], ['ip', 'filter', 'highpriooutput'],
    ['ip6', 'filter', 'highprioinput'], ['ip6', 'filter', 'highpriooutput'],
    ['inet', 'mgu_uplink', 'input'], ['inet', 'mgu_uplink', 'output'],
];
function existing() {
    return chains.map(c => {
        const r = cp.spawnSync('/usr/sbin/nft', ['-a', 'list', 'chain'].concat(c), { encoding: 'utf8', timeout: 3000 });
        return { chain: c, present: r.status === 0, text: r.stdout || '' };
    });
}
const before = existing();
if (action === 'status') {
    console.log(JSON.stringify(before.map(c => ({ chain: c.chain, rules: c.text.split('\n').filter(l => l.indexOf('comment "' + tag + '"') >= 0) }))));
    process.exit(0);
}
const commands = [];
for (const c of before) for (const line of c.text.split('\n')) {
    const match = /# handle (\d+)\s*$/.exec(line);
    if (line.indexOf('comment "' + tag + '"') >= 0 && match) commands.push('delete rule ' + c.chain.join(' ') + ' handle ' + match[1]);
}
function ipv6Prefix(a) {
    if (a.address.indexOf(':') < 0 || !a.cidr || !a.cidr.endsWith('/64')) return null;
    const parts = a.address.split('%')[0].split('::');
    if (parts.length > 2) return null;
    const left = parts[0] ? parts[0].split(':') : [], right = parts[1] ? parts[1].split(':') : [];
    const words = left.concat(Array(8 - left.length - right.length).fill('0'), right);
    if (words.length !== 8 || words.some(s => !/^[0-9a-f]{1,4}$/i.test(s))) return null;
    return words.slice(0, 4).join(':') + '::/64';
}
if (action === 'apply') {
    const dir = '/run/mgu-airplay';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, 0o755);
    const directory = fs.lstatSync(dir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o022))
        throw Error('invalid_resolver_directory');
    // The service's UMask=0077 also applies to mkdir; the backend must traverse
    // this root-owned directory to update its own 0600 resolver file.
    fs.chmodSync(dir, 0o755);
    const file = path.join(dir, 'resolv.conf');
    const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || st.size > 4096 || (st.uid !== 0 && st.uid !== uid)) throw Error('invalid_resolver_file');
        if (!st.size) fs.writeSync(fd, 'nameserver 127.0.0.1\noptions timeout:1 attempts:1\n');
        fs.fchownSync(fd, uid, uid); fs.fchmodSync(fd, 0o600);
    } finally { fs.closeSync(fd); }
    if (!before.find(c => c.chain.join(' ') === 'ip filter highprioinput').present) throw Error('stock_firewall_missing');
    // Rules match the WLAN interface plus private/link-local source ranges, not
    // the subnet that happened to exist when the service started. Previously a
    // service started before the iPhone hotspot was up (or with only the BMW
    // access point present) had no rule for wlan0, and the iPhone could see
    // the receiver but never connect until the service was restarted.
    const PRIVATE4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'];
    const PRIVATE6 = ['fe80::/10', 'fc00::/7'];
    const interfaces = os.networkInterfaces();
    const networks = [];
    for (const name of ['wlan_bridge', 'wlan0']) {
        for (const prefix of PRIVATE4) networks.push({ name, family: 'ip', prefix });
        for (const prefix of PRIVATE6) networks.push({ name, family: 'ip6', prefix });
        // Current global IPv6 /64 of the hotspot, when present at start.
        for (const a of interfaces[name] || []) {
            if (a.internal || a.family !== 'IPv6') continue;
            const prefix = ipv6Prefix(a);
            if (prefix && !/^fe[89ab]|^f[cd]/i.test(prefix) && !networks.some(n => n.name === name && n.prefix === prefix))
                networks.push({ name, family: 'ip6', prefix });
        }
    }
    for (const n of networks) for (const protocol of ['tcp', 'udp']) {
        for (const c of before) {
            if (!c.present || (c.chain[0] !== 'inet' && c.chain[0] !== n.family)) continue;
            const output = /output$/.test(c.chain[2]);
            const rule = output ? 'oifname "' + n.name + '" ' + n.family + ' daddr ' + n.prefix + ' meta skuid ' + uid + ' ' + protocol + ' sport 7100-7102' :
                'iifname "' + n.name + '" ' + n.family + ' saddr ' + n.prefix + ' ' + protocol + ' dport 7100-7102';
            commands.push('insert rule ' + c.chain.join(' ') + ' ' + rule + ' counter accept comment "' + tag + '"');
        }
    }
}
if (commands.length) {
    const script = commands.join('\n') + '\n';
    // Old nft opens /dev/stdin itself; Node's socket-backed stdin cannot be
    // reopened that way. Use a private regular file for the atomic batch.
    const dir = fs.mkdtempSync('/run/mgu-airplay-net-'), file = path.join(dir, 'rules.nft');
    try {
        fs.writeFileSync(file, script, { mode: 0o600, flag: 'wx' });
        nft(['-c', '-f', file]);
        nft(['-f', file]);
    } finally {
        try { fs.unlinkSync(file); } catch (e) {}
        fs.rmdirSync(dir);
    }
}
console.log(JSON.stringify({ action, tagged_rules_changed: commands.length }));
