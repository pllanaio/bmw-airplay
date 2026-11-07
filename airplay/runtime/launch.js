'use strict';
// Root supervisor of the Store-installed AirPlay runtime (Node 8).
// Finds the UID the app manager gave pllana_airplay (it differs per head unit
// and can change on reinstall), prepares the bounded firewall/resolver rules
// for exactly that UID, then starts the existing privilege-dropping launcher.
// Never stops or changes the stock CarPlay service.
const cp = require('child_process'), fs = require('fs');
const BASE = '/var/opt/mgu-airplay/current';
const APP = 'pllana_airplay';
if (process.getuid() !== 0) throw Error('root_supervisor_required');

function readOwned(file, owners, max) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const s = fs.fstatSync(fd);
        if (!s.isFile() || s.nlink !== 1 || owners.indexOf(s.uid) < 0 || (s.mode & 0o002) || s.size > max) throw Error('unsafe_input');
        return fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
}
function parseUids(text) {
    const ids = String(text).split('\n').map(l => /^([0-9]+)=([A-Za-z0-9_-]+)\s*$/.exec(l.trim()))
        .filter(m => m && m[2] === APP).map(m => Number(m[1]));
    if (ids.length > 1 || ids.some(id => !Number.isInteger(id) || id < 12203 || id > 65535)) throw Error('invalid_app_identity');
    return ids.length ? ids[0] : null;
}
function appUid() {
    try { const uid = parseUids(readOwned('/var/opt/public/oap/oap_12201/security/uids.txt', [0, 12201], 262144)); if (uid) return uid; }
    catch (e) { if (e.code !== 'ENOENT') console.error('uids.txt: ' + e.message); }
    try {
        const record = JSON.parse(readOwned('/var/opt/public/oap/oap_12201/data/apps/' + APP + '.json', [0, 12201], 65536));
        if (Number.isInteger(record.userId) && record.userId >= 12203 && record.userId <= 65535) return record.userId;
    } catch (e) { if (e.code !== 'ENOENT') console.error('app record: ' + e.message); }
    return null;
}

let child = null, stopping = false, timer = null;
function start() {
    if (stopping) return;
    const uid = appUid();
    const script = uid && '/var/opt/public/oap/oap_' + uid + '/source/javascript/backend.js';
    if (!uid || !fs.existsSync(script)) { console.log('Waiting for the AirPlay app to be installed'); timer = setTimeout(start, 5000); return; }
    const net = cp.spawnSync('/usr/bin/node', [BASE + '/network.js', 'apply', String(uid)], { stdio: 'inherit', timeout: 20000 });
    if (net.status !== 0) console.error('AirPlay network rules not applied; receiver discovery may fail');
    const home = '/var/opt/public/oap/oap_' + uid + '/data';
    child = cp.spawn(BASE + '/runtime/bin/airplay-backend-launch', [String(uid)], {
        stdio: 'inherit', cwd: fs.existsSync(home) ? home : '/',
        env: Object.assign({}, process.env, { HOME: home, MGU_AIRPLAY_RUNTIME: BASE + '/runtime' }),
    });
    child.on('error', e => { console.error(e.message); process.exitCode = 1; });
    // systemd restarts the unit (and re-runs the UID lookup) when the backend ends.
    child.on('exit', (code, signal) => { process.exit(stopping ? 0 : (signal ? 1 : code || 0)); });
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
    stopping = true; clearTimeout(timer);
    if (child) child.kill(sig); else process.exit(0);
});
module.exports = { parseUids };
if (require.main === module) start();
