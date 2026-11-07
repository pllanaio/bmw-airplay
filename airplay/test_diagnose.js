'use strict';
const assert = require('assert');
const { diagnose, STATUS, RECEIVER, OLD } = require('../apps/pllana_airplay/diagnose');
const io = files => ({ readFileSync: f => { if (!(f in files)) throw Object.assign(Error('ENOENT'), { code: 'ENOENT' }); return JSON.stringify(files[f]); } });
const receiver = { id: 'pllana-airplay-receiver', version: '0.4.0' };
assert(/fehlt/.test(diagnose(13001, io({}))), 'no runtime at all');
assert(/UID 12233.*13001/.test(diagnose(13001, io({ [OLD]: { version: '0.2.4', description: 'UxPlay ... pllana_airplay UID 12233' } }))), 'old runtime bound to another UID');
assert(/antwortet nicht/.test(diagnose(12233, io({ [OLD]: { version: '0.2.4', description: 'pllana_airplay UID 12233' } }))));
assert(/Code 139/.test(diagnose(13001, io({ [RECEIVER]: receiver, [STATUS]: { state: 'backend_exited', uid: 13001, code: 139 } }))));
assert(/wartet/.test(diagnose(13001, io({ [RECEIVER]: receiver, [STATUS]: { state: 'waiting_for_app' } }))));
assert.strictEqual(diagnose(13001, io({ [RECEIVER]: receiver, [STATUS]: { state: 'running', uid: 13001 } })), '');
assert(/12999/.test(diagnose(13001, io({ [RECEIVER]: receiver, [STATUS]: { state: 'running', uid: 12999 } }))));
const { parseUids } = require('./runtime/launch.js');
assert.strictEqual(parseUids('12201=store\n13007=pllana_airplay\n'), 13007);
assert.throws(() => parseUids('13007=pllana_airplay\n13008=pllana_airplay\n'));
console.log('Receiver diagnostics and app UID lookup passed');
// Old runtime removal: once per boot, through the deploy tool, then firewall again.
{
    const { removeLegacy } = require('./runtime/launch.js');
    const EventEmitter = require('events');
    const calls = [], files = new Set(['/var/opt/mgu-airplay/current/component.json', '/var/opt/mgu-deploy/mgu-deploy.sh', '/usr/bin/systemd-run']);
    const fakeFs = { existsSync: f => files.has(f), writeFileSync: f => files.add(f) };
    let job;
    const fakeCp = { spawn: (cmd, args) => { calls.push([cmd].concat(args).join(' ')); job = new EventEmitter(); return job; },
        spawnSync: (cmd, args) => { calls.push([cmd].concat(args).join(' ')); return { status: 0 }; } };
    const statusFile = require('fs'); const write = statusFile.writeFileSync; statusFile.writeFileSync = () => {}; const ren = statusFile.renameSync; statusFile.renameSync = () => {};
    const mk = statusFile.mkdirSync, ch = statusFile.chmodSync, ls = statusFile.lstatSync;
    statusFile.mkdirSync = () => {}; statusFile.chmodSync = () => {}; statusFile.lstatSync = () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 0 });
    const log = console.log; console.log = () => {};
    try {
        assert.strictEqual(removeLegacy(13001, { fs: fakeFs, cp: fakeCp }), true);
        assert(/^systemd-run --unit=pllana-airplay-legacy-removal --wait \/bin\/sh \/var\/opt\/mgu-deploy\/mgu-deploy.sh uninstall mgu-airplay --yes$/.test(calls[0]), calls[0]);
        job.emit('exit', 0);
        assert(/network\.js apply 13001$/.test(calls[1]), 'firewall applied again for the app UID');
        assert.strictEqual(removeLegacy(13001, { fs: fakeFs, cp: fakeCp }), false, 'one attempt per boot');
    } finally {
        console.log = log; statusFile.writeFileSync = write; statusFile.renameSync = ren; statusFile.mkdirSync = mk; statusFile.chmodSync = ch; statusFile.lstatSync = ls;
    }
    console.log('Old runtime removal through the deploy tool passed');
}
