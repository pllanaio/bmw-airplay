'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { inspectBmwContracts, inspectBmwMedia, loadBmwCatalog, reportFromCatalog, saveBmwMediaReport, CATALOG, MAINAPP, KNOWN } = require('../apps/pllana_airplay/bmw_media');
function directories(directory) {
    if (fs.existsSync(directory)) return;
    directories(path.dirname(directory)); fs.mkdirSync(directory, 0o700);
}
function remove(directory) {
    for (const name of fs.readdirSync(directory)) {
        const file=path.join(directory,name), st=fs.lstatSync(file);
        if (st.isDirectory() && !st.isSymbolicLink()) remove(file); else fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
}
const mp = KNOWN[0];
// Artificial schema fixture only. No invented method/enum is used by the app.
const fixture = { interfaces: {
    [mp]: { serviceId: 7, fields: {
        currentItemMetadata: { dataRef:'fixtureMetadata', getter:{ fixture:true }, notifier:{ fixture:true },
            default:[{title:'PRIVATE_SONG'}],examples:['PRIVATE_EXAMPLE'],value:{title:'PRIVATE_CACHED'},
            default_value:'PRIVATE_DEFAULT',cached_value:'PRIVATE_CACHED_SNAKE' },
        playerState: { dataRef:'fixtureEnum', getter:{ fixture:true }, setter:{ fixture:true } },
    }, methods:{ fixtureOnlyMethod:{ inArgs:[{ dataRef:'fixtureMetadata' }] } } },
    'de.bmw.fixture.MediaButtons':{ fields:{ fixtureEvent:{ dataRef:'fixtureEnum' } } },
    'de.bmw.fixture.Unrelated':{ fields:{ unrelated:{ dataRef:'fixtureEnum' } } },
}, instanceIDs:{ [mp]:['CarPlayMedia','OapGenericMedia'] }, datatypes:{
    fixtureMetadata:{ type:'array', elementDataRef:'fixtureItem' },
    fixtureItem:{ type:'struct', members:[{ name:'key',dataRef:'fixtureEnum' },{ name:'value',dataRef:'fixtureText' }] },
    fixtureText:{ type:'typedef',dataRef:'String' },
    fixtureEnum:{ type:'enum',items:{ FIXTURE_FIRST:41,FIXTURE_SECOND:99 } },
} };
const report = reportFromCatalog(fixture);
assert.strictEqual(report.candidates.length, 2);
assert.strictEqual(report.candidates[0].interface, mp);
assert.deepStrictEqual(report.candidates[0].instances, ['CarPlayMedia','OapGenericMedia']);
assert.deepStrictEqual(report.candidates[0].datatypes.fixtureEnum, fixture.datatypes.fixtureEnum, 'retain actual enum values without remapping');
assert(report.candidates[0].datatypes.fixtureText, 'capture referenced array/struct/typedef schemas');
assert.strictEqual(report.integration.mediaProvider, false, 'a setter or method name never establishes a provider contract');
assert.strictEqual(report.integration.clusterMetadata, false);
assert.strictEqual(report.integration.steeringWheelCommands, false);
assert(!JSON.stringify(report).includes('PRIVATE_'), 'schema defaults/examples/cached media values are excluded');
assert(!report.candidates.some(row=>/Unrelated$/.test(row.interface)));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-media-schema-')); fs.chmodSync(directory, 0o700);
const catalog = path.join(directory, CATALOG), generated = path.join(directory, MAINAPP, mp.replace(/\./g,'_')+'.json');
directories(path.dirname(catalog)); directories(path.dirname(generated));
fs.writeFileSync(catalog, JSON.stringify(fixture)); fs.writeFileSync(generated, JSON.stringify({ fields:{ currentItemMetadata:{ getter:true, default:'PRIVATE_GENERATED' } }, endpoint:'192.168.1.20' }));
try {
    const actual = inspectBmwMedia({ root:directory });
    assert(loadBmwCatalog({root:directory}).value.interfaces[mp]);
    assert.strictEqual(actual.catalog.bytes, fs.statSync(catalog).size);
    assert(/^[0-9a-f]{64}$/.test(actual.catalog.sha256));
    assert.strictEqual(actual.generatedDefinitions.length, 1);
    assert(!JSON.stringify(actual).includes('PRIVATE_')); assert(!JSON.stringify(actual).includes('192.168.1.20'));
    const combined=inspectBmwContracts({root:directory});
    assert.strictEqual(combined.focus.supported,false);
    const saved = saveBmwMediaReport(directory, actual);
    assert.strictEqual(fs.statSync(saved).mode & 0o777, 0o600);
    assert.strictEqual(JSON.parse(fs.readFileSync(saved, 'utf8')).integration.mediaProvider, false);
    const summary = require('../apps/pllana_airplay/inspect_bmw_contracts').run(['--root',directory,'--output-dir',directory]);
    assert.strictEqual(summary.supported,false); assert.strictEqual(summary.candidateCount,2);
    assert.strictEqual(JSON.parse(fs.readFileSync(saved,'utf8')).focus.supported,false);
    assert.throws(()=>require('../apps/pllana_airplay/inspect_bmw_contracts').run([]), /private_output_directory_required/);
    fs.unlinkSync(saved); fs.symlinkSync(catalog, saved);
    assert.throws(()=>saveBmwMediaReport(directory, actual), /invalid_media_report_file/); fs.unlinkSync(saved);
    fs.chmodSync(directory, 0o755);
    assert.throws(()=>saveBmwMediaReport(directory, actual), /invalid_media_report_directory/); fs.chmodSync(directory, 0o700);
    fs.writeFileSync(catalog, 'not-json');
    assert.strictEqual(inspectBmwMedia({root:directory}).catalog.error, 'invalid_json_or_read');
    fs.unlinkSync(catalog);
    assert.strictEqual(inspectBmwMedia({root:directory}).catalog.error, 'ENOENT');
    fs.symlinkSync(generated, catalog);
    assert.strictEqual(inspectBmwMedia({root:directory}).catalog.error, 'ELOOP');
} finally { remove(directory); }
console.log('BMW media schema capture is bounded/read-only, preserves real types and never fabricates provider/cluster/steering capability');
