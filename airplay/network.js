'use strict';
// Root-only, bounded firewall setup. Change only our tagged rules, only local
// WLAN ranges and fixed receiver ports plus app-owned local DACP TCP egress;
// no table flush/policies or forwarded traffic.
const cp = require('child_process'), os = require('os'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const tag = 'mgu-airplay';
// wlan_bridge is the BMW access point. wlan0 and wlan1 are the two supported
// station backends of mgu-uplink. USB uplinks need no inbound AirPlay rules:
// the phone can use the BMW AP while the app downloads via the USB uplink.
const WLAN = ['wlan_bridge', 'wlan0', 'wlan1'];
const MDNS_HELPER = path.join(__dirname, 'runtime/bin/mgu-airplay-mdns-route');
const MDNS_STATE = '/run/mgu-airplay/mdns-routes.json';
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
function desiredRules(chain, uid, interfaces, discovery) {
    validUid(uid);
    const output = /output$/.test(chain[2]), result = [];
    for (const n of networks(interfaces)) for (const protocol of ['tcp', 'udp']) {
        if (chain[0] !== 'inet' && chain[0] !== n.family) continue;
        // 7100-7102 AirPlay, 7103 DLNA renderer, 7104 PllanaCast for BMW (Android screen).
        const rule = output ? 'oifname "' + n.name + '" ' + n.family + ' daddr ' + n.prefix + ' meta skuid ' + uid + ' ' + protocol + ' sport 7100-7104' :
            'iifname "' + n.name + '" ' + n.family + ' saddr ' + n.prefix + ' ' + protocol + ' dport 7100-7104';
        result.push(rule + ' counter accept comment "' + tag + '"');
    }
    // SSDP discovery of the DLNA renderer (IPv4 only): searches from local
    // phones, the app's answers to them and its multicast announcements.
    if (chain[0] === 'ip' || chain[0] === 'inet') {
        for (const n of networks(interfaces)) {
            if (n.family !== 'ip') continue;
            result.push((output ? 'oifname "' + n.name + '" ip daddr ' + n.prefix + ' meta skuid ' + uid + ' udp sport 1900' :
                'iifname "' + n.name + '" ip saddr ' + n.prefix + ' udp dport 1900') + ' counter accept comment "' + tag + '"');
        }
        if (output) for (const name of WLAN)
            result.push('oifname "' + name + '" ip daddr 239.255.255.250 meta skuid ' + uid + ' udp dport 1900 counter accept comment "' + tag + '"');
    }
    if (output) for (const n of networks(interfaces)) {
        if (chain[0] !== 'inet' && chain[0] !== n.family) continue;
        if (n.family === 'ip6' && n.prefix !== 'fe80::/10' && n.prefix !== 'fc00::/7') continue;
        // DACP publishes a nonprivileged TCP port through DNS-SD. Its exact
        // port can change per phone/session. The client pins requests to the
        // authenticated RAOP peer; this exception grants only this app UID
        // outbound access on local WLANs, never new inbound connections.
        result.push('oifname "' + n.name + '" ' + n.family + ' daddr ' + n.prefix +
            ' meta skuid ' + uid + ' tcp dport 1024-65535 counter accept comment "' + tag + '"');
    }
    if (discovery && (chain[0] === 'ip' || chain[0] === 'inet')) {
        const local = discovery.network + '/' + discovery.prefix;
        if (output) for (const socketUid of discovery.uids) {
            const start = 'oifname "' + discovery.interface + '" ip saddr ' + discovery.ip + ' ip daddr ';
            result.push(start + '224.0.0.251 ip ttl 255 meta skuid ' + socketUid +
                ' udp sport 5353 udp dport 5353 counter accept comment "' + tag + '"');
            result.push(start + local + ' ip ttl 255 meta skuid ' + socketUid +
                ' udp sport 5353 udp dport 1024-65535 counter accept comment "' + tag + '"');
        } else {
            for (const destination of ['224.0.0.251', discovery.ip]) result.push('iifname "' + discovery.interface +
                '" ip saddr ' + local + ' ip daddr ' + destination +
                ' udp dport 5353 counter accept comment "' + tag + '"');
        }
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
function plan(action, uid, before, interfaces, discovery) {
    const commands = [];
    if (action !== 'apply' && action !== 'remove') throw Error('invalid_network_action');
    if (action === 'apply') {
        validUid(uid);
        if (!before.some(c => c.present && c.chain.join(' ') === 'ip filter highprioinput')) throw Error('stock_firewall_missing');
    }
    for (const c of before) {
        if (!c.present) continue;
        const have = ownRules(c.text), want = action === 'apply' ? desiredRules(c.chain, uid, interfaces, discovery) : [];
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
function ipv4(value) {
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value)) return null;
    const words = value.split('.').map(Number);
    return words.some(n => n > 255) ? null : words.reduce((n, word) => ((n << 8) | word) >>> 0, 0);
}
function ipv4Text(number) { return [24, 16, 8, 0].map(shift => (number >>> shift) & 255).join('.'); }
function subnet(address, prefix) {
    const number = ipv4(address);
    if (number === null || !Number.isInteger(prefix) || prefix < 1 || prefix > 32) return null;
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return { first: (number & mask) >>> 0, last: ((number & mask) | ~mask) >>> 0, prefix };
}
function privateSubnet(network) {
    return network && ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'].some(cidr => {
        const parts = cidr.split('/'), range = subnet(parts[0], Number(parts[1]));
        return network.first >= range.first && network.last <= range.last;
    });
}
function interfaceSubnet(address) {
    if (address.cidr) return subnet(address.address, Number(address.cidr.split('/')[1]));
    const mask = ipv4(address.netmask);
    if (mask === null) return null;
    const bits = mask.toString(2);
    return /^1+0*$/.test(bits) ? subnet(address.address, bits.replace(/0+$/, '').length) : null;
}
function discoveryLease(lease, interfaces, uids) {
    if (!lease || (lease.interface !== 'wlan0' && lease.interface !== 'wlan1')) return null;
    const network = subnet(lease.ip, lease.prefix);
    if (!privateSubnet(network)) throw Error('mdns_lease_invalid');
    const current = (interfaces[lease.interface] || []).some(a => !a.internal &&
        (a.family === 'IPv4' || a.family === 4) && a.address === lease.ip &&
        interfaceSubnet(a) && interfaceSubnet(a).prefix === lease.prefix);
    if (!current) return null;
    for (const name of Object.keys(interfaces)) {
        if (name === lease.interface) continue;
        for (const address of interfaces[name]) {
            if (address.internal || (address.family !== 'IPv4' && address.family !== 4)) continue;
            const other = interfaceSubnet(address);
            if (other && network.first <= other.last && other.first <= network.last) throw Error('mdns_subnet_overlap');
        }
    }
    if (!Array.isArray(uids) || !uids.length || uids.length > 16 || uids.some(u => !Number.isInteger(u) || u < 0 || u > 65535))
        throw Error('mdns_service_unavailable');
    return { interface: lease.interface, ip: lease.ip, network: ipv4Text(network.first), prefix: lease.prefix,
        uids: Array.from(new Set(uids)).sort((a, b) => a - b) };
}
function readRootJSON(file, io, max, privateMode) {
    const fd = io.openSync(file, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
    try {
        const stat = io.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== 0 || (stat.mode & 0o022) || stat.size > max ||
            (privateMode && (stat.mode & 0o777) !== 0o600)) throw Error('unsafe_network_state');
        return JSON.parse(io.readFileSync(fd, 'utf8'));
    } finally { io.closeSync(fd); }
}
function uplinkLease(io) {
    try { return readRootJSON('/run/mgu-uplink/lease.json', io || fs, 16384); }
    catch (e) { if (e.code === 'ENOENT') return null; throw Error('mdns_lease_invalid'); }
}
function mdnsSocketUids(io) {
    io = io || fs;
    const unix = io.readFileSync('/proc/net/unix', 'utf8');
    const listeners = new Set(unix.split('\n').map(line => line.trim().split(/\s+/))
        .filter(fields => fields[7] === '/run/mdnsd/mdnsd_uds' && fields[4] === '0001' && fields[3] === '00010000')
        .map(fields => fields[6]));
    if (!listeners.size) return [];
    const sockets = new Map();
    for (const file of ['/proc/net/udp', '/proc/net/udp6']) {
        let text;
        try { text = io.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        for (const line of text.split('\n')) {
            const fields = line.trim().split(/\s+/), uid = Number(fields[7]);
            if (/:14E9$/i.test(fields[1] || '') && /^[0-9]+$/.test(fields[9] || '') && Number.isInteger(uid) && uid >= 0 && uid <= 65535)
                sockets.set(fields[9], uid);
        }
    }
    const result = new Set();
    for (const pid of io.readdirSync('/proc')) {
        if (!/^[0-9]+$/.test(pid)) continue;
        try {
            const base = '/proc/' + pid, executable = io.readlinkSync(base + '/exe').replace(/ \(deleted\)$/, '');
            if (path.basename(executable) !== 'mdnsd') continue;
            const stat = io.statSync(base + '/exe');
            if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) continue;
            const owned = io.readdirSync(base + '/fd').map(fd => {
                try { const match = /^socket:\[([0-9]+)\]$/.exec(io.readlinkSync(base + '/fd/' + fd)); return match && match[1]; }
                catch (e) { if (e.code === 'ENOENT') return null; throw e; }
            });
            if (!owned.some(inode => listeners.has(inode))) continue;
            for (const inode of owned) if (sockets.has(inode)) result.add(sockets.get(inode));
        } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ESRCH') throw e; }
    }
    return Array.from(result).sort((a, b) => a - b);
}
function ruleKey(rule) { return rule.uid + ':' + rule.network + '/' + rule.prefix; }
function routeRules(rules) {
    if (!Array.isArray(rules) || rules.length > 64) throw Error('mdns_route_state_invalid');
    const seen = new Set();
    return rules.map(rule => {
        const network = rule && subnet(rule.network, rule.prefix);
        if (!rule || !Number.isInteger(rule.uid) || rule.uid < 0 || rule.uid > 65535 || !privateSubnet(network) ||
            ipv4Text(network.first) !== rule.network || seen.has(ruleKey(rule))) throw Error('mdns_route_state_invalid');
        seen.add(ruleKey(rule)); return { uid: rule.uid, network: rule.network, prefix: rule.prefix };
    });
}
function routePlan(recorded, status, wanted) {
    recorded = routeRules(recorded); wanted = routeRules(wanted);
    if (!status || status.table !== 110 || status.priority !== 1099 || typeof status.foreign !== 'boolean') throw Error('mdns_route_conflict');
    const have = routeRules(status.rules), recordedKeys = new Set(recorded.map(ruleKey)), desiredKeys = new Set(wanted.map(ruleKey));
    if (wanted.length && (status.foreign || have.some(rule => !recordedKeys.has(ruleKey(rule))))) throw Error('mdns_route_conflict');
    const haveKeys = new Set(have.map(ruleKey));
    return { remove: have.filter(rule => recordedKeys.has(ruleKey(rule)) && !desiredKeys.has(ruleKey(rule))), add: wanted.filter(rule => !haveKeys.has(ruleKey(rule))) };
}
function routeHelper(action, rule, io) {
    const args = [action].concat(rule ? [String(rule.uid), rule.network, String(rule.prefix)] : []);
    const result = io.cp.spawnSync(MDNS_HELPER, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 32768 });
    if (result.status !== 0) {
        const error = Error(result.status === 72 ? 'mdns_route_conflict' : 'mdns_route_failed');
        if (result.status === 72) error.code = 'EEXIST';
        throw error;
    }
    if (action === 'show') { try { return JSON.parse(result.stdout); } catch (e) { throw Error('mdns_route_state_invalid'); } }
}
function writeRouteState(rules, io) {
    const temporary = MDNS_STATE + '.' + process.pid + '-' + crypto.randomBytes(8).toString('hex') + '.tmp';
    let fd, created = false;
    try {
        fd = io.fs.openSync(temporary, io.fs.constants.O_WRONLY | io.fs.constants.O_CREAT | io.fs.constants.O_EXCL | io.fs.constants.O_NOFOLLOW, 0o600);
        created = true;
        io.fs.fchmodSync(fd, 0o600); io.fs.writeFileSync(fd, JSON.stringify({ schema: 1, rules }) + '\n');
        io.fs.closeSync(fd); fd = undefined; io.fs.renameSync(temporary, MDNS_STATE);
    } finally {
        if (fd !== undefined) io.fs.closeSync(fd);
        if (created) try { io.fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
}
function reconcileMdnsRoutes(discovery, io) {
    io = io || { fs, cp };
    let recorded = [];
    try {
        const state = readRootJSON(MDNS_STATE, io.fs, 16384, true);
        if (!state || state.schema !== 1) throw Error('mdns_route_state_invalid'); recorded = routeRules(state.rules);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const wanted = discovery ? discovery.uids.map(uid => ({ uid, network: discovery.network, prefix: discovery.prefix })) : [];
    if (!recorded.length && !wanted.length) return;
    const changes = routePlan(recorded, routeHelper('show', null, io), wanted);
    if (!changes.remove.length && !changes.add.length && JSON.stringify(recorded) === JSON.stringify(wanted)) return;
    let journal = recorded.concat(wanted.filter(rule => !recorded.some(old => ruleKey(old) === ruleKey(rule))));
    // Journal both old and desired exact keys before a netlink mutation. A
    // crash anywhere in the transaction remains recoverable on the next tick.
    writeRouteState(journal, io);
    for (const rule of changes.remove) routeHelper('delete', rule, io);
    for (let index = 0; index < changes.add.length; index++) {
        const rule = changes.add[index];
        try { routeHelper('add', rule, io); }
        catch (e) {
            // An exact rule installed by another root actor after preflight
            // was not created by us. Do not adopt that failed new intent.
            const notOwned = new Set(changes.add.slice(index + (e.code === 'EEXIST' ? 0 : 1)).map(ruleKey));
            journal = journal.filter(old => !notOwned.has(ruleKey(old)) || recorded.some(prior => ruleKey(prior) === ruleKey(old)));
            writeRouteState(journal, io);
            throw e;
        }
    }
    writeRouteState(wanted, io);
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
    const interfaces = os.networkInterfaces();
    let discovery = null, discoveryError = null;
    if (action === 'apply') {
        try {
            const lease = uplinkLease();
            if (lease && (lease.interface === 'wlan0' || lease.interface === 'wlan1'))
                discovery = discoveryLease(lease, interfaces, mdnsSocketUids());
        } catch (e) { discoveryError = e.message; }
    }
    try { reconcileMdnsRoutes(discovery); }
    catch (e) { discovery = null; discoveryError = e.message; }
    const commands = plan(action, uid, before, interfaces, discovery);
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
    if (discoveryError) throw Error(discoveryError);
    return { action, tagged_rules_changed: commands.length, discovery: discovery ? {
        interface: discovery.interface, subnet: discovery.network + '/' + discovery.prefix,
        socket_uids: discovery.uids, routing_table: 110, rule_priority: 1099,
    } : null };
}
module.exports = { WLAN, chains, desiredRules, plan, ipv6Prefix, discoveryLease, mdnsSocketUids, routePlan, reconcileMdnsRoutes };
if (require.main === module) console.log(JSON.stringify(main(process.argv[2], Number(process.argv[3]))));
