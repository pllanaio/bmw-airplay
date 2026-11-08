'use strict';
// pllana Cast receiver: code handshake, limits and session handling with a
// fake child; with MGU_PLAYER_TEST_RUNTIME also a simulated phone streaming
// real H.264 and PCM through the native mgu-cast-receiver into shared-memory
// frames, exactly as the Android app does.
const assert = require('assert'), net = require('net'), EventEmitter = require('events'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { CastReceiver, proof, PROTOCOL } = require('../apps/pllana_airplay/cast_receiver');
const wait = ms => new Promise(r => setTimeout(r, ms));

// --- simulated phone (mirrors android/.../CastConnection.java) -------------
function frame(type, flags, ptsUs, payload) {
    const header = Buffer.alloc(16);
    header[0] = type; header[1] = flags; header.writeUInt32BE(payload.length, 4);
    header.writeUInt32BE(Math.floor(ptsUs / 4294967296), 8); header.writeUInt32BE(ptsUs % 4294967296, 12);
    return Buffer.concat([header, payload]);
}
function connect(port, code, options) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        let pending = '', hello = null;
        socket.on('error', reject);
        socket.on('data', chunk => {
            pending += chunk.toString('utf8');
            let at;
            while ((at = pending.indexOf('\n')) >= 0) {
                const message = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1);
                if (!hello && message.ok === false) { resolve({ socket, reply: message, hello: null }); return; }
                if (!hello) {
                    hello = message;
                    assert.strictEqual(message.proto, PROTOCOL); assert(/^[0-9a-f]{32}$/.test(message.nonce));
                    socket.write(JSON.stringify({ proto: PROTOCOL, device: 'Pixel 9', auth: proof(code, message.nonce), audio: !!(options && options.audio), width: 640, height: 360 }) + '\n');
                } else { socket.removeAllListeners('data'); resolve({ socket, reply: message, hello }); return; }
            }
        });
        socket.on('close', () => resolve({ socket, reply: null, hello }));
    });
}
function annexB(file) {
    const data = fs.readFileSync(file), starts = [];
    for (let i = 0; i + 3 < data.length; i++) if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))) { starts.push(i); i += 2; }
    const nals = starts.map((s, n) => data.slice(s, n + 1 < starts.length ? starts[n + 1] : data.length));
    const type = nal => nal[nal[2] === 1 ? 3 : 4] & 31;
    const units = []; let current = null;
    for (const nal of nals) {
        if (type(nal) === 9 || !current) { current = { parts: [], key: false }; units.push(current); }
        current.parts.push(nal); if (type(nal) === 5) current.key = true;
    }
    const config = Buffer.concat(nals.filter(n => type(n) === 7 || type(n) === 8).slice(0, 2));
    return { config, units: units.map(u => ({ key: u.key, data: Buffer.concat(u.parts) })) };
}

async function unit() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-unit-'));
    const spawned = [];
    const spawn = (binary, args, options) => {
        const child = new EventEmitter(); child.pid = 777; child.received = [];
        child.stdin = new EventEmitter(); child.stdin.write = chunk => { child.received.push(Buffer.from(chunk)); return true; }; child.stdin.end = () => setImmediate(() => child.emit('close', 0));
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
        spawned.push({ binary, args, options, child }); return child;
    };
    let code = '482913';
    const cast = new CastReceiver({ runtime: '/rt', dataDir, port: 0, host: '127.0.0.1', allowLoopback: true, spawn, skipRuntimeCheck: true, code: () => code, audioSink: 'alsasink device=x' });
    const states = []; cast.on('state', s => states.push(s));
    await cast.start();
    let r = await connect(cast.port, '000000');
    assert.deepStrictEqual(r.reply, { ok: false, error: 'code_wrong' }); assert.strictEqual(spawned.length, 0, 'no media without the right code');
    r = await connect(cast.port, '482913', { audio: true });
    assert.deepStrictEqual(r.reply, { ok: true });
    assert.strictEqual(spawned.length, 1);
    assert.deepStrictEqual(spawned[0].args.slice(3), ['/rt/bin/mgu-cast-receiver', spawned[0].args[4], 'audio']);
    assert(/^mguvideosink location=\/dev\/shm\/mgu-video-cast-\d+-\d+-1$/.test(spawned[0].args[4]));
    assert.strictEqual(spawned[0].options.env.MGU_HLS_AUDIO_SINK, 'alsasink device=x');
    assert.strictEqual(cast.presentation().device, 'Pixel 9'); assert.strictEqual(cast.presentation().audio, true);
    const busy = await connect(cast.port, '482913');
    assert.deepStrictEqual(busy.reply, { ok: false, error: 'busy' }, 'one phone at a time');
    r.socket.write(frame(5, 0, 1, Buffer.alloc(0)));
    await wait(50);
    assert.strictEqual(Buffer.concat(spawned[0].child.received).length, 16, 'media bytes reach the native receiver unchanged');
    // The driver ends it from the car: the phone gets a stop message.
    const stopped = new Promise(resolve => { let text = ''; r.socket.on('data', c => { text += c; }); r.socket.on('close', () => resolve(text)); });
    await cast.stopSession();
    assert(/"type":"stop"/.test(await stopped)); assert.strictEqual(cast.presentation(), null);
    // Too many wrong codes from one address are refused for a minute.
    for (let i = 0; i < 4; i++) assert.strictEqual((await connect(cast.port, '111111')).reply.error, 'code_wrong');
    assert.strictEqual((await connect(cast.port, '482913')).reply.error, 'too_many_attempts');
    cast.failures.clear();
    code = '';
    assert.strictEqual((await connect(cast.port, '482913')).reply.error, 'not_ready', 'no code shown, no session');
    code = '482913';
    // Stopping reception ends a running session.
    const idle = new CastReceiver({ runtime: '/rt', dataDir, port: 0, host: '127.0.0.1', allowLoopback: true, spawn, skipRuntimeCheck: true, code: () => code });
    await idle.start();
    const quiet = await connect(idle.port, code);
    assert.strictEqual(quiet.reply.ok, true);
    await cast.stop(); await idle.stop();
    assert.strictEqual(idle.presentation(), null, 'stopping reception ends the session');
    quiet.socket.destroy();
    fs.rmSync ? fs.rmSync(dataDir, { recursive: true, force: true }) : null;
}

