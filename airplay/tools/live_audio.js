'use strict';
// Bounded observer: no route, volume, mute or playback changes.
const fs = require('fs');
const { configs, tick, wait, someip } = require('./audio_probe');
const commandName = 'org.genivi.am.commandinterface.CommandControl';
const tunerName = 'de.bmw.infotainment.tuner.fmamdab.tunerfmamdab.TunerFmAmDab';
(async () => {
    const cfg = configs({
        [commandName]: { instances: '1', methods: ['getListMainSources', 'getListMainSinks', 'getListMainConnections'], attributes: { listOfMainConnections: 'rs' } },
        [tunerName]: { instances: '1', attributes: { stateTuner: 'rs' } },
    });
    const proxies = [], deadline = setTimeout(() => process.exit(2), 24000);
    const emit = value => console.log(JSON.stringify(Object.assign({ time: new Date().toISOString() }, value)));
    try {
        const command = await tick(() => someip.buildProxy(cfg[commandName], '1').then(p => p.init().then(() => p))); proxies.push(command);
        const tuner = await tick(() => someip.buildProxy(cfg[tunerName], '1').then(p => p.init().then(() => p))); proxies.push(tuner);
        await wait(1000);
        emit({ command_available: command.isAvailable(), tuner_available: tuner.isAvailable() });
        if (!command.isAvailable()) return;
        const sources = await tick(() => command.callMethod('getListMainSources', {}, 2000));
        const sinks = await tick(() => command.callMethod('getListMainSinks', {}, 2000));
        emit({ sources, sinks });
        await tick(() => command.subscribe({ name: 'listOfMainConnections', onReceive: value => emit({ connection_event: value }) }));
        let previousTuner;
        if (tuner.isAvailable()) await tick(() => tuner.subscribe({ name: 'stateTuner', onReceive: value => {
            const serial = JSON.stringify(value);
            if (serial !== previousTuner) emit({ tuner_state: value });
            previousTuner = serial;
        } }));
        let previous;
        for (let i = 0; i < 12; i++) {
            const current = await tick(() => command.callMethod('getListMainConnections', {}, 2000));
            const serial = JSON.stringify(current);
            if (serial !== previous || i === 11) emit({ connections: current });
            previous = serial;
            await wait(900);
        }
        const list = p => { try { return fs.readdirSync(p); } catch (e) { return []; } };
        emit({ config_paths: ['/usr/share/audiomanager', '/etc/mediaconfig', '/run/smartx', '/var/lib/audiomanager'].map(path => ({ path, entries: list(path) })) });
    } finally {
        for (const p of proxies) if (p.shutdown) await tick(() => p.shutdown()).catch(() => {});
        clearTimeout(deadline);
    }
})().then(() => process.exit(0)).catch(e => { console.error(String(e)); process.exit(1); });
