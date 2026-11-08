'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const cp = require('child_process');
const { inspectFocusCapabilities, INTERFACES } = require('../apps/pllana_airplay/carplay_focus');
const { loadBmwCatalog } = require('../apps/pllana_airplay/bmw_media');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'airplay-focus-inspect-'));
const file = path.join(directory, 'catalog.json');
const presentation = 'de.bmw.fixture.DevicePresentation';
const carplay = INTERFACES[0];
try {
    const catalog = { interfaces: {}, instanceIDs: {} };
    catalog.interfaces[presentation] = {
        instances: { '1': { serviceId: 123 } },
        methods: { fixtureClaim: { request: { device: { dataRef: 'FixturePresentation.DeviceID', type: 'UInt64', defaultValue: 'private-device-id' },
            priority: { type: 'FixturePriority' }, token: { type: 'String', example: 'private-token' } },
            response: { error: { type: 'FixtureResult' } } } },
        fields: { fixtureState: { getter: {}, setter: {}, type: 'FixturePresentationState',
            defaultValue: 'private-live-state' } },
    };
    catalog.instanceIDs[presentation] = { '1': 1234 };
    catalog.interfaces[carplay] = { instances: [{ name: 'CarPlayManagerInst1' }],
        fields: { fixtureConnected: { getter: { id: 10 }, type: 'Boolean', currentValue: 'private-phone-name' } } };
    catalog.interfaces['de.bmw.fixture.ChassisControl'] = { methods: { unrelatedActuator: {} } };
    fs.writeFileSync(file, JSON.stringify(catalog));
    const report = inspectFocusCapabilities(file);
    assert.strictEqual(report.readOnly, true); assert.strictEqual(report.supported, false); assert.strictEqual(report.canClaim, false);
    assert.strictEqual(report.reason, 'focus_contract_unverified');
    assert.strictEqual(report.candidates.length, 2);
    const found = report.candidates.find(value => value.interface === presentation);
    assert.deepStrictEqual(found.instances, ['1']);
    assert.strictEqual(found.methods[0].name, 'fixtureClaim');
    assert.strictEqual(found.methods[0].signature.request.device.type, 'UInt64');
    assert.strictEqual(found.methods[0].signature.request.device.dataRef, 'FixturePresentation.DeviceID');
    assert.strictEqual(found.fields[0].readable, true); assert.strictEqual(found.fields[0].writable, true);
    const serialized = JSON.stringify(report);
    assert(!/private-device|private-token|private-live|private-phone|unrelatedActuator/.test(serialized));
    assert(!Object.prototype.hasOwnProperty.call(report, 'claimMethod'), 'method names never become a guessed focus contract');
    const snapshot = loadBmwCatalog({ file });
    fs.unlinkSync(file);
    assert.strictEqual(inspectFocusCapabilities(file, snapshot).candidates.length, 2, 'combined capture reuses the exact snapshot without reading again');
    // Large/nested schemas cannot turn a local report into an unbounded state
    // packet or recurse indefinitely. Only structural metadata is retained.
    const wide = { interfaces: {} };
    for (let i = 0; i < 40; i++) {
        const methods = {};
        for (let j = 0; j < 100; j++) methods['method' + j] = { request: { argument: { type: 'Type' + 'x'.repeat(120) } } };
        wide.interfaces['de.bmw.fixture.CarPlay' + i] = { methods, instances: [1, 2, 3] };
    }
    fs.writeFileSync(file, JSON.stringify(wide));
    const bounded = inspectFocusCapabilities(file);
    assert(bounded.candidates.length <= 16); assert.strictEqual(bounded.truncated, true);
    assert(Buffer.byteLength(JSON.stringify(bounded)) <= 16384);
    fs.writeFileSync(file, JSON.stringify({ interfaces: { 'de.bmw.fixture.ChassisControl': {} } }));
    assert.strictEqual(inspectFocusCapabilities(file).reason, 'focus_interfaces_absent');
    fs.writeFileSync(file, '{broken');
    assert.strictEqual(inspectFocusCapabilities(file).reason, 'focus_catalog_invalid');
    fs.writeFileSync(file, '[]');
    assert.strictEqual(inspectFocusCapabilities(file).reason, 'focus_catalog_invalid');
    fs.truncateSync(file, 16 * 1024 * 1024 + 1);
    assert.strictEqual(inspectFocusCapabilities(file).reason, 'focus_catalog_invalid_size_or_type');
    fs.unlinkSync(file);
    assert.strictEqual(inspectFocusCapabilities(file).reason, 'focus_catalog_missing');
    fs.symlinkSync('/etc/passwd', file);
    assert.strictEqual(inspectFocusCapabilities(file).reason, 'focus_catalog_unreadable'); fs.unlinkSync(file);
    if (process.platform === 'linux') {
        cp.execFileSync('mkfifo', [file]);
        assert.strictEqual(inspectFocusCapabilities(file).reason, 'focus_catalog_invalid_size_or_type'); fs.unlinkSync(file);
    }
    console.log('Read-only CarPlay capability discovery: explicit unverified status, structural redaction, bounded output and safe file handling passed');
} finally {
    try { fs.unlinkSync(file); } catch (ignore) {}
    fs.rmdirSync(directory);
}
