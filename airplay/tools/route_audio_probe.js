'use strict';
const http = require('http');
const { configs, tone, tick, wait, names, someip } = require('./audio_probe');
const commandName = 'org.genivi.am.commandinterface.CommandControl';
const observerName = 'org.genivi.am.routinginterface.RoutingControlObserver';
const diagName = 'de.bmw.infotainment.systemfunctions.diagnostics.job.Ent.DiagEntAudio';
const avbName = 'com.intel.ias.media_transport.avb_control.IasAvbControl';
function avConnections(value) {
    const b = value.STAT_AV_CONNECTION;
    if (!Buffer.isBuffer(b)) throw Error('invalid_av_connections');
    let pos = 0;
    const u16 = () => { if (pos + 2 > b.length) throw Error('truncated_av_connections'); const v = b.readUInt16LE(pos); pos += 2; return v; };
    const name = () => { const end = b.indexOf(0, pos); if (end < pos) throw Error('invalid_av_name'); const v = b.toString('utf8', pos, end); pos = end + 1; return v; };
    const records = [];
    for (let i = 0; i < value.STAT_NUMBER_AV_CONNECTIONS_WERT; i++) {
        const r = { id: u16(), source: u16(), sourceName: name(), sink: u16(), sinkName: name() };
        if (pos >= b.length) throw Error('truncated_av_state');
        r.state = b[pos++]; records.push(r);
    }
    if (pos !== b.length) throw Error('unexpected_av_bytes');
    return records;
}
function meterBuffers() {
    const fs = require('fs'), crypto = require('crypto');
    return [
        'smartx_MediaSink_AudioOut_Front_CF_48_COMBINED_STEREO_MULTICHANNEL_p_ringbuffer',
        'avb_MGU_GW_2_SINK_CF_48_STEREO_p_ringbuffer',
        'avb_MGU_GW_2_SINK_CF_48_MULTICHANNEL_p_ringbuffer',
    ].map(name => {
        const path = '/dev/shm/' + name, s = fs.statSync(path);
        if (!s.isFile() || s.size > 262144) throw Error('unexpected_pcm_buffer');
        const b = fs.readFileSync(path);
        let signalBlocks = 0, bestRms = 0, bestPeak = 0, smallWords = 0;
        const phasePeaks6 = [0, 0, 0, 0, 0, 0];
        for (let at = 0; at + 512 <= b.length; at += 512) {
            let energy = 0, peak = 0, nonzero = 0, bounded = true;
            for (let p = at; p < at + 512; p += 2) {
                const v = Math.abs(b.readInt16LE(p));
                if (v > 2000) bounded = false;
                if (v > 8 && v <= 2000) smallWords++;
                if (v > 8) nonzero++;
                energy += v * v; peak = Math.max(peak, v);
            }
            if (bounded && nonzero > 128) {
                for (let p = at; p < at + 512; p += 2) {
                    const phase = (p / 2) % 6;
                    phasePeaks6[phase] = Math.max(phasePeaks6[phase], Math.abs(b.readInt16LE(p)));
                }
                signalBlocks++;
                const rms = Math.sqrt(energy / 256);
                if (rms > bestRms) { bestRms = rms; bestPeak = peak; }
            }
        }
        return { name, bytes: b.length, hash: crypto.createHash('sha256').update(b).digest('hex').slice(0, 12), signalBlocks, bestRms: Math.round(bestRms), bestPeak, smallWords, phasePeaks6 };
    });
}
(async () => {
    const cfg = configs({
        [commandName]: { instances: '1', methods: ['getListMainSources', 'getListMainSinks', 'getListMainConnections', 'getVolume', 'setVolume', 'connect', 'disconnect'] },
        [names.player]: { instances: 'OapGenericMedia', attributes: { playerState: 'rs', autoplay: 'r' }, methods: ['playFile', 'sendButtonEvent'] },
        [observerName]: { instances: '1', methods: ['hookSinkNotificationDataChange'] },
        [diagName]: { instances: 'Inst1', methods: ['StatusAvConnections', 'StatusMute'] },
        [avbName]: { instances: 'IasAvbControlFront', methods: ['getAvbStreamInfo'] },
    });
    let command, player, observer, diag, avb, owned = null, server, requests = 0, playerUsed = false, decoderAnnounced = false, testVolume = null;
    const proxies = [], sockets = new Set();
    const deadline = setTimeout(() => process.exit(2), 18000);
    // getVolume is inconsistent on this firmware: it returns 0 even while
    // getListMainSinks reports the actual changed volume. Use the latter.
    const readMainVolume = async () => {
        const result = await tick(() => command.callMethod('getListMainSinks', {}, 1000));
        const main = result.listMainSinks.find(s => s.sinkID === 1);
        if (result.amError !== 'E_OK' || !main || !Number.isInteger(main.volume)) throw Error('main_volume_unavailable');
        return { mainVolume: main.volume, amError: result.amError };
    };
    const waitMainVolume = async expected => {
        let value;
        for (let i = 0; i < 12; i++) {
            await wait(150);
            value = await readMainVolume();
            if (value.mainVolume === expected) return value;
        }
        return value;
    };
    try {
        command = await tick(() => someip.buildProxy(cfg[commandName], '1').then(p => p.init().then(() => p))); proxies.push(command);
        player = await tick(() => someip.buildProxy(cfg[names.player], 'OapGenericMedia').then(p => p.init().then(() => p))); proxies.push(player);
        if (process.env.MGU_PCM_PROBE_DECODER_READY === '1') {
            observer = await tick(() => someip.buildProxy(cfg[observerName], '1').then(p => p.init().then(() => p))); proxies.push(observer);
        }
        if (observer || process.env.MGU_PCM_PROBE_METER === '1') {
            diag = await tick(() => someip.buildProxy(cfg[diagName], 'Inst1').then(p => p.init().then(() => p))); proxies.push(diag);
            avb = await tick(() => someip.buildProxy(cfg[avbName], 'IasAvbControlFront').then(p => p.init().then(() => p))); proxies.push(avb);
        }
        await wait(1200);
        console.log(JSON.stringify({ command_available: command.isAvailable(), player_available: player.isAvailable() }));
        if (!command.isAvailable() || !player.isAvailable()) return;
        const sources = await tick(() => command.callMethod('getListMainSources', {}, 2000));
        const sinks = await tick(() => command.callMethod('getListMainSinks', {}, 2000));
        const before = await tick(() => command.callMethod('getListMainConnections', {}, 2000));
        // Source 386 is the decoded MediaSink_AudioOut_Front PCM source in
        // DOMAIN_MGU.bin and SmartXMGU.bin, rather than the encoded OAP source.
        const ram = process.env.MGU_PCM_PROBE_RAM === '1';
        const physical = process.env.MGU_PCM_PROBE_PHYSICAL === '1' || ram;
        const source = physical ? { sourceID: 386, name: 'MediaSink_AudioOut_Front' } : sources.listMainSources.find(s => s.name === 'OAPGenericMedia');
        // logInfo.bin explicitly identifies MainSink as a controls-only object.
        // DOMAIN_RAM.bin links its SP_INPUT_A=129 to the real InputA_Main sink.
        const sink = ram ? { sinkID: 129, name: 'InputA_Main' } : sinks.listMainSinks.find(s => s.name === (physical || process.env.MGU_PCM_PROBE_SPEAKERS === '1' ? 'MainSink' : 'MediaSink_Front'));
        if (!source || !sink) throw Error('media_route_missing');
        if (observer && (source.sourceID !== 1046 || sink.sinkID !== 1024 || !observer.isAvailable() || !diag.isAvailable())) throw Error('decoder_test_unavailable');
        console.log(JSON.stringify({ route_target: { source, sink }, previous_connections: before.listConnections }));
        if (before.listConnections.some(c => c.sourceID === source.sourceID && c.sinkID === sink.sinkID)) throw Error('media_route_already_in_use');
        const result = await tick(() => command.callMethod('connect', { sourceID: source.sourceID, sinkID: sink.sinkID }, 3000));
        console.log(JSON.stringify({ route_connect: result }));
        if (result.amError !== 'E_OK' && result.amError !== 0) return;
        if (before.listConnections.some(c => c.mainConnectionID === result.mainConnectionID)) throw Error('connection_not_new');
        owned = { id: result.mainConnectionID, source: source.sourceID, sink: sink.sinkID };
        const routing = await tick(() => command.callMethod('getListMainConnections', {}, 2000));
        console.log(JSON.stringify({ owned_route: routing.listConnections.find(c => c.mainConnectionID === owned.id) }));
        if (process.env.MGU_PCM_PROBE_ROOT) {
            const path = require('path'), cp = require('child_process');
            const base = process.env.MGU_PCM_PROBE_ROOT;
            if (base !== '/var/opt/pllana-airplay-probe-010/runtime') throw Error('invalid_probe_root');
            await wait(300);
            const allChannels = process.env.MGU_PCM_PROBE_ALL_CHANNELS === '1';
            const matrix = '<<' + Array.from({ length: 8 }, (_, i) =>
                process.env.MGU_PCM_PROBE_CHANNEL_TAGS === '1' ? '(float)' + ((i + 1) / 8) + ',(float)0' :
                '(float)' + ((allChannels ? i % 2 === 0 : i === 0) ? 1 : 0) + ',(float)' +
                ((allChannels ? i % 2 === 1 : i === 1) ? 1 : 0)).join('>,<') + '>>';
            const toneMode = process.env.MGU_PCM_PROBE_MODE === 'tone';
            // Wait for the asynchronous audio route before sending samples.
            let ready = false;
            for (let i = 0; i < 10; i++) {
                const current = await tick(() => command.callMethod('getListMainConnections', {}, 1000));
                const route = current.listConnections.find(c => c.mainConnectionID === owned.id);
                if (route && (route.connectionState === 'CS_CONNECTED' || route.connectionState === 2)) { ready = true; break; }
                await wait(150);
            }
            console.log(JSON.stringify({ route_ready_before_pcm: ready }));
            if (toneMode && !ready) throw Error('route_not_connected_before_tone');
            if (process.env.MGU_PCM_PROBE_TEST_VOLUME) {
                const target = Number(process.env.MGU_PCM_PROBE_TEST_VOLUME);
                if (!toneMode || source.sourceID !== 1046 || sink.sinkID !== 1024 || !Number.isInteger(target) || target < 1 || target > 20) throw Error('invalid_test_volume');
                const current = await readMainVolume();
                if (current.amError !== 'E_OK' || !Number.isInteger(current.mainVolume)) throw Error('cannot_read_test_volume');
                if (current.mainVolume > target) throw Error('test_volume_would_reduce_user_setting');
                testVolume = { before: current.mainVolume, target, delta: target - current.mainVolume };
                const graph = await tick(() => command.callMethod('getListMainConnections', {}, 1000));
                if (!graph.listConnections.some(c => c.mainConnectionID === owned.id && c.sourceID === owned.source && c.sinkID === owned.sink) || graph.listConnections.some(c => c.sinkID === owned.sink && c.mainConnectionID !== owned.id)) throw Error('volume_context_not_owned');
                const set = await tick(() => command.callMethod('setVolume', { sinkID: 1, volume: target }, 1200));
                const actual = await waitMainVolume(target);
                console.log(JSON.stringify({ temporary_connection_volume: { before: testVolume.before, requested: target, set, actual } }));
                if (set.amError !== 'E_OK' || actual.mainVolume !== target) throw Error('test_volume_not_applied');
            }
            if (observer) {
                const exclusive = await tick(() => command.callMethod('getListMainConnections', {}, 1000));
                if (exclusive.listConnections.some(c => c.sinkID === 1024 && c.mainConnectionID !== owned.id)) throw Error('front_sink_no_longer_exclusive');
                const beforeDecode = avConnections(await tick(() => diag.callMethod('StatusAvConnections', { handleIn: 0 }, 1200)));
                console.log(JSON.stringify({ physical_before_decode: beforeDecode }));
                decoderAnnounced = true;
                const report = await tick(() => observer.callMethod('hookSinkNotificationDataChange', { sinkID: 1024, payload: { type: 66, value: 2 } }, 1200));
                console.log(JSON.stringify({ decoded_audio_report: report }));
                await wait(600);
                const afterDecode = avConnections(await tick(() => diag.callMethod('StatusAvConnections', { handleIn: 0 }, 1200)));
                console.log(JSON.stringify({ physical_after_decode: afterDecode }));
                if (!afterDecode.some(c => c.source === 386 && c.state === 2)) throw Error('decoded_pcm_still_not_routed');
            }
            const binary = toneMode ? 'gst-launch-1.0' : 'alsa-probe';
            const testArgs = toneMode ? ['-q', 'audiotestsrc', 'volume=' + (allChannels ? '0.03' : '0.01'), 'num-buffers=10', 'samplesperbuffer=4800',
                '!', 'audio/x-raw,channels=2,rate=48000', '!', 'audioconvert', 'mix-matrix=' + matrix,
                '!', 'audio/x-raw,format=S16LE,channels=8,rate=48000',
                '!', 'alsasink', 'device=smartx:MediaSink_AudioOut_Front_CF_48_COMBINED_STEREO_MULTICHANNEL'] :
                ['smartx:MediaSink_AudioOut_Front_CF_48_COMBINED_STEREO_MULTICHANNEL'];
            const executable = path.join(base, 'lib/ld-linux-x86-64.so.2');
            const argv = ['--library-path', path.join(base, 'lib'), path.join(base, 'bin/' + binary)].concat(testArgs);
            const childEnv = Object.assign({}, process.env,
                    { LD_LIBRARY_PATH: path.join(base, 'lib'), ALSA_PLUGIN_DIR: '/usr/lib/alsa-lib',
                      GST_PLUGIN_SYSTEM_PATH_1_0: '', GST_PLUGIN_PATH_1_0: path.join(base, 'plugins'),
                      GST_REGISTRY: path.join(base, 'gst-registry.bin'), GST_REGISTRY_FORK: 'no' });
            let r;
            if (process.env.MGU_PCM_PROBE_METER === '1') {
                if (!diag || !diag.isAvailable()) throw Error('meter_requires_diagnostics');
                const graph = avConnections(await tick(() => diag.callMethod('StatusAvConnections', { handleIn: 0 }, 1200)));
                console.log(JSON.stringify({ physical_during_test: graph, mute_during_test: await tick(() => diag.callMethod('StatusMute', { handleIn: 0 }, 1200)) }));
                console.log(JSON.stringify({ main_volume_during_test: await readMainVolume() }));
                if (avb && avb.isAvailable()) {
                    const info = await tick(() => avb.callMethod('getAvbStreamInfo', {}, 1500));
                    console.log(JSON.stringify({ avb_audio_streams: info.audioStreamInfo }));
                }
                if (!graph.some(c => c.source === 386 && c.sink === 394 && c.state === 2)) throw Error('meter_route_changed');
                console.log(JSON.stringify({ meter_before: meterBuffers() }));
            }
            if (process.env.MGU_PCM_PROBE_METER === '1' && toneMode) {
                r = await new Promise((resolve, reject) => {
                    const child = cp.spawn(executable, argv, { env: childEnv });
                    let stdout = '', stderr = '';
                    child.stdout.on('data', b => { stdout = (stdout + b.toString()).slice(-16384); });
                    child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-16384); });
                    const limit = setTimeout(() => child.kill('SIGKILL'), 6000);
                    const meter = setInterval(() => console.log(JSON.stringify({ meter_during: meterBuffers() })), 120);
                    child.on('error', e => { clearTimeout(limit); clearInterval(meter); reject(e); });
                    child.on('close', status => { clearTimeout(limit); clearInterval(meter); resolve({ status, stdout, stderr }); });
                });
            } else {
                r = cp.spawnSync(executable, argv, { encoding: 'utf8', timeout: 6000, env: childEnv });
            }
            console.log(JSON.stringify({ pcm_probe_exit: r.status, stdout: r.stdout, stderr: r.stderr }));
            await wait(1000);
            const after = await tick(() => command.callMethod('getListMainConnections', {}, 2000));
            console.log(JSON.stringify({ owned_route_after_pcm: after.listConnections.find(c => c.mainConnectionID === owned.id) || null }));
            return;
        }
        const data = tone();
        server = http.createServer((req, res) => {
            requests++; console.log(JSON.stringify({ audio_http_request: true, range: req.headers.range || null }));
            res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': data.length }); res.end(data);
        });
        server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        await tick(() => player.subscribe({ name: 'playerState', onReceive: state => console.log(JSON.stringify({ player_state: state })) }));
        const play = await tick(() => player.callMethod('playFile', { path: 'http://127.0.0.1:' + server.address().port + '/airplay-probe.wav', languageCode: 0 }, 3000));
        playerUsed = true;
        console.log(JSON.stringify({ play_result: play }));
        const start = await tick(() => player.callMethod('sendButtonEvent', { button: 'PLAY', action: 'PRESS' }, 2000));
        console.log(JSON.stringify({ play_button_result: start }));
        await tick(() => player.callMethod('sendButtonEvent', { button: 'PLAY', action: 'RELEASE' }, 2000));
        await wait(2400);
        console.log(JSON.stringify({ http_requests: requests, final_state: await tick(() => player.getValue('playerState', 2000)) }));
    } finally {
        if (testVolume && command && owned) {
            const graph = await tick(() => command.callMethod('getListMainConnections', {}, 1000)).catch(() => null);
            const stillOwned = graph && graph.listConnections.some(c => c.mainConnectionID === owned.id && c.sourceID === owned.source && c.sinkID === owned.sink);
            const foreignFront = graph && graph.listConnections.some(c => c.sinkID === owned.sink && c.mainConnectionID !== owned.id);
            if (stillOwned && !foreignFront) {
                const actual = await readMainVolume().catch(() => null);
                if (actual && (actual.mainVolume === testVolume.target || actual.mainVolume === testVolume.before)) {
                    const restore = await tick(() => command.callMethod('setVolume', { sinkID: 1, volume: testVolume.before }, 1200)).catch(e => ({ error: String(e) }));
                    const verified = await waitMainVolume(testVolume.before).catch(() => null);
                    console.log(JSON.stringify({ connection_volume_restored: { result: restore, verified, expected: testVolume.before } }));
                } else console.log(JSON.stringify({ connection_volume_restore_skipped: 'volume_changed_independently', actual }));
            } else console.log(JSON.stringify({ connection_volume_restore_skipped: 'route_changed_independently' }));
        }
        if (decoderAnnounced && observer) {
            const report = await tick(() => observer.callMethod('hookSinkNotificationDataChange', { sinkID: 1024, payload: { type: 66, value: 0 } }, 1200)).catch(e => ({ error: String(e) }));
            console.log(JSON.stringify({ decoded_audio_report_reset: report }));
        }
        if (playerUsed && player) {
            const stop = await tick(() => player.callMethod('sendButtonEvent', { button: 'STOP', action: 'PRESS' }, 2000)).catch(() => ({ failed: true }));
            console.log(JSON.stringify({ player_stop_result: stop }));
            await tick(() => player.callMethod('sendButtonEvent', { button: 'STOP', action: 'RELEASE' }, 2000)).catch(() => {});
        }
        if (owned && command) {
            const current = await tick(() => command.callMethod('getListMainConnections', {}, 2000)).catch(() => null);
            if (current && current.listConnections.some(c => c.mainConnectionID === owned.id && c.sourceID === owned.source && c.sinkID === owned.sink)) {
                const result = await tick(() => command.callMethod('disconnect', { mainConnectionID: owned.id }, 2000)).catch(() => ({ failed: true }));
                console.log(JSON.stringify({ route_release: result }));
            }
        }
        sockets.forEach(s => s.destroy());
        if (server) try { server.close(); } catch (e) {}
        for (const p of proxies) if (p.shutdown) await tick(() => p.shutdown()).catch(() => {});
        clearTimeout(deadline);
    }
})().then(() => process.exit(0)).catch(e => { console.error(String(e)); process.exit(1); });