async function native(runtime) {
    const media = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-media-'));
    cp.execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-t', '4', '-c:v', 'libx264', '-profile:v', 'baseline',
        '-pix_fmt', 'yuv420p', '-x264-params', 'aud=1:keyint=30:bframes=0', '-f', 'h264', path.join(media, 'screen.h264')]);
    const video = annexB(path.join(media, 'screen.h264'));
    assert(video.units.length >= 100 && video.units[0].key && video.config.length > 8);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-native-'));
    const cast = new CastReceiver({ runtime, dataDir, port: 0, host: '127.0.0.1', allowLoopback: true, code: () => '135790', audioSink: 'fakesink sync=true' });
    await cast.start();
    try {
        const { socket, reply } = await connect(cast.port, '135790', { audio: true });
        assert.deepStrictEqual(reply, { ok: true });
        const base = Date.now() * 1000;
        socket.write(frame(1, 0, base, video.config));
        let sent = 0, maxSequence = 0;
        for (let i = 0; i < video.units.length; i++) {
            const pts = base + Math.round(i * 1e6 / 30);
            socket.write(frame(2, video.units[i].key ? 1 : 0, pts, video.units[i].data));
            // 33 ms of 48 kHz stereo S16LE silence-free tone.
            const pcm = Buffer.alloc(1600 * 4);
            for (let s = 0; s < 1600; s++) { const v = Math.round(8000 * Math.sin((i * 1600 + s) * 2 * Math.PI * 440 / 48000)); pcm.writeInt16LE(v, s * 4); pcm.writeInt16LE(v, s * 4 + 2); }
            socket.write(frame(4, 0, pts, pcm));
            sent++;
            await wait(33);
            const f = cast.presentation() && cast.presentation().frame;
            if (f) maxSequence = Math.max(maxSequence, f.sequence);
        }
        const shown = cast.presentation();
        assert(shown && shown.frame, 'frames reach the display path');
        assert.strictEqual(shown.frame.width, 640); assert.strictEqual(shown.frame.height, 360);
        assert(maxSequence > sent * 0.6, 'smooth decoding: ' + maxSequence + ' of ' + sent + ' frames shown');
        const file = shown.file;
        socket.end();
        const end = Date.now() + 3000;
        while (cast.presentation() && Date.now() < end) await wait(50);
        assert.strictEqual(cast.presentation(), null, 'phone disconnect ends the session');
        await wait(300);
        assert(!fs.existsSync(file), 'shared frame file removed');
        console.log('Native cast: ' + maxSequence + ' of ' + sent + ' frames displayed at 640x360');
        // Garbage after the handshake ends the session safely.
        const bad = await connect(cast.port, '135790');
        bad.socket.write(Buffer.alloc(64, 0xff));
        const until = Date.now() + 3000;
        while (cast.presentation() && Date.now() < until) await wait(50);
        assert.strictEqual(cast.presentation(), null, 'malformed frames end the session');
        bad.socket.destroy();
    } finally { await cast.stop(); }
}

(async () => {
    await unit();
    if (process.env.MGU_PLAYER_TEST_RUNTIME) await native(process.env.MGU_PLAYER_TEST_RUNTIME);
    else console.log('(native cast check skipped: set MGU_PLAYER_TEST_RUNTIME)');
    console.log('pllana Cast receiver: code handshake, limits, sessions' + (process.env.MGU_PLAYER_TEST_RUNTIME ? ' and real H.264/PCM decoding' : '') + ' passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
