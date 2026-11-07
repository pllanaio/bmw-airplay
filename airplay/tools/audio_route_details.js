'use strict';
const { configs, tick, wait, someip } = require('./audio_probe');
const commandName = 'org.genivi.am.commandinterface.CommandControl';
const diagName = 'de.bmw.infotainment.systemfunctions.diagnostics.job.Ent.DiagEntAudio';
(async () => {
    const cfg = configs({
        [commandName]: { instances: '1', methods: ['getListMainConnections', 'getListMainSinks', 'getVolume', 'getListSystemProperties', 'getListMainSourceSoundProperties', 'getListMainSinkSoundProperties'] },
        [diagName]: { instances: 'Inst1', methods: ['StatusAudioSources', 'StatusAvConnections', 'StatusMainAvConnections', 'StatusMute', 'StatusLesenSystemaudio'] },
    });
    const proxies = [], deadline = setTimeout(() => process.exit(2), 24000);
    try {
        for (const entry of [[commandName, '1'], [diagName, 'Inst1']]) {
            const p = await tick(() => someip.buildProxy(cfg[entry[0]], entry[1]).then(p => p.init().then(() => p)));
            proxies.push(p);
        }
        await wait(1200);
        for (let i = 0; i < proxies.length; i++) {
            const p = proxies[i];
            console.log(JSON.stringify({ interface: i === 0 ? commandName : diagName, available: p.isAvailable() }));
            if (!p.isAvailable()) continue;
            const queries = i === 0 ? [
                ['getListMainConnections', {}], ['getListMainSinks', {}], ['getVolume', { sinkID: 1 }], ['getListSystemProperties', {}],
                ['getListMainSourceSoundProperties', { sourceID: 1046 }],
                ['getListMainSourceSoundProperties', { sourceID: 386 }],
                ['getListMainSinkSoundProperties', { sinkID: 1024 }],
                ['getListMainSinkSoundProperties', { sinkID: 1 }],
            ] : ['StatusAudioSources', 'StatusAvConnections', 'StatusMainAvConnections', 'StatusMute', 'StatusLesenSystemaudio'].map(m => [m, { handleIn: 0 }]);
            for (const q of queries) {
                const value = await tick(() => p.callMethod(q[0], q[1], 1200)).catch(e => ({ error: String(e) }));
                console.log(JSON.stringify({ method: q[0], args: q[1], value }));
            }
        }
    } finally {
        for (const p of proxies) if (p.shutdown) await tick(() => p.shutdown()).catch(() => {});
        clearTimeout(deadline);
    }
})().then(() => process.exit(0)).catch(e => { console.error(String(e)); process.exit(1); });
