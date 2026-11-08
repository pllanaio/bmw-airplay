'use strict';
// MediaPlayer: launch arguments/environment and status parsing with a fake
// child; with MGU_PLAYER_TEST_RUNTIME (CI: the built private runtime) also
// the real native player: HTTP video to shared-memory frames, pause, seek,
// audio-only media, missing files and clean exit.
const assert = require('assert'), EventEmitter = require('events'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process');
const { MediaPlayer, validUri } = require('../apps/pllana_airplay/media_player');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function unit() {
    assert(validUri('http://192.168.43.2:8080/a.mp4') && validUri('https://cdn.example/x.m3u8'));
    assert(!validUri('file:///etc/passwd') && !validUri('http://a b') && !validUri('rtsp://x/y') && !validUri('http://x/\n'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-unit-'));
    fs.chmodSync(dataDir, 0o700);
    const spawned = [];
    const spawn = (binary, args, options) => {
        const child = new EventEmitter(); child.pid = 4242; child.lines = [];
        child.stdin = { write: text => child.lines.push(text), on: () => {} }; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => {}; spawned.push({ binary, args, options, child }); return child;
    };
    const player = new MediaPlayer({ runtime: '/rt', dataDir, audioSink: 'alsasink device=x', spawn, skipRuntimeCheck: true });
    assert(player.setViewport(1600, 520));
    assert(!player.load('file:///etc/passwd'), 'only http(s) URLs');
    assert.strictEqual(spawned.length, 0);
    assert(player.load('http://192.168.43.2:8080/v.mp4', 12.5));
    const run = spawned[0];
    assert.strictEqual(run.binary, '/rt/bin/airplay-launch');
    assert.deepStrictEqual(run.args.slice(0, 4), ['/rt/lib/ld-linux-x86-64.so.2', '--library-path', '/rt/lib', '/rt/bin/mgu-media-player']);
    assert(/^mguvideosink location=\/dev\/shm\/mgu-video-android-\d+-\d+-1$/.test(run.args[4]), run.args[4]);
    assert.strictEqual(run.options.env.MGU_HLS_AUDIO_SINK, 'alsasink device=x');
    assert.strictEqual(run.options.env.GST_PLUGIN_SYSTEM_PATH_1_0, '');
    assert.strictEqual(run.options.detached, true);
    const viewport = fs.readFileSync(run.options.env.MGU_HLS_VIEWPORT_FILE);
    assert.strictEqual(viewport.readUInt32LE(0), 1600); assert.strictEqual(viewport.readUInt32LE(4), 520);
    assert.deepStrictEqual(run.child.lines, ['uri http://192.168.43.2:8080/v.mp4\n', 'start 12.500\n']);
    assert(JSON.stringify(run.args).indexOf('192.168') < 0, 'the URL never appears in the process arguments');
    const states = []; player.on('state', s => states.push(s.state));
    run.child.stdout.emit('data', 'MGU_PLAYER ready\nMGU_PLAYER state buffering\nMGU_PLAYER media video\nMGU_PLAYER state play');
    run.child.stdout.emit('data', 'ing\nMGU_PLAYER position 1500 60000\nMGU_PLAYER error bogus-code!\n');
    assert.deepStrictEqual(states, ['buffering', 'buffering', 'playing']);
    assert.strictEqual(player.state.media, 'video'); assert.strictEqual(player.state.position, 1.5); assert.strictEqual(player.state.duration, 60);
    assert.strictEqual(player.state.error, null, 'malformed lines are ignored');
    player.pause(); player.seek(30); player.volume(50); player.mute(true); player.play(); player.stop();
    assert.deepStrictEqual(run.child.lines.slice(2), ['pause\n', 'seek 30.000\n', 'volume 50\n', 'mute 1\n', 'play\n', 'stop\n']);
    assert(!player.volume(101) && !player.seek(-1));
    // An unexpected exit is reported once; the next load starts a new player.
    player.update({ state: 'playing' });
    run.child.emit('close', 1, null);
    assert.strictEqual(player.state.error, 'player_failed'); assert.strictEqual(player.child, null);
    assert(!fs.existsSync(run.options.env.MGU_HLS_VIEWPORT_FILE), 'private viewport file removed');
    player.load('http://192.168.43.2:8080/v.mp4');
    assert.strictEqual(spawned.length, 2); assert(/-2$/.test(spawned[1].args[4]), 'fresh frame file per player process');
    const closing = player.close();
    assert.strictEqual(spawned[1].child.lines[spawned[1].child.lines.length - 1], 'quit\n');
    spawned[1].child.emit('close', 0, null); await closing;
    assert.strictEqual(player.state.error, null, 'a requested close is no failure');
    const audio = new MediaPlayer({ runtime: '/rt', dataDir, spawn, skipRuntimeCheck: true });
    audio.video = false; audio.load('http://192.168.43.2/a.mp3');
    assert.strictEqual(spawned[2].args[4], 'none', 'the audio profile runs without a video sink');
    assert.strictEqual(spawned[2].options.env.MGU_HLS_VIEWPORT_FILE, undefined);
    fs.rmSync ? fs.rmSync(dataDir, { recursive: true, force: true }) : null;
}

function header(file) {
    try { const b = fs.readFileSync(file).slice(0, 64); return { magic: b.readUInt32LE(0), width: b.readUInt32LE(8), height: b.readUInt32LE(12), sequence: b.readUInt32LE(16) }; }
    catch (e) { return null; }
}
async function native(runtime) {
    const media = fs.mkdtempSync(path.join(os.tmpdir(), 'player-media-'));
    const ff = (args) => cp.execFileSync('ffmpeg', ['-loglevel', 'error', '-y'].concat(args));
    ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '8', '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(media, 'clip.mp4')]);
    ff(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', path.join(media, 'song.mp3')]);
    // Phone media servers answer byte ranges; MP4 needs them for its index.
    const server = http.createServer((req, res) => {
        const file = path.join(media, path.basename(req.url));
        if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
        const size = fs.statSync(file).size, range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''), type = /mp3$/.test(file) ? 'audio/mpeg' : 'video/mp4';
        if (range) {
            const start = Number(range[1]), end = range[2] ? Number(range[2]) : size - 1;
            res.writeHead(206, { 'Content-Type': type, 'Content-Range': 'bytes ' + start + '-' + end + '/' + size, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
            fs.createReadStream(file, { start, end }).pipe(res);
        } else { res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' }); fs.createReadStream(file).pipe(res); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port + '/';
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-native-'));
    fs.chmodSync(dataDir, 0o700);
    const player = new MediaPlayer({ runtime, dataDir, audioSink: 'fakesink sync=true' });
    const seen = [];
    player.on('state', s => { if (seen[seen.length - 1] !== s.state) seen.push(s.state); });
    const until = async (test, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return; await wait(50); } throw Error('timeout: ' + what + ' states ' + seen.join(',')); };
    try {
        assert(player.available(), 'runtime contains the player');
        player.setViewport(1280, 480);
        assert(player.load(base + 'clip.mp4', 2)); player.play();
        await until(() => player.state.state === 'playing' && player.state.frame, 10000, 'video frames');
        const file = player.state.file, frame = header(file);
        assert.strictEqual(frame.magic, 0x4656474d); assert.strictEqual(frame.width, 1280); assert.strictEqual(frame.height, 480, 'scaled to the UI viewport');
        assert.strictEqual(player.state.media, 'video');
        await until(() => player.state.position >= 2.2, 4000, 'start position applied');
        assert(Math.abs(player.state.duration - 8) < 0.3, 'duration ' + player.state.duration);
        player.pause(); await until(() => player.state.state === 'paused', 3000, 'pause');
        const paused = player.state.position; await wait(600);
        assert(Math.abs(player.state.position - paused) < 0.3, 'paused position holds');
        player.setViewport(1600, 520);
        player.seek(6); player.play();
        await until(() => player.state.position >= 6 && player.state.state === 'playing', 5000, 'seek');
        await until(() => header(file).width === 1600, 3000, 'viewport follows a UI resize');
        await until(() => player.state.state === 'ended', 5000, 'end of media');
        assert(player.load(base + 'song.mp3')); player.play();
        await until(() => player.state.media === 'audio' && player.state.state === 'playing', 8000, 'audio media');
        player.stop(); await until(() => player.state.state === 'stopped', 2000, 'stop');
        assert(player.load(base + 'missing.mp4')); player.play();
        await until(() => player.state.state === 'stopped' && player.state.error, 8000, 'missing media');
        assert.strictEqual(player.state.error, 'player_not_found');
        // Full chain: an Android controller drives the renderer over UPnP.
        const { DlnaRenderer } = require('../apps/pllana_airplay/dlna_renderer');
        const renderer = new DlnaRenderer({ player, dataDir, port: 0, ssdpPort: 0, allowLoopback: true, host: '127.0.0.1', interfaces: () => ({}) });
        await renderer.start();
        const soap = (action, args) => new Promise((resolve, reject) => {
            const type = 'urn:schemas-upnp-org:service:AVTransport:1';
            const body = Buffer.from('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:' + action + ' xmlns:u="' + type + '"><InstanceID>0</InstanceID>' +
                Object.keys(args).map(k => '<' + k + '>' + args[k] + '</' + k + '>').join('') + '</u:' + action + '></s:Body></s:Envelope>');
            const req = http.request({ host: '127.0.0.1', port: renderer.port, method: 'POST', path: '/dlna/AVTransport/control',
                headers: { 'Content-Type': 'text/xml', 'Content-Length': body.length, SOAPACTION: '"' + type + '#' + action + '"' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
            req.on('error', reject); req.end(body);
        });
        assert.strictEqual(await soap('SetAVTransportURI', { CurrentURI: base + 'clip.mp4', CurrentURIMetaData: '' }), 200);
        assert.strictEqual(await soap('Play', { Speed: 1 }), 200);
        await until(() => renderer.presentation() && renderer.presentation().transport === 'PLAYING' && renderer.presentation().frame, 10000, 'UPnP playback');
        assert.strictEqual(await soap('Seek', { Unit: 'REL_TIME', Target: '0:00:05' }), 200);
        await until(() => player.state.position >= 5, 5000, 'UPnP seek');
        assert.strictEqual(await soap('Stop', {}), 200);
        await until(() => renderer.presentation() === null && player.state.state === 'stopped', 3000, 'UPnP stop');
        await renderer.stop();
        await player.close();
        assert(!fs.existsSync(file), 'shared frame file removed on close');
        assert.deepStrictEqual(fs.readdirSync(dataDir).filter(n => /viewport/.test(n)), [], 'no viewport files left');
        console.log('Native player: ' + seen.join(' -> '));
    } finally { await player.close(); server.close(); }
}

(async () => {
    await unit();
    if (process.env.MGU_PLAYER_TEST_RUNTIME) await native(process.env.MGU_PLAYER_TEST_RUNTIME);
    else console.log('(native player check skipped: set MGU_PLAYER_TEST_RUNTIME)');
    console.log('Media player launch, status parsing, failures' + (process.env.MGU_PLAYER_TEST_RUNTIME ? ' and real native playback' : '') + ' passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
