'use strict';
const IFACE = 'org.genivi.am.commandinterface.CommandControl';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ok = value => value && (value.amError === 'E_OK' || value.amError === 0);
const connected = c => c.connectionState === 'CS_CONNECTED' || c.connectionState === 2;

// Initial hardware profile: the validated combined SmartX input. Stereo pairs
// are duplicated for this prototype; speaker layout qualification is pending.
const matrix = '<<' + Array.from({ length: 8 }, (_, i) =>
    '(float)' + (i % 2 === 0 ? 1 : 0) + ',(float)' + (i % 2 === 1 ? 1 : 0)).join('>,<') + '>>';
const AUDIO_SINK = 'audioconvert ! audio/x-raw,channels=2 ! audioresample ! audio/x-raw,rate=48000 ! ' +
    'audioconvert mix-matrix="' + matrix + '" ! audio/x-raw,format=S16LE,channels=8,rate=48000 ! ' +
    'alsasink device=smartx:MediaSink_AudioOut_Front_CF_48_COMBINED_STEREO_MULTICHANNEL';

class AudioRoute {
    constructor(signals) { this.signals = signals; this.proxy = null; this.owned = null; this.previous = null; }
    async call(method, params) {
        const result = await this.signals.call(this.proxy, method, params || {}, 2000);
        if (!ok(result)) throw Error('audio_' + method + '_failed');
        return result;
    }
    async acquire() {
        if (this.owned) throw Error('audio_route_in_use');
        if (!this.proxy) this.proxy = await this.signals.proxy(IFACE, '1');
        for (let i = 0; !this.proxy.isAvailable() && i < 20; i++) await wait(100);
        if (!this.proxy.isAvailable()) throw Error('audio_unavailable');
        const sources = (await this.call('getListMainSources')).listMainSources;
        const sinks = (await this.call('getListMainSinks')).listMainSinks;
        const source = sources.find(s => s.name === 'OAPGenericMedia');
        const sink = sinks.find(s => s.name === 'MediaSink_Front');
        if (!source || !sink) throw Error('audio_profile_missing');
        const before = (await this.call('getListMainConnections')).listConnections;
        if (before.some(c => c.sourceID === source.sourceID && c.sinkID === sink.sinkID)) throw Error('audio_route_in_use');
        this.previous = before.filter(c => c.sinkID === sink.sinkID && connected(c));
        const grant = await this.call('connect', { sourceID: source.sourceID, sinkID: sink.sinkID });
        if (before.some(c => c.mainConnectionID === grant.mainConnectionID)) throw Error('audio_route_not_new');
        this.owned = { id: grant.mainConnectionID, source: source.sourceID, sink: sink.sinkID };
        for (let i = 0; i < 20; i++) {
            const all = (await this.call('getListMainConnections')).listConnections;
            const current = all.find(c => this.matches(c));
            if (current && connected(current)) return;
            await wait(100);
        }
        throw Error('audio_route_timeout');
    }
    matches(c) { const o = this.owned; return o && c.mainConnectionID === o.id && c.sourceID === o.source && c.sinkID === o.sink; }
    async check() {
        if (!this.owned) return false;
        const all = (await this.call('getListMainConnections')).listConnections;
        return all.some(c => this.matches(c) && connected(c));
    }
    async release() {
        if (!this.owned) return;
        const owned = this.owned;
        const all = (await this.call('getListMainConnections')).listConnections;
        // If the driver chose another source, leave that choice intact.
        const stillOurs = all.some(c => this.matches(c));
        if (stillOurs) await this.call('disconnect', { mainConnectionID: owned.id });
        this.owned = null;
        if (stillOurs && this.previous && this.previous.length === 1) {
            await wait(150);
            const now = (await this.call('getListMainConnections')).listConnections;
            if (!now.some(c => c.sinkID === owned.sink)) {
                const prior = this.previous[0];
                const sources = (await this.call('getListMainSources')).listMainSources;
                if (sources.some(s => s.sourceID === prior.sourceID && s.availability && s.availability.availability === 'A_AVAILABLE'))
                    await this.call('connect', { sourceID: prior.sourceID, sinkID: prior.sinkID });
            }
        }
        this.previous = null;
    }
}
module.exports = { AudioRoute, AUDIO_SINK, IFACE };
