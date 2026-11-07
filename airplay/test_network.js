'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const EventEmitter = require('events');
const { WLAN, chains, desiredRules, plan, ipv6Prefix } = require('./network');
const uid = 13007;
const empty = () => chains.map(chain => ({ chain, present: true, text: '' }));
function installed(interfaces) {
    return chains.map(chain => ({ chain, present: true, text: desiredRules(chain, uid, interfaces).map((rule, i) =>
        '    ' + rule.replace('counter accept', 'counter packets 19 bytes 4028 accept') + ' # handle ' + (i + 1)).join('\n') }));
}
const initial = plan('apply', uid, empty(), {});
assert(initial.some(line => /iifname "wlan_bridge" ip saddr .* tcp dport 7100-7102/.test(line)), 'BMW AP supports a local phone without an uplink lease');
assert(initial.some(line => /iifname "wlan0"/.test(line)), 'legacy hotspot station retained');
assert(initial.some(line => /iifname "wlan1"/.test(line)), 'second uplink station supported');
assert.deepStrictEqual(WLAN, ['wlan_bridge', 'wlan0', 'wlan1']);
assert(initial.every(line => /(?:tcp|udp) (?:sport|dport) 7100-7102/.test(line) ||
    /oifname .* meta skuid 13007 tcp dport 1024-65535/.test(line)), 'only receiver transport or app-owned local DACP egress');
assert(initial.filter(line => /tcp dport 1024-65535/.test(line)).every(line =>
    /oifname "(?:wlan_bridge|wlan0|wlan1)" (?:ip|ip6) daddr (?:10\.0\.0\.0\/8|172\.16\.0\.0\/12|192\.168\.0\.0\/16|169\.254\.0\.0\/16|fe80::\/10|fc00::\/7) meta skuid 13007/.test(line)),
    'DACP cannot reach public/privileged ports or change incoming policy');
assert(initial.filter(line => /oifname/.test(line)).every(line => /meta skuid 13007/.test(line)), 'outbound exceptions restricted to app UID');
assert(!initial.some(line => /forward|policy|flush|vethuplink|eth0|5353/.test(line)), 'no global or USB forwarding/discovery exceptions');
assert.deepStrictEqual(plan('apply', uid, installed({}), {}), [], 'counter changes never trigger a firewall rewrite');
assert.deepStrictEqual(plan('apply', uid, installed({}), { vethuplink: [{ address: '192.168.8.100', family: 'IPv4' }] }), [], 'separate USB Internet uplink does not change the local phone rules');

// Uplink replaces only its own table on hotplug/UID changes. Restore that
// table's rules without touching the unchanged BMW firewall or foreign rules.
const replaced = installed({});
for (const chain of replaced) if (chain.chain[0] === 'inet') chain.text = 'iifname "wlan1" counter drop # handle 900';
const repaired = plan('apply', uid, replaced, {});
assert(repaired.length > 0 && repaired.every(line => /^insert rule inet mgu_uplink /.test(line)));
assert(!repaired.some(line => /handle 900/.test(line)), 'foreign rules preserved');
const notStarted = installed({});
for (const chain of notStarted) if (chain.chain[0] === 'inet') chain.present = false;
assert.deepStrictEqual(plan('apply', uid, notStarted, {}), [], 'local mirroring works with no mgu-uplink table');

// A changed IPv6 lease updates only affected family/inet chains; nft's zero
// compression and packet counters do not make the reconciler rewrite forever.
const addresses = { wlan1: [{ family: 'IPv6', internal: false, address: '2001:db8:0:0::4', cidr: '2001:db8::4/64' }] };
assert.strictEqual(ipv6Prefix(addresses.wlan1[0]), '2001:db8:0:0::/64');
const ipv6 = installed(addresses);
for (const chain of ipv6) chain.text = chain.text.replace(/2001:db8:0:0::\/64/g, '2001:db8::/64');
assert.deepStrictEqual(plan('apply', uid, ipv6, addresses), [], 'canonical IPv6 prefixes compare equal');
const changed = plan('apply', uid, installed({}), addresses);
assert(changed.length > 0 && changed.every(line => !/^\w+ rule ip filter /.test(line)), 'IPv4 chains unchanged by IPv6 address change');
assert(!changed.some(line => /2001:db8/.test(line) && /tcp dport 1024-65535/.test(line)), 'global IPv6 prefixes gain no DACP egress');
const removal = plan('remove', NaN, installed({}), {});
assert(removal.length > 0 && removal.every(line => /^delete rule .* handle \d+$/.test(line)), 'remove deletes only tagged handles');
assert.throws(() => plan('apply', 0, empty(), {}), /invalid_receiver_uid/);
assert.throws(() => plan('apply', uid, [], {}), /stock_firewall_missing/);
assert.throws(() => plan('apply', uid, empty().map(c => Object.assign({}, c, { text: 'counter accept comment "mgu-airplay"' })), {}), /nft_rule_handle_missing/);

