'use strict';
// Owner-operated, bounded test. Uses an in-memory quiet WAV and releases its focus token.
const fs = require('fs'), http = require('http');
const someip = require('/var/opt/public/oap/oap_12443/source/node_modules/someip');
const wait = ms => new Promise(r => setTimeout(r, ms));
const tick = fn => new Promise((resolve, reject) => setImmediate(() => {
    try { Promise.resolve(fn()).then(resolve, reject); } catch (e) { reject(e); }
}));
const names = {
    focus: 'de.bmw.infotainment.entertainment.dynamicmediaplayer.DynamicMediaPlayer',
    player: 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer',
};
function configs(extra) {
    const text = fs.readFileSync('/usr/lib/oap-mainapp/src/AppManagement/AppManagement.js', 'utf8');
    const id = /"someip-interfaces-generator\/IFConfigGenerator(?:\.js)?":(\d+)/.exec(text);
    const tail = /,\{\},\[\d+\]\)\s*;?\s*$/;
    if (!id || !tail.test(text)) throw Error('generator_not_found');
    const load = new Function('require', 'return ' + text.replace(tail, ',{},[])'))(require);
    const generator = load(id[1]);
    const db = JSON.parse(fs.readFileSync('/etc/oap/someip/someip-interfaces.json', 'utf8'));
    return generator.generate(db, { proxies: Object.assign({
        [names.focus]: { instances: 'DynamicMediaPlayerMedia', attributes: { currentAudioFocus: 'rs', playerState: 'rs' }, methods: ['getAudioFocus', 'heartBeat', 'releaseAudioFocus'] },
        [names.player]: { instances: 'DynamicMedia', attributes: { playerState: 'rs' }, methods: ['playFile'] },
    }, extra || {}) });
}
function tone() {
    const n = 48000, b = Buffer.alloc(44 + n * 4);
    b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
    b.writeUInt32LE(48000, 24); b.writeUInt32LE(192000, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(n * 4, 40);
    for (let i = 0; i < n; i++) {
        const fade = Math.min(1, i / 960, (n - i - 1) / 960);
        const value = Math.round(32767 * 0.01 * fade * Math.sin(2 * Math.PI * 440 * i / 48000));
        b.writeInt16LE(value, 44 + i * 4); b.writeInt16LE(value, 46 + i * 4);
    }
    return b;
}
async function main() {
    const cfg = configs(), proxies = [], data = tone();
    let focus, player, token = null, heartbeat, requests = 0;
    const server = http.createServer((req, res) => {
        requests++; console.log(JSON.stringify({ audio_http_request: true, range: req.headers.range || null }));
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': data.length }); res.end(data);
    });
    const deadline = setTimeout(() => process.exit(2), 18000);
    try {
        focus = await tick(() => someip.buildProxy(cfg[names.focus], 'DynamicMediaPlayerMedia').then(p => p.init().then(() => p))); proxies.push(focus);
        player = await tick(() => someip.buildProxy(cfg[names.player], 'DynamicMedia').then(p => p.init().then(() => p))); proxies.push(player);
        await wait(1400);
        console.log(JSON.stringify({ focus_available: focus.isAvailable(), player_available: player.isAvailable() }));
        if (!focus.isAvailable() || !player.isAvailable()) return;
        const grant = await tick(() => focus.callMethod('getAudioFocus', { clientId: 'pllana_airplay_probe', clientName: 'AirPlay', timeOutHeartBeatTimer: 5000 }, 3000));
        token = grant.token;
        console.log(JSON.stringify({ focus_error: grant.err, token_received: !!token }));
        if (!token || (grant.err !== 'OK' && grant.err !== 0)) return;
        heartbeat = setInterval(() => tick(() => focus.callMethod('heartBeat', { token }, 1000)).catch(() => {}), 1000);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        await tick(() => player.subscribe({ name: 'playerState', onReceive: state => console.log(JSON.stringify({ player_state: state })) }));
        const result = await tick(() => player.callMethod('playFile', { path: 'http://127.0.0.1:' + server.address().port + '/airplay-probe.wav', languageCode: 0 }, 3000));
        console.log(JSON.stringify({ play_result: result }));
        await wait(2500);
        console.log(JSON.stringify({ http_requests: requests, final_state: await player.getValue('playerState', 2000) }));
    } finally {
        clearInterval(heartbeat);
        if (token && focus) {
            const result = await tick(() => focus.callMethod('releaseAudioFocus', { token }, 2000)).catch(() => ({ failed: true }));
            console.log(JSON.stringify({ focus_release: result }));
        }
        try { server.close(); } catch (e) {}
        for (const p of proxies) if (p.shutdown) await tick(() => p.shutdown()).catch(() => {});
        clearTimeout(deadline);
    }
}
module.exports = { configs, tone, tick, wait, names, someip };
if (require.main === module) main().then(() => process.exit(0)).catch(e => { console.error(String(e)); process.exit(1); });
