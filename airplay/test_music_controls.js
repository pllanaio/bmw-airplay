'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const http = require('http'), EventEmitter = require('events');
const { MusicControls, localHost, readSender, parseStatus } = require('../apps/pllana_airplay/music_controls');

function field(tag, value, length) {
    const b = Buffer.alloc(8 + length); b.write(tag, 0); b.writeUInt32BE(length, 4);
    if (length === 1) b[8] = value; else b.writeUInt32BE(value, 8);
    return b;
}
function status(values) {
    const values2 = Object.assign({ mstt: 200, caps: 4, cash: 0, carp: 0, caas: 2, caar: 6 }, values);
    const fields = Object.keys(values2).filter(k => values2[k] !== null).map(k => field(k, values2[k], ['caps', 'cash', 'carp'].indexOf(k) >= 0 ? 1 : 4));
    const body = Buffer.concat(fields), head = Buffer.alloc(8); head.write('cmst'); head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
}
function rejection(promise, code) { return promise.then(() => { throw Error('expected rejection'); }, e => assert.strictEqual(e.message, code)); }

async function main() {
    for (const host of ['10.1.2.3', '172.16.1.2', '172.31.2.3', '192.168.1.2', '169.254.2.3', 'fe80::1%3', 'fd12::2', '::ffff:192.168.1.2'])
        assert(localHost(host, {}), host);
    for (const host of ['127.0.0.1', '0.0.0.0', '8.8.8.8', '172.32.1.2', '169.255.1.2', '::1', '::', 'ff02::1', 'fe80::1', 'fe80::1%0', 'fd12::2%4', '::ffff:127.0.0.1', 'phone.local', '192.168.1.2\r\nX: y'])
        assert(!localHost(host, {}), host);
    const interfaces = { wlan_bridge: [{ address: '2001:db8:1:2::1', cidr: '2001:db8:1:2::1/64', internal: false }] };
    assert(!localHost('2001:db8:1:2::5', interfaces)); assert(!localHost('2001:db8:1:3::5', interfaces));
    assert.strictEqual(parseStatus(status()).caps, 4);
    assert.throws(() => parseStatus(Buffer.from('cmst')), /music_bad_status/);
    const bad = status(); bad.writeUInt32BE(65535, 12); assert.throws(() => parseStatus(bad), /music_bad_status/);
    assert.throws(() => parseStatus(status({ mstt: 403 })), /music_bad_status/);
    assert.throws(() => parseStatus(status({ caps: 255 })), /music_bad_status/);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-music-control-')); fs.chmodSync(directory, 0o700);
    const file = path.join(directory, 'control.json');
    let epoch = '1-2-3', playback = 4, shuffle = 0, repeat = 0, masks = true, rejectNext = false, unconfirmed = false, held = null, oversized = false;
    const secret = '9876543210', observed = [], publicStates = [], resolutions = [];
    const descriptor = () => ({ epoch, host: '192.168.1.15', dacpId: '1234ABCD', activeRemote: secret });
    const write = extra => fs.writeFileSync(file, JSON.stringify(Object.assign(descriptor(), extra)), { mode: 0o600 });
    const server = http.createServer((req, res) => {
        observed.push(req.url); assert.strictEqual(req.headers['active-remote'], secret);
        const sendStatus = () => { res.writeHead(200); res.end(oversized ? Buffer.alloc(65537) : status({ caps: playback, cash: shuffle, carp: repeat, caas: masks ? 2 : null, caar: masks ? 6 : null })); };
        if (req.url === '/ctrl-int/1/playstatusupdate?revision-number=1') sendStatus();
        else if (req.url === '/ctrl-int/1/playpause') { playback = playback === 4 ? 3 : 4; res.writeHead(204); res.end(); }
        else if (req.url === '/ctrl-int/1/nextitem') {
            if (rejectNext) { res.writeHead(403); res.end(); }
            else if (held === 'hold') held = () => { res.writeHead(204); res.end(); };
            else { res.writeHead(204); res.end(); }
        } else if (req.url === '/ctrl-int/1/previtem') { res.writeHead(204); res.end(); }
        else if (/^\/ctrl-int\/1\/setproperty\?dacp\.shufflestate=[01]$/.test(req.url)) {
            if (!unconfirmed) shuffle = Number(req.url.slice(-1)); res.writeHead(204); res.end();
        } else if (/^\/ctrl-int\/1\/setproperty\?dacp\.repeatstate=[012]$/.test(req.url)) {
            repeat = Number(req.url.slice(-1)); res.writeHead(204); res.end();
        } else { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const spawn = (command, args, options) => {
        resolutions.push([command, args]); assert.strictEqual(options.env.DNSSD_UDS_PATH, '/run/mdnsd/mdnsd_uds');
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => { child.emit('close', null); };
        process.nextTick(() => { child.stdout.emit('data', Buffer.from(String(port) + '\n')); child.emit('close', 0); });
        return child;
    };
    const transport = { request(options, callback) {
        assert.strictEqual(options.hostname, '192.168.1.15'); assert.strictEqual(options.port, port);
        assert.strictEqual(options.agent, false); assert(options.path.indexOf('/ctrl-int/1/') === 0);
        return http.request(Object.assign({}, options, { hostname: '127.0.0.1' }), callback);
    } };
    const controls = new MusicControls({ directory: () => directory, resolveBinary: ['/loader', '--library-path', '/private/lib', '/private/bin/mgu-dacp-resolve'],
        spawn, http: transport, onState: state => publicStates.push(state) });
    try {
        assert.strictEqual((await controls.poll()).epoch, null);
        write(); assert(readSender(directory, {}));
        fs.chmodSync(file, 0o644); assert.strictEqual(readSender(directory, {}), null); fs.chmodSync(file, 0o600);
        write({ host: '8.8.8.8' }); assert.strictEqual(readSender(directory, {}), null); write();
        fs.renameSync(file, file + '.original'); fs.symlinkSync(file + '.original', file);
        assert.strictEqual(readSender(directory, {}), null); fs.unlinkSync(file); fs.renameSync(file + '.original', file);
        let state = await controls.poll();
        assert.strictEqual(state.epoch, epoch); assert.strictEqual(state.playbackState, 'playing');
        for (const action of Object.keys(state.controls)) assert.strictEqual(state.controls[action], true);
        assert.deepStrictEqual(resolutions[0][1], ['--library-path', '/private/lib', '/private/bin/mgu-dacp-resolve', '1234ABCD']);
        await rejection(controls.execute('next', null, 'old'), 'music_unavailable');
        await rejection(controls.execute('http://other', null, epoch), 'music_invalid_command');
        await rejection(controls.execute('repeat', '2', epoch), 'music_invalid_command');
        await rejection(controls.execute('next', 'extra', epoch), 'music_invalid_command');
        state = await controls.execute('playPause', null, epoch); assert.strictEqual(state.playbackState, 'paused');
        await controls.execute('next', null, epoch); await controls.execute('previous', null, epoch);
        state = await controls.execute('shuffle', 1, epoch); assert.strictEqual(state.shuffle, 1);
        for (const value of [2, 1, 0]) assert.strictEqual((await controls.execute('repeat', value, epoch)).repeat, value);
        unconfirmed = true;
        await rejection(controls.execute('shuffle', 0, epoch), 'music_unconfirmed');
        assert.strictEqual(controls.snapshot().shuffle, 1); assert.strictEqual(controls.snapshot().controls.shuffle, false);
        rejectNext = true; await rejection(controls.execute('next', null, epoch), 'music_command_failed');
        assert.strictEqual(controls.snapshot().controls.next, false); rejectNext = false;
        masks = false; state = await controls.poll(); assert.strictEqual(state.controls.repeat, false); assert.strictEqual(state.controls.playPause, true);
        epoch = '1-2-4'; write(); masks = true; await controls.poll();
        assert.strictEqual(controls.snapshot().controls.next, true);
        held = 'hold'; const command = controls.execute('next', null, epoch);
        await new Promise(resolve => { const check = () => typeof held === 'function' ? resolve() : setImmediate(check); check(); });
        const release = held; epoch = '1-2-5'; write(); release();
        await rejection(command, 'music_command_failed');
        assert.strictEqual(controls.snapshot().epoch, epoch); assert.strictEqual(controls.snapshot().controls.next, false);
        await controls.poll(); assert.strictEqual(controls.snapshot().controls.next, true);
        held = 'hold';
        await rejection(controls.execute('next', null, epoch), 'music_command_failed');
        assert.strictEqual(controls.snapshot().controls.next, false); held(); held = null;
        oversized = true; state = await controls.poll();
        assert.strictEqual(state.controls.playPause, false); oversized = false;
        await controls.poll(); assert.strictEqual(controls.snapshot().controls.playPause, true);
        const beforeBadPort = observed.length;
        const invalidPort = new MusicControls({ directory, resolveBinary: ['/resolver'], http: transport, spawn() {
            const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {};
            process.nextTick(() => { child.stdout.emit('data', Buffer.from('22\n')); child.emit('close', 0); });
            return child;
        } });
        assert.strictEqual((await invalidPort.poll()).controls.playPause, false);
        assert.strictEqual(observed.length, beforeBadPort); invalidPort.close();
        assert(!JSON.stringify(publicStates).includes(secret)); assert(!JSON.stringify(publicStates).includes('activeRemote'));
        assert(!JSON.stringify(publicStates).includes('192.168.1.15')); assert(!JSON.stringify(publicStates).includes('1234ABCD'));
        fs.unlinkSync(file); await controls.poll(); assert.strictEqual(controls.snapshot().epoch, null);
        await rejection(controls.execute('playPause', null, epoch), 'music_unavailable');
        assert(observed.includes('/ctrl-int/1/previtem'));
    } finally {
        controls.close(); await new Promise(resolve => server.close(resolve));
        for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name)); fs.rmdirSync(directory);
    }
    console.log('Music controls: paired-peer validation, private credentials, real HTTP routes, capability/state readback and stale-session cancellation passed');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
