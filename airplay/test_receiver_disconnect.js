'use strict';
// Exercise actual detached Linux process groups. The fixture deliberately does
// not need UxPlay, DNS-SD, or a phone; native TCP shutdown is tested separately.
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

function fixtureLeader() {
    const mode = process.argv[3], ready = process.argv[4];
    if (mode === 'ignore-term') process.on('SIGTERM', function () {});
    else if (mode !== 'normal') process.on('SIGTERM', function () { process.exit(0); });
    const child = childProcess.spawn(process.execPath,
        [__filename, '--fixture-worker', mode, ready, String(process.pid)], {
            detached: false,
            stdio: mode === 'leader-exit-closed-pipes' ? ['ignore', 'ignore', 'ignore'] : ['ignore', 1, 2]
        });
    child.on('error', function () { process.exit(2); });
    setInterval(function () {}, 1000);
}

function fixtureWorker() {
    const mode = process.argv[3], ready = process.argv[4], leader = Number(process.argv[5]);
    if (mode !== 'normal') process.on('SIGTERM', function () {});
    const server = net.createServer(function (socket) { socket.write('fixture-ready\n'); });
    server.on('error', function () { process.exit(2); });
    server.listen(0, '127.0.0.1', function () {
        fs.writeFileSync(ready + '.tmp', JSON.stringify({ leader: leader, worker: process.pid, port: server.address().port }),
            { mode: 0o600, flag: 'wx' });
        fs.renameSync(ready + '.tmp', ready);
    });
}

function bounded(promise, milliseconds, message) {
    return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () { reject(Error(message)); }, milliseconds);
        Promise.resolve(promise).then(function (value) { clearTimeout(timer); resolve(value); },
            function (error) { clearTimeout(timer); reject(error); });
    });
}

function waitFor(predicate, milliseconds, message) {
    const until = Date.now() + milliseconds;
    return new Promise(function (resolve, reject) {
        function poll() {
            try { const value = predicate(); if (value) { resolve(value); return; } }
            catch (error) { reject(error); return; }
            if (Date.now() >= until) { reject(Error(message)); return; }
            setTimeout(poll, 20);
        }
        poll();
    });
}

function processStat(pid) {
    try {
        const text = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
        return { state: fields[0], group: Number(fields[2]), start: fields[19] };
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}

function liveGroup(group) {
    return fs.readdirSync('/proc').filter(function (name) {
        if (!/^\d+$/.test(name)) return false;
        const stat = processStat(name);
        // A container's PID 1 may leave orphan zombies unreaped. They cannot
        // execute or retain sockets, so require every live member to be gone.
        return stat && stat.group === group && stat.state !== 'Z' && stat.state !== 'X';
    });
}

async function exercise(mode) {
    const Receiver = require('../apps/pllana_airplay/receiver').Receiver;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'airplay-disconnect-'));
    const readyFile = path.join(directory, 'fixture.json');
    let child, socket, group, socketClosed = false;
    const receiver = new Receiver({ dataDir: directory, audioSink: 'fakesink', hls: false,
        skipRuntimeCheck: true, spawn: function (binary, args, options) {
            assert.strictEqual(options.detached, true, 'Receiver creates a separate process group');
            child = childProcess.spawn(process.execPath, [__filename, '--fixture-leader', mode, readyFile],
                Object.assign({}, options, { env: process.env }));
            return child;
        } });
    const signals = [], realSignal = receiver.signal;
    receiver.signal = function (target, signal) {
        signals.push(signal);
        return realSignal.call(this, target, signal);
    };
    try {
        assert(receiver.start());
        group = child.pid;
        const ready = await waitFor(function () {
            if (!fs.existsSync(readyFile)) return null;
            return JSON.parse(fs.readFileSync(readyFile, 'utf8'));
        }, 3000, mode + ': fixture did not start');
        assert.strictEqual(ready.leader, group);
        assert.strictEqual(processStat(group).group, group);
        assert.strictEqual(processStat(ready.worker).group, group, 'descendant stays in receiver group');
        socket = net.connect(ready.port, '127.0.0.1');
        const closed = new Promise(function (resolve) { socket.once('close', function () { socketClosed = true; resolve(); }); });
        socket.on('error', function () {});
        await bounded(new Promise(function (resolve, reject) {
            let pending = '';
            function received(data) {
                pending += String(data);
                if (pending === 'fixture-ready\n') { socket.removeListener('data', received); resolve(); }
                else if (pending.length >= 14 || pending.indexOf('\n') >= 0) reject(Error('unexpected fixture response'));
            }
            socket.on('data', received);
            socket.once('error', reject);
        }), 1500, mode + ': TCP connection did not become ready');
        let leaderExited = false;
        child.once('exit', function () { leaderExited = true; });
        const stop = receiver.stop();
        assert.strictEqual(receiver.stop(), stop, 'concurrent stop calls share completion');
        assert.strictEqual(receiver.start(), false, 'disconnect must finish before a new receiver starts');
        if (mode === 'ignore-term') {
            await new Promise(function (resolve) { setTimeout(resolve, 120); });
            assert(!leaderExited && !socketClosed, 'TERM-ignoring fixture stays live until escalation');
        }
        await bounded(stop, 7000, mode + ': disconnect did not complete');
        await bounded(closed, 1000, mode + ': sender TCP connection survived disconnect');
        await waitFor(function () { return liveGroup(group).length === 0; }, 1000,
            mode + ': live descendants survived disconnect');
        assert.strictEqual(receiver.child, null);
        assert.strictEqual(receiver.stopPromise, null);
        assert.strictEqual(receiver.state.phase, 'stopped');
        assert.strictEqual(signals[0], 'SIGTERM');
        if (mode === 'normal') assert(signals.indexOf('SIGKILL') < 0, 'cooperative group needs no forced kill');
        else assert(signals.indexOf('SIGKILL') >= 0, 'remaining group is forcibly terminated');
        await receiver.stop();
    } finally {
        if (group) try { process.kill(-group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        if (socket) socket.destroy();
        await bounded(receiver.destroy().catch(function () {}), 7000, mode + ': fixture cleanup timed out');
        fs.readdirSync(directory).forEach(function (name) {
            const file = path.join(directory, name);
            if (fs.statSync(file).isFile()) fs.unlinkSync(file);
        });
        fs.rmdirSync(directory);
    }
}

async function main() {
    if (process.platform !== 'linux') throw Error('Receiver process-group integration requires Linux /proc');
    for (const mode of ['normal', 'ignore-term', 'leader-exit-open-pipes', 'leader-exit-closed-pipes']) await exercise(mode);
    console.log('Receiver disconnect: real process groups, TERM escalation, exited leaders, inherited pipes and TCP EOF passed');
}

if (process.argv[2] === '--fixture-leader') fixtureLeader();
else if (process.argv[2] === '--fixture-worker') fixtureWorker();
else main().catch(function (error) { console.error(error); process.exitCode = 1; });
