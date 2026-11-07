'use strict';
// Root-only, bounded firewall setup. Change only our tagged rules, only local
// WLAN ranges and the receiver's fixed TCP/UDP ports; no table flush/policies.
const cp = require('child_process'), os = require('os'), fs = require('fs'), path = require('path');
const tag = 'mgu-airplay';
// wlan_bridge is the BMW access point. wlan0 and wlan1 are the two supported
// station backends of mgu-uplink. USB uplinks need no inbound AirPlay rules:
// the phone can use the BMW AP while the app downloads via the USB uplink.
const WLAN = ['wlan_bridge', 'wlan0', 'wlan1'];
const chains = [
    ['ip', 'filter', 'highprioinput'], ['ip', 'filter', 'highpriooutput'],
    ['ip6', 'filter', 'highprioinput'], ['ip6', 'filter', 'highpriooutput'],
    ['inet', 'mgu_uplink', 'input'], ['inet', 'mgu_uplink', 'output'],
];
function validUid(uid) {
    if (!Number.isInteger(uid) || uid < 12203 || uid > 65535) throw Error('invalid_receiver_uid');
}
function nft(args) {
    const r = cp.spawnSync('/usr/sbin/nft', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 262144 });
    if (r.status !== 0) throw Error('nft_' + (r.stderr || 'failed').slice(0, 300));
    return r.stdout || '';
}
function existing() {
    return chains.map(c => {
        // Numeric UIDs and service ports keep comparison independent of NSS.
        const r = cp.spawnSync('/usr/sbin/nft', ['-nn', '-a', 'list', 'chain'].concat(c), { encoding: 'utf8', timeout: 3000, maxBuffer: 262144 });
        if (r.error) throw Error('nft_list_failed');
        return { chain: c, present: r.status === 0, text: r.stdout || '' };
    });
}
function ipv6Prefix(a) {
    if (typeof a.address !== 'string' || a.address.indexOf(':') < 0 || !a.cidr || !a.cidr.endsWith('/64')) return null;
    const parts = a.address.split('%')[0].split('::');
    if (parts.length > 2) return null;
    const left = parts[0] ? parts[0].split(':') : [], right = parts[1] ? parts[1].split(':') : [];
    if (left.length + right.length > 8) return null;
    const words = left.concat(Array(8 - left.length - right.length).fill('0'), right);
    if (words.length !== 8 || words.some(s => !/^[0-9a-f]{1,4}$/i.test(s))) return null;
    return words.slice(0, 4).map(s => parseInt(s, 16).toString(16)).join(':') + '::/64';
}
function networks(interfaces) {
    const result = [];
    for (const name of WLAN) {
        for (const prefix of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'])
            result.push({ name, family: 'ip', prefix });
        for (const prefix of ['fe80::/10', 'fc00::/7']) result.push({ name, family: 'ip6', prefix });
        // Address-independent private rules also work if the AP or station
        // appears after this service. A current global IPv6 /64 is refreshed
        // by the root supervisor when an interface address changes.
        for (const a of interfaces[name] || []) {
            if (a.internal || (a.family !== 'IPv6' && a.family !== 6)) continue;
            const prefix = ipv6Prefix(a);
            if (prefix && !/^fe[89ab]|^f[cd]/i.test(prefix) && !result.some(n => n.name === name && n.prefix === prefix))
                result.push({ name, family: 'ip6', prefix });
        }
    }
    return result;
}
function desiredRules(chain, uid, interfaces) {
    validUid(uid);
    const output = /output$/.test(chain[2]), result = [];
    for (const n of networks(interfaces)) for (const protocol of ['tcp', 'udp']) {
        if (chain[0] !== 'inet' && chain[0] !== n.family) continue;
        const rule = output ? 'oifname "' + n.name + '" ' + n.family + ' daddr ' + n.prefix + ' meta skuid ' + uid + ' ' + protocol + ' sport 7100-7102' :
            'iifname "' + n.name + '" ' + n.family + ' saddr ' + n.prefix + ' ' + protocol + ' dport 7100-7102';
        result.push(rule + ' counter accept comment "' + tag + '"');
    }
    return result;
}
function ownRules(text) {
    return text.split('\n').filter(line => line.indexOf('comment "' + tag + '"') >= 0);
}
function normalized(rule) {
    return rule.replace(/# handle \d+\s*$/, '').replace(/\bcounter(?: packets \d+ bytes \d+)?\s*/g, '')
        // nft prints IPv6 prefixes in compressed form. Compare addresses as
        // eight words so a zero-compressed /64 does not cause periodic writes.
        .replace(/\b[0-9a-f]*:[0-9a-f:]+\/\d+/gi, value => {
            const parts = value.split('/'), halves = parts[0].split('::');
            const l = halves[0] ? halves[0].split(':') : [], r = halves[1] ? halves[1].split(':') : [];
            return l.concat(Array(Math.max(0, 8 - l.length - r.length)).fill('0'), r)
                .map(v => parseInt(v, 16).toString(16)).join(':') + '/' + parts[1];
        }).replace(/\s+/g, ' ').trim();
}
function plan(action, uid, before, interfaces) {
    const commands = [];
    if (action !== 'apply' && action !== 'remove') throw Error('invalid_network_action');
    if (action === 'apply') {
        validUid(uid);
        if (!before.some(c => c.present && c.chain.join(' ') === 'ip filter highprioinput')) throw Error('stock_firewall_missing');
    }
    for (const c of before) {
        if (!c.present) continue;
        const have = ownRules(c.text), want = action === 'apply' ? desiredRules(c.chain, uid, interfaces) : [];
        if (have.map(normalized).sort().join('\n') === want.map(normalized).sort().join('\n')) continue;
        for (const line of have) {
            const match = /# handle (\d+)\s*$/.exec(line);
            if (!match) throw Error('nft_rule_handle_missing');
            commands.push('delete rule ' + c.chain.join(' ') + ' handle ' + match[1]);
        }
        for (const rule of want) commands.push('insert rule ' + c.chain.join(' ') + ' ' + rule);
    }
    return commands;
}
function prepareResolver(uid) {
    const dir = '/run/mgu-airplay';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, 0o755);
    const directory = fs.lstatSync(dir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o022))
        throw Error('invalid_resolver_directory');
    // UMask=0077 applies to mkdir; the app must traverse this root directory.
    if ((directory.mode & 0o777) !== 0o755) fs.chmodSync(dir, 0o755);
    const file = path.join(dir, 'resolv.conf');
    const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || st.size > 4096 || (st.uid !== 0 && st.uid !== uid)) throw Error('invalid_resolver_file');
        if (!st.size) fs.writeSync(fd, 'nameserver 127.0.0.1\noptions timeout:1 attempts:1\n');
        if (st.uid !== uid || st.gid !== uid) fs.fchownSync(fd, uid, uid);
        if ((st.mode & 0o777) !== 0o600) fs.fchmodSync(fd, 0o600);
    } finally { fs.closeSync(fd); }
}
function main(action, uid) {
    if (process.getuid() !== 0) throw Error('root_setup_required');
    if (!['apply', 'remove', 'status'].includes(action)) throw Error('invalid_network_action');
    if (action === 'apply') validUid(uid);
    const before = existing();
    if (action === 'status') return before.map(c => ({ chain: c.chain, rules: ownRules(c.text) }));
    if (action === 'apply') prepareResolver(uid);
    const commands = plan(action, uid, before, os.networkInterfaces());
    if (commands.length) {
        // Old nft reopens /dev/stdin, which cannot reopen Node's socket-backed
        // stdin. Use a private regular file for the checked atomic batch.
        const dir = fs.mkdtempSync('/run/mgu-airplay-net-'), file = path.join(dir, 'rules.nft');
        try {
            fs.writeFileSync(file, commands.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
            nft(['-c', '-f', file]);
            nft(['-f', file]);
        } finally {
            try { fs.unlinkSync(file); } catch (e) {}
            fs.rmdirSync(dir);
        }
    }
    return { action, tagged_rules_changed: commands.length };
}
module.exports = { WLAN, chains, desiredRules, plan, ipv6Prefix };
if (require.main === module) console.log(JSON.stringify(main(process.argv[2], Number(process.argv[3]))));
