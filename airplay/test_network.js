'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const EventEmitter = require('events');
const { WLAN, chains, desiredRules, plan, ipv6Prefix, discoveryLease, mdnsSocketUids, routePlan, reconcileMdnsRoutes } = require('./network');
const uid = 13007;
const empty = () => chains.map(chain => ({ chain, present: true, text: '' }));
function installed(interfaces, discovery) {
    return chains.map(chain => ({ chain, present: true, text: desiredRules(chain, uid, interfaces, discovery).map((rule, i) =>
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

// The iPhone can be both hotspot gateway and sender. No BMW AP is required:
// Bonjour must use that exact station lease and the shared daemon's sockets.
const hotspot = { interface: 'wlan1', ip: '172.20.10.2', prefix: 28 };
const station = { wlan1: [{ address: hotspot.ip, family: 'IPv4', internal: false, cidr: hotspot.ip + '/28' }] };
const discovery = discoveryLease(hotspot, station, [65534, 0, 65534]);
assert.deepStrictEqual(discovery, { interface: 'wlan1', ip: '172.20.10.2', network: '172.20.10.0', prefix: 28, uids: [0, 65534] });
assert.strictEqual(discoveryLease({ interface: 'vethuplink' }, {}, []), null, 'USB retains the existing BMW AP path');
assert.strictEqual(discoveryLease(hotspot, {}, [0]), null, 'a stale lease cannot open another interface');
assert.throws(() => discoveryLease(Object.assign({}, hotspot, { ip: '1.1.1.2', prefix: 24 }), station, [0]), /mdns_lease_invalid/);
assert.deepStrictEqual(discoveryLease(hotspot, station, []).uids, [], 'without a BMW mdnsd socket the app responder still gets uplink rules');
assert.throws(() => discoveryLease(hotspot, station, [70000]), /mdns_service_unavailable/);
const overlapping = Object.assign({}, station, { wlan_bridge: [{ address: '172.20.10.1', family: 'IPv4', internal: false, netmask: '255.255.255.0' }] });
assert.throws(() => discoveryLease(hotspot, overlapping, [0]), /mdns_subnet_overlap/, 'ambiguous BMW/hotspot subnets are left intact');
const safeAP = Object.assign({}, station, { wlan_bridge: [{ address: '192.168.43.1', family: 'IPv4', internal: false, cidr: '192.168.43.1/24' }] });
assert(discoveryLease(hotspot, safeAP, [0]));
const mdns = plan('apply', uid, empty(), station, discovery).filter(line => /5353/.test(line));
assert(mdns.length > 0 && mdns.every(line => /(?:iifname|oifname) "wlan1"/.test(line)));
assert(mdns.filter(line => /oifname/.test(line) && /meta skuid (?:0|65534) /.test(line)).every(line => /ip ttl 255/.test(line)), 'daemon responses keep TTL 255');
assert(mdns.some(line => new RegExp('oifname "wlan1" ip saddr 172\\.20\\.10\\.2 ip daddr 224\\.0\\.0\\.251 meta skuid ' + uid + ' udp sport 5353 udp dport 5353').test(line)), 'app responder multicast');
assert(mdns.some(line => new RegExp('ip daddr 172\\.20\\.10\\.0/28 meta skuid ' + uid + ' udp sport 5353 counter').test(line)), 'app responder unicast replies incl. QU to port 5353');
assert(mdns.filter(line => /iifname/.test(line)).every(line => !/ip ttl/.test(line)),
    'lease-bound multicast and legacy unicast queries may use a lower TTL; outgoing mDNS responses keep255');
assert(mdns.filter(line => /oifname/.test(line)).every(line => /ip saddr 172\.20\.10\.2/.test(line) && new RegExp('meta skuid (?:0|65534|' + uid + ') udp sport 5353').test(line)),
    'even root-owned daemon sockets receive only bounded Bonjour output, never general Internet');
assert(mdns.some(line => /ip daddr 172\.20\.10\.0\/28.*udp sport 5353 udp dport 1024-65535/.test(line)),
    'legacy unicast queries from ephemeral ports receive a bounded unicast reply');
assert(mdns.some(line => /ip daddr 224\.0\.0\.251.*udp dport 5353/.test(line)));
assert(!mdns.some(line => /ip6|forward|policy|flush|vethuplink/.test(line)));
assert.deepStrictEqual(plan('apply', uid, installed(station, discovery), station, discovery), [], 'Bonjour counters cause no periodic rewrites');
assert(plan('apply', uid, installed(station, discovery), {}, null).some(line => /^delete rule /.test(line)), 'lease loss removes its tagged discovery rules');

const procLinks = {
    '/proc/12/exe': '/usr/sbin/mdnsd', '/proc/12/fd/3': 'socket:[101]', '/proc/12/fd/4': 'socket:[201]', '/proc/12/fd/5': 'socket:[202]',
    '/proc/44/exe': '/tmp/mdnsd', '/proc/44/fd/3': 'socket:[101]', '/proc/44/fd/4': 'socket:[203]',
    '/proc/55/exe': '/usr/sbin/other', '/proc/55/fd/3': 'socket:[101]', '/proc/55/fd/4': 'socket:[204]',
    '/proc/66/exe': '/usr/sbin/mdnsd', '/proc/66/fd/4': 'socket:[205]',
};
const udp = (owner, inode) => ' 1: 00000000:14E9 00000000:0000 07 00000000:00000000 00:00000000 00000000 ' + owner + ' 0 ' + inode + ' 2 0';
const procFs = {
    readFileSync: file => file === '/proc/net/unix' ? '0000: 00000002 00000000 00010000 0001 01 101 /run/mdnsd/mdnsd_uds\n' :
        file === '/proc/net/udp' ? [[0,201],[65534,202],[13007,203],[13008,204],[13009,205]].map(pair => udp(pair[0],pair[1])).join('\n') : '',
    readlinkSync: file => procLinks[file],
    statSync: file => ({ isFile: () => true, uid: file.indexOf('/44/') >= 0 ? 13007 : 0, mode: 0o100555 }),
    readdirSync: file => file === '/proc' ? ['12','44','55','66','self'] : Object.keys(procLinks).filter(name => name.indexOf(file + '/') === 0).map(name => name.slice(file.length + 1)),
};
assert.deepStrictEqual(mdnsSocketUids(procFs), [0, 65534], 'prove listener+5353 inode ownership and use socket UID rather than daemon process UID');
assert.deepStrictEqual(mdnsSocketUids(Object.assign({},procFs,{readFileSync:()=>''})), [], 'a missing BMW discovery service grants nothing');

const oldRule = { uid: 0, network: '172.20.10.0', prefix: 28 };
const nextRule = { uid: 65534, network: '192.168.5.0', prefix: 24 };
const status = rules => ({ table: 110, priority: 1099, foreign: false, rules });
assert.deepStrictEqual(routePlan([oldRule],status([oldRule]),[oldRule]),{remove:[],add:[]});
assert.deepStrictEqual(routePlan([oldRule],status([oldRule]),[nextRule]),{remove:[oldRule],add:[nextRule]});
assert.throws(()=>routePlan([],status([oldRule]),[oldRule]),/mdns_route_conflict/,'an unjournaled rule at our priority is foreign');
assert.throws(()=>routePlan([oldRule],Object.assign(status([oldRule]),{foreign:true}),[oldRule]),/mdns_route_conflict/);
assert.deepStrictEqual(routePlan([oldRule],Object.assign(status([oldRule,nextRule]),{foreign:true}),[]),{remove:[oldRule],add:[]},
    'stop removes only its recorded exact rule even alongside a foreign collision');

function routingIO() {
    let state = null, temporary = null, kernel = [], serial = 0, failAdd = 0, collision = 0;
    const mutations = [], journals = [];
    const enoent = () => { const error = Error('missing'); error.code = 'ENOENT'; throw error; };
    const io = { fs: {
        constants: fs.constants,
        openSync: (file, flags) => { assert(flags & fs.constants.O_NOFOLLOW); if (file.endsWith('/mdns-routes.json')) { if (!state) enoent(); return 1; } return 2; },
        fstatSync: () => ({ isFile: () => true, nlink: 1, uid: 0, mode: 0o100600, size: state ? JSON.stringify(state).length : 0 }),
        readFileSync: () => JSON.stringify(state), closeSync: () => {}, fchmodSync: (fd,mode) => assert.strictEqual(mode,0o600),
        writeFileSync: (fd,text) => { temporary=JSON.parse(text); },
        renameSync: () => { state=temporary; temporary=null; journals.push(state); }, unlinkSync: () => {},
    }, cp: { spawnSync: (binary,args) => {
        assert(binary.endsWith('/runtime/bin/mgu-airplay-mdns-route'));
        if(args[0]==='show') return {status:0,stdout:JSON.stringify(status(kernel))};
        const rule={uid:Number(args[1]),network:args[2],prefix:Number(args[3])};
        assert(state.rules.some(item=>JSON.stringify(item)===JSON.stringify(rule)),'journal exact ownership before every kernel mutation');
        mutations.push(args);
        if(args[0]==='add') { if(++serial===failAdd) return {status:71}; if(serial===collision) { kernel.push(rule); return {status:72}; } kernel.push(rule); }
        else kernel=kernel.filter(item=>JSON.stringify(item)!==JSON.stringify(rule));
        return {status:0};
    } } };
    return {io,mutations,journals,getState:()=>state,getKernel:()=>kernel,setKernel:rules=>{kernel=rules;},fail:attempt=>{failAdd=attempt;},collide:attempt=>{collision=attempt;}};
}
{
    const test=routingIO();
    reconcileMdnsRoutes(discovery,test.io);
    assert.strictEqual(test.getKernel().length,2);assert.strictEqual(test.journals.length,2);
    const count=test.mutations.length,journalCount=test.journals.length;
    reconcileMdnsRoutes(discovery,test.io);
    assert.strictEqual(test.mutations.length,count);assert.strictEqual(test.journals.length,journalCount,'unchanged routes and journal are not rewritten');
    const changedDiscovery=Object.assign({},discovery,{interface:'wlan0',ip:'192.168.5.2',network:'192.168.5.0',prefix:24,uids:[65534]});
    reconcileMdnsRoutes(changedDiscovery,test.io);
    assert.deepStrictEqual(test.getKernel(),[nextRule]);
    test.setKernel(test.getKernel().concat([oldRule]));
    reconcileMdnsRoutes(null,test.io);
    assert.deepStrictEqual(test.getKernel(),[oldRule],'cleanup preserves an unjournaled foreign exact-shape rule');
    assert.deepStrictEqual(test.getState().rules,[]);
}
{
    const test=routingIO();test.fail(2);
    assert.throws(()=>reconcileMdnsRoutes(discovery,test.io),/mdns_route_failed/);
    assert.strictEqual(test.getKernel().length,1);assert.strictEqual(test.getState().rules.length,2,'a partial transaction keeps both intended exact keys journaled');
    reconcileMdnsRoutes(discovery,test.io);
    assert.strictEqual(test.getKernel().length,2,'the next tick completes a partially installed transaction');
    reconcileMdnsRoutes(null,test.io);assert.deepStrictEqual(test.getKernel(),[]);
}
{
    const test=routingIO();test.collide(2);
    assert.throws(()=>reconcileMdnsRoutes(Object.assign({},discovery,{uids:[0,100,65534]}),test.io),/mdns_route_conflict/);
    assert.strictEqual(test.getState().rules.length,1,'an EXCL collision removes the failed new intent from our ownership journal');
    reconcileMdnsRoutes(null,test.io);
    assert.deepStrictEqual(test.getKernel(),[{uid:100,network:'172.20.10.0',prefix:28}],
        'stop leaves the exact rule another root actor installed during our transaction intact');
}

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
