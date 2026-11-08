'use strict';
// End-to-end check for the PllanaCast for BMW app (CI, Android emulator): runs the
// real CastReceiver (handshake, code check, framing) on the host and, instead
// of the native decoder, a sink that records the H.264 stream and counts
// frames. The emulator reaches the host as 10.0.2.2 (seen here as loopback).
//   node cast_e2e_receiver.js <out-dir> <code> <seconds>
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { CastReceiver } = require('../../apps/pllana_airplay/cast_receiver');

const out = path.resolve(process.argv[2] || 'cast-e2e'), code = process.argv[3] || '246810', seconds = Number(process.argv[4] || 120);
fs.mkdirSync(out, { recursive: true });

if (process.argv[5] === '--sink') {
    // Child: parse frames from stdin like mgu-cast-receiver does.
    const h264 = fs.openSync(path.join(out, 'stream.h264'), 'w');
    const stats = { configs: 0, frames: 0, keyFrames: 0, audioBlocks: 0, audioBytes: 0, keepalives: 0, bytes: 0, firstFrameAt: null, invalid: 0 };
    let pending = Buffer.alloc(0), config = null;
    const save = () => fs.writeFileSync(path.join(out, 'stats.json'), JSON.stringify(stats));
    process.stdin.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]); stats.bytes += chunk.length;
        while (pending.length >= 16) {
            const type = pending[0], flags = pending[1], length = pending.readUInt32BE(4);
            if (pending.length < 16 + length) break;
            const payload = pending.slice(16, 16 + length); pending = pending.slice(16 + length);
            if (type === 1) { stats.configs++; config = payload; }
            else if (type === 2) {
                if (!stats.frames) stats.firstFrameAt = new Date().toISOString();
                stats.frames++; if (flags & 1) stats.keyFrames++;
                if ((flags & 1) && config) fs.writeSync(h264, config);
                fs.writeSync(h264, payload);
            } else if (type === 4) { stats.audioBlocks++; stats.audioBytes += length; }
            else if (type === 5) stats.keepalives++;
            else stats.invalid++;
        }
        save();
    });
    process.stdin.on('end', () => { save(); fs.closeSync(h264); process.exit(0); });
    setInterval(save, 1000);
    return;
}

const log = text => { console.log(new Date().toISOString() + ' ' + text); fs.appendFileSync(path.join(out, 'receiver.log'), text + '\n'); };
const receiver = new CastReceiver({
    runtime: '/nonexistent', dataDir: out, port: 7104, host: '0.0.0.0', allowLoopback: true, skipRuntimeCheck: true, code: () => code,
    spawn: (binary, args, options) => {
        log('session: ' + args.slice(-1)[0]);
        return cp.spawn(process.execPath, [__filename, out, code, String(seconds), '--sink'], { stdio: ['pipe', 'pipe', 'inherit'], detached: true });
    },
});
receiver.on('diagnostic', code => log('diagnostic ' + code));
receiver.on('state', state => { if (state) log('connected: ' + state.device + ' audio=' + state.audio); });
receiver.start().then(() => log('listening on 7104, code ' + code));
setTimeout(() => { log('time is up'); receiver.stop().then(() => process.exit(0)); }, seconds * 1000);
process.on('SIGTERM', () => receiver.stop().then(() => process.exit(0)));