// Execute the supervisor with fake root/systemd I/O. Verify that the monitor
// repairs after startup, reports errors/recovery and is cancelled on both
// service stop and backend exit, so no firewall work survives shutdown.
function supervisor() {
    const timeouts = new Map(), intervals = new Map(), signals = {}, calls = [], statuses = [], exits = [];
    let serial = 0, failure = null;
    const child = new EventEmitter(); child.kill = sig => calls.push(['kill', sig]);
    const fakeFs = {
        constants: fs.constants,
        existsSync: file => file.indexOf('/var/opt/mgu-airplay/') < 0,
        openSync: () => 10, closeSync: () => {},
        fstatSync: () => ({ isFile: () => true, uid: 0, nlink: 1, mode: 0o644, size: 100 }),
        readFileSync: file => typeof file === 'number' ? '13007=pllana_airplay\n' : '{}',
        mkdirSync: () => {}, chmodSync: () => {}, renameSync: () => {},
        lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 0 }),
        writeFileSync: (file, data) => statuses.push(JSON.parse(data)),
    };
    const fakeCp = {
        spawnSync: (cmd, args) => { calls.push([cmd].concat(args)); return failure ? { status: 1, stderr: failure } : { status: 0 }; },
        spawn: () => child,
    };
    const mod = { exports: {} }, fakeRequire = name => name === 'fs' ? fakeFs : name === 'child_process' ? fakeCp : require(name);
    fakeRequire.main = mod;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'runtime/launch.js'), 'utf8'), {
        require: fakeRequire, module: mod, __dirname: '/receiver',
        console: { log: () => {}, error: () => {} },
        process: { pid: 9, getuid: () => 0, env: {}, on: (name, fn) => { signals[name] = fn; }, exit: code => exits.push(code) },
        setTimeout: (fn, delay) => { const id = ++serial; timeouts.set(id, { fn, delay }); return id; },
        clearTimeout: id => timeouts.delete(id),
        setInterval: (fn, delay) => { const id = ++serial; intervals.set(id, { fn, delay }); return id; },
        clearInterval: id => intervals.delete(id),
    });
    const running = Array.from(timeouts.entries()).find(entry => entry[1].delay === 3000);
    timeouts.delete(running[0]); running[1].fn();
    return { intervals, timeouts, signals, child, calls, statuses, exits, fail: value => { failure = value; } };
}
{
    const s = supervisor();
    assert.strictEqual(s.intervals.size, 1);
    const tick = Array.from(s.intervals.values())[0];
    assert.strictEqual(tick.delay, 5000);
    const before = s.statuses.length;
    tick.fn();
    assert.strictEqual(s.statuses.length, before, 'unchanged network status is not rewritten');
    s.fail('nft_table_changed'); tick.fn();
    assert.strictEqual(s.statuses[s.statuses.length - 1].network, 'failed: nft_table_changed');
    s.fail(null); tick.fn();
    assert.strictEqual(s.statuses[s.statuses.length - 1].network, 'ok');
    s.signals.SIGTERM();
    assert.strictEqual(s.intervals.size, 0, 'network monitor cancelled on stop');
    assert.strictEqual(s.timeouts.size, 0, 'legacy-removal timeout cancelled on stop');
}
{
    const s = supervisor();
    s.child.emit('exit', 75, null);
    assert.strictEqual(s.intervals.size, 0, 'network monitor cancelled on backend exit');
    assert.strictEqual(s.timeouts.size, 0, 'legacy-removal timeout cancelled on backend exit');
    assert.deepStrictEqual(s.exits, [75]);
}
console.log('Hotspot-free local network rules and uplink firewall reconciliation passed');
