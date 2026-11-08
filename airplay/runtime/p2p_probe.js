'use strict';
// Root-only, read-only Wi-Fi Direct (P2P) capability probe for Miracast.
// Miracast needs a Wi-Fi Direct group between phone and head unit. This
// only reports what the radio and the system wpa_supplicant can do; it never
// creates interfaces, changes the radio, or touches mgu-uplink/CarPlay.
// Result: /run/pllana-airplay/p2p.json (0644), shown in the app.
const cp = require('child_process'), fs = require('fs'), path = require('path');
const OUT_DIR = '/run/pllana-airplay', OUT = OUT_DIR + '/p2p.json';

function parseIw(text) {
    const phys = [];
    for (const block of String(text || '').split(/^Wiphy /m).slice(1)) {
        const lines = block.split('\n'), name = lines[0].trim();
        if (!/^phy[0-9]{1,3}$/.test(name)) continue;
        const section = title => {
            const at = lines.findIndex(l => l.trim() === title);
            if (at < 0) return [];
            const out = [];
            for (let i = at + 1; i < lines.length; i++) {
                const line = lines[i];
                if (/^\t\t \* /.test(line)) out.push(line.replace(/^\t\t \* /, '').trim());
                else if (/^\t\t {3}/.test(line) && out.length) out[out.length - 1] += ' ' + line.trim();
                else break;
            }
            return out;
        };
        const modes = section('Supported interface modes:');
        const combinations = section('valid interface combinations:').map(c => c.slice(0, 200));
        // P2P concurrently with the station the uplink uses: one combination
        // must hold "managed" and a P2P mode, and allow two or more interfaces.
        const concurrent = combinations.some(c => /managed/.test(c) && /P2P-(?:GO|client)/.test(c) && /total <= ([2-9]|[1-9][0-9])/.test(c));
        phys.push({ phy: name, p2pGo: modes.indexOf('P2P-GO') >= 0, p2pClient: modes.indexOf('P2P-client') >= 0,
            p2pDevice: modes.indexOf('P2P-device') >= 0, ap: modes.indexOf('AP') >= 0, concurrent, modes: modes.slice(0, 16), combinations: combinations.slice(0, 8) });
    }
    return phys;
}
function binaryHas(file, needle, io) {
    try {
        const st = io.statSync(file);
        if (!st.isFile() || st.size > 32 * 1024 * 1024) return false;
        return io.readFileSync(file).indexOf(needle) >= 0;
    } catch (e) { return false; }
}
function probe(base, io) {
    io = io || { fs, cp };
    const record = { at: new Date().toISOString(), phys: [], drivers: {}, wpaSupplicant: null, interfaces: [], iw: 'missing' };
    try {
        for (const phy of io.fs.readdirSync('/sys/class/ieee80211')) {
            if (!/^phy[0-9]{1,3}$/.test(phy)) continue;
            try { record.drivers[phy] = path.basename(io.fs.readlinkSync('/sys/class/ieee80211/' + phy + '/device/driver')).slice(0, 40); }
            catch (e) { record.drivers[phy] = null; }
        }
    } catch (e) { /* no wireless class */ }
    try { record.interfaces = io.fs.readdirSync('/sys/class/net').filter(n => /^[a-z0-9_.-]{1,15}$/i.test(n) && io.fs.existsSync('/sys/class/net/' + n + '/wireless')); }
    catch (e) { /* none */ }
    const runtime = path.join(base, 'runtime');
    const iw = path.join(runtime, 'bin/iw');
    if (io.fs.existsSync(iw)) {
        const r = io.cp.spawnSync(path.join(runtime, 'lib/ld-linux-x86-64.so.2'), ['--library-path', path.join(runtime, 'lib'), iw, 'phy'],
            { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
        record.iw = r.status === 0 ? 'ok' : 'failed';
        if (r.status === 0) record.phys = parseIw(r.stdout);
    }
    for (const file of ['/usr/sbin/wpa_supplicant', '/sbin/wpa_supplicant', '/usr/bin/wpa_supplicant']) {
        if (!io.fs.existsSync(file)) continue;
        record.wpaSupplicant = { path: file, p2p: binaryHas(file, 'P2P_FIND', io.fs) };
        break;
    }
    const capable = record.phys.some(p => p.p2pGo || p.p2pClient);
    record.summary = record.iw !== 'ok' ? 'unknown' : !capable ? 'unsupported' : record.phys.some(p => (p.p2pGo || p.p2pClient) && p.concurrent) ? 'concurrent' : 'exclusive';
    return record;
}
function write(record) {
    try { fs.mkdirSync(OUT_DIR, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const st = fs.lstatSync(OUT_DIR);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0) throw Error('unsafe_status_directory');
    const tmp = OUT + '.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o644 });
    fs.chmodSync(tmp, 0o644); fs.renameSync(tmp, OUT);
}
module.exports = { parseIw, probe, OUT };
if (require.main === module) {
    if (process.getuid() !== 0) throw Error('root_required');
    const record = probe(__dirname);
    write(record);
    console.log('Wi-Fi Direct probe: ' + record.summary + ' ' + JSON.stringify(record.phys.map(p => ({ phy: p.phy, go: p.p2pGo, client: p.p2pClient, concurrent: p.concurrent }))));
}
