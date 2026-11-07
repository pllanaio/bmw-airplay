'use strict';
const assert = require('assert');
const { AudioRoute } = require('../apps/pllana_airplay/audio_route');
function fixture(existing) {
    let connections = existing || [], next = 100;
    const calls = [];
    const signals = { proxy: async () => ({ isAvailable: () => true }), call: async (p, method, a) => {
        calls.push({ method, args: a });
        if (method === 'getListMainSources') return { amError: 'E_OK', listMainSources: [
            { sourceID: 1046, name: 'OAPGenericMedia' }, { sourceID: 1, name: 'FmDABCombined', availability: { availability: 'A_AVAILABLE' } }] };
        if (method === 'getListMainSinks') return { amError: 'E_OK', listMainSinks: [{ sinkID: 1024, name: 'MediaSink_Front' }] };
        if (method === 'getListMainConnections') return { amError: 'E_OK', listConnections: connections.slice() };
        if (method === 'connect') {
            connections = connections.filter(c => c.sinkID !== a.sinkID);
            const c = { mainConnectionID: next++, sourceID: a.sourceID, sinkID: a.sinkID, connectionState: 'CS_CONNECTED' };
            connections.push(c); return { amError: 'E_OK', mainConnectionID: c.mainConnectionID };
        }
        if (method === 'disconnect') { connections = connections.filter(c => c.mainConnectionID !== a.mainConnectionID); return { amError: 'E_OK' }; }
        throw Error(method);
    } };
    return { route: new AudioRoute(signals), calls, get: () => connections, replace: c => { connections = c; } };
}
(async () => {
    const radio = { mainConnectionID: 7, sourceID: 1, sinkID: 1024, connectionState: 'CS_CONNECTED' };
    let f = fixture([radio]); await f.route.acquire(); assert(await f.route.check()); await f.route.release();
    assert.strictEqual(f.get()[0].sourceID, 1, 'restore the previously active radio');
    assert(!f.calls.some(c => /Volume/.test(c.method)), 'regular sessions do not change volume');
    f = fixture([radio]); await f.route.acquire();
    f.replace([{ mainConnectionID: 9, sourceID: 266, sinkID: 1024, connectionState: 'CS_CONNECTED' }]);
    await f.route.release(); assert.strictEqual(f.get()[0].sourceID, 266, 'preserve a driver-selected replacement');
    assert(!f.calls.some(c => c.method === 'disconnect'), 'never disconnect somebody else');
    f = fixture([{ mainConnectionID: 9, sourceID: 1046, sinkID: 1024, connectionState: 'CS_CONNECTED' }]);
    let refused = false; try { await f.route.acquire(); } catch (e) { refused = e.message === 'audio_route_in_use'; }
    assert(refused); assert(!f.calls.some(c => c.method === 'connect' || c.method === 'disconnect'));
    console.log('Audio route ownership, restoration and source changes passed');
})().catch(e => { console.error(e); process.exit(1); });
