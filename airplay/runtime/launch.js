'use strict';
// Root supervisor of the Store-installed AirPlay receiver (Node 8).
// Finds the UID the app manager gave pllana_airplay (it differs per head unit
// and can change on reinstall), prepares the bounded firewall/resolver rules
// for exactly that UID, then starts the privilege-dropping launcher.
// Every step is written to /run/pllana-airplay/status.json, which the app
// shows when it cannot reach the receiver. Never touches CarPlay.
const cp = require('child_process'), fs = require('fs'), path = require('path');
const BASE = __dirname;
const APP = 'pllana_airplay';
const STATUS_DIR = '/run/pllana-airplay', STATUS = STATUS_DIR + '/status.json';

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
let version = '';
try { version = JSON.parse(fs.readFileSync(path.join(BASE, 'runtime/build-manifest.json'), 'utf8')).version || ''; } catch (e) { /* none */ }
function status(state, extra) {
    const record = Object.assign({ state, version, at: new Date().toISOString(), pid: process.pid }, extra || {});
    try {
        try { fs.mkdirSync(STATUS_DIR, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        const st = fs.lstatSync(STATUS_DIR);
        if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0) return;
        fs.chmodSync(STATUS_DIR, 0o755);
        const tmp = STATUS + '.' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o644 });
        fs.chmodSync(tmp, 0o644); fs.renameSync(tmp, STATUS);
    } catch (e) { console.error('status: ' + e.message); }
    console.log('AirPlay receiver: ' + state + (extra ? ' ' + JSON.stringify(extra) : ''));
}

let child = null, stopping = false, timer = null;
function start() {
    if (stopping) return;
    let uid = null;
    try { uid = appUid(); } catch (e) { status('app_identity_invalid', { error: e.message }); timer = setTimeout(start, 10000); return; }
    const script = uid && '/var/opt/public/oap/oap_' + uid + '/source/javascript/backend.js';
    if (!uid || !fs.existsSync(script)) { status('waiting_for_app', { uid }); timer = setTimeout(start, 5000); return; }
    const net = cp.spawnSync('/usr/bin/node', [path.join(BASE, 'network.js'), 'apply', String(uid)], { encoding: 'utf8', timeout: 20000 });
    const netError = net.status === 0 ? null : String(net.stderr || net.error || 'failed').trim().split('\n').pop().slice(0, 200);
    if (netError) console.error('AirPlay network rules not applied: ' + netError);
    const home = '/var/opt/public/oap/oap_' + uid + '/data';
    status('starting', { uid, network: netError ? 'failed: ' + netError : 'ok' });
    child = cp.spawn(path.join(BASE, 'runtime/bin/airplay-backend-launch'), [String(uid)], {
        stdio: 'inherit', cwd: fs.existsSync(home) ? home : '/',
        env: Object.assign({}, process.env, { HOME: home, MGU_AIRPLAY_RUNTIME: path.join(BASE, 'runtime') }),
    });
    const started = Date.now();
    const running = setTimeout(() => { if (child) status('running', { uid, network: netError ? 'failed' : 'ok' }); }, 3000);
    child.on('error', e => status('backend_launch_failed', { uid, error: e.message }));
    // systemd restarts the unit (and re-runs the UID lookup) when the backend ends.
    child.on('exit', (code, signal) => {
        clearTimeout(running);
        if (!stopping) status('backend_exited', { uid, code, signal, afterSeconds: Math.round((Date.now() - started) / 1000) });
        process.exit(stopping ? 0 : (signal ? 1 : code || 1));
    });
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
    stopping = true; clearTimeout(timer); status('stopped');
    if (child) child.kill(sig); else process.exit(0);
});
module.exports = { parseUids };
if (require.main === module) {
    if (process.getuid() !== 0) throw Error('root_supervisor_required');
    start();
}
