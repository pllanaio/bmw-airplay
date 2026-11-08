'use strict';
// Inspect BMW's installed schemas without calling/offering a vehicle service.
// Reading another player's metadata is not permission to publish into it.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const CATALOG = '/etc/oap/someip/someip-interfaces.json';
const MAINAPP = '/usr/lib/oap-mainapp/src-gen';
const KNOWN = [
    'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer',
    'de.bmw.infotainment.entertainment.dynamicmediaplayer.DynamicMediaPlayer',
    'de.bmw.infotainment.hmi.hmimediastate.HmiMediaState',
    'de.bmw.infotainment.a4a.carplay.CarPlayManager',
];
const MAX_CATALOG = 16 * 1024 * 1024, MAX_DEFINITION = 128 * 1024, MAX_REPORT = 2 * 1024 * 1024;
const RELEVANT = /media|nowplaying|entertainment|steeringwheel|multifunction|(?:^|\.)mfl(?:\.|$)/i;
const MEMBER = /currentitemmetadata|currentitemtime|playerstate|trackinfo|songinfo|nexttrack|previoustrack|mediabutton|steeringwheelbutton/i;
const NAME = /^de\.bmw\.[A-Za-z0-9_.]{1,180}$/;
const ANNOTATION = /^(?:description|documentation|comment|comments|default|defaultvalue|initialvalue|example|examples|sample|samples)$/i;
const DEPLOYMENT = /^(?:address|addresses|ip|ipaddress|hostname|host|port|ports|endpoint|endpoints|url|uri|routing|transportaddress)$/i;
const CACHED_VALUE = /^(?:value|values|currentvalue|cachedvalue|lastvalue|runtimevalue|password|token|secret|phonenumber|phonename|devicename)$/i;

function readJson(file, maximum, io) {
    let fd;
    try {
        fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
        const st = io.fstatSync(fd);
        if (!st.isFile() || st.size < 2 || st.size > maximum) return { error: 'invalid_size_or_type' };
        const bytes = Buffer.alloc(st.size + 1);
        let count = 0;
        while (count < bytes.length) {
            const n = io.readSync(fd, bytes, count, bytes.length - count, count);
            if (!n) break;
            count += n;
        }
        if (count !== st.size) return { error: 'changed_during_read' };
        return { value: JSON.parse(bytes.toString('utf8', 0, count)), bytes: count,
            sha256: crypto.createHash('sha256').update(bytes.slice(0, count)).digest('hex') };
    } catch (e) {
        return { error: e && ['ENOENT', 'EACCES', 'EPERM', 'ELOOP'].indexOf(e.code) >= 0 ? e.code : 'invalid_json_or_read' };
    } finally { if (fd !== undefined) io.closeSync(fd); }
}

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function typedDescriptor(value) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
        ['dataRef','type','members','items','getter','setter','notifier'].some(key => Object.prototype.hasOwnProperty.call(value,key));
}
function schemaOnly(value, depth, enumItems) {
    if (depth > 16) return {omitted:'schema_depth'};
    if (Array.isArray(value)) return value.map(item => schemaOnly(item,depth+1,enumItems));
    if (!value || typeof value !== 'object') return value;
    const out=Object.create(null);
    for (const key of Object.keys(value)) {
        const item=value[key], descriptor=typedDescriptor(item);
        const schemaKey=key.replace(/[_-]/g,'');
        if (ANNOTATION.test(schemaKey) && !descriptor) continue;
        if ((DEPLOYMENT.test(schemaKey) || CACHED_VALUE.test(schemaKey)) && !descriptor && !enumItems) continue;
        if (typeof item === 'string' && /^(?:https?|file):\/\//i.test(item)) continue;
        out[key]=schemaOnly(item,depth+1,enumItems || (value.type==='enum' && key==='items'));
    }
    return out;
}
function bounded(value, budget) {
    const text = JSON.stringify(schemaOnly(value,0,false));
    const bytes = text ? Buffer.byteLength(text, 'utf8') : 0;
    if (!text || bytes > MAX_DEFINITION) return { omitted:'definition_too_large' };
    if (budget && bytes > budget.remaining) return { omitted:'report_budget' };
    if (budget) budget.remaining -= bytes;
    return JSON.parse(text);
}
function dataRefs(value, refs, depth) {
    if (!value || typeof value !== 'object' || depth > 16) return;
    Object.keys(value).slice(0, 2048).forEach(key => {
        const v = value[key];
        if (['dataRef', 'elementDataRef', 'extends', 'baseType'].indexOf(key) >= 0 && typeof v === 'string') refs.add(v);
        else if (v && typeof v === 'object') dataRefs(v, refs, depth + 1);
    });
}
function referencedTypes(definition, datatypes, budget) {
    const refs = new Set(), result = Object.create(null);
    dataRefs(definition, refs, 0);
    let processed = 0;
    for (const ref of refs) {
        if (++processed > 256) { result._omitted = 'type_limit'; break; }
        if (!Object.prototype.hasOwnProperty.call(datatypes, ref)) continue;
        if (budget.remaining < 1024) { result._omitted = 'report_budget'; break; }
        const type = bounded(datatypes[ref], budget);
        result[ref] = type;
        dataRefs(type, refs, 0);
    }
    return result;
}
function interfaceDefinition(definition, budget) {
    const out = Object.create(null);
    // Preserve method arguments and named enums exactly; infer no directions,
    // button numbers, setter semantics or ownership from a suggestive name.
    for (const key of ['serviceId', 'version', 'fields', 'methods', 'broadcasts', 'events', 'extends'])
        if (definition[key] !== undefined) out[key] = definition[key];
    return bounded(out, budget);
}

function reportFromCatalog(database) {
    database = object(database);
    const interfaces = object(database.interfaces), datatypes = object(database.datatypes);
    const names = Object.keys(interfaces).filter(name => {
        if (!NAME.test(name)) return false;
        if (KNOWN.indexOf(name) >= 0 || RELEVANT.test(name)) return true;
        const item = object(interfaces[name]);
        return Object.keys(object(item.fields)).concat(Object.keys(object(item.methods))).some(member => MEMBER.test(member));
    }).sort((a, b) => {
        const ai = KNOWN.indexOf(a), bi = KNOWN.indexOf(b);
        return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi) || a.localeCompare(b);
    });
    const budget = {remaining:MAX_REPORT-65536};
    const rows = names.slice(0, 32).map(name => {
        const definition = interfaceDefinition(object(interfaces[name]), budget);
        return { interface: name, definition, instances: bounded(object(database.instanceIDs)[name] || [], budget),
            datatypes: referencedTypes(definition, datatypes, budget) };
    });
    return { format: 'bmw-airplay-media-contract-v1',
        source: 'installed_static_schema', interfaceCount: Object.keys(interfaces).length,
        candidates: rows, omittedCandidates: Math.max(0, names.length - rows.length),
        missingKnownInterfaces: KNOWN.filter(name => !Object.prototype.hasOwnProperty.call(interfaces, name)),
        integration: { steeringWheelCommands: false, clusterMetadata: false, mediaProvider: false,
            reason: 'provider_and_ownership_contract_not_verified' } };
}

function loadBmwCatalog(options) {
    options = options || {};
    const root = options.root || '/';
    const file = options.file || path.join(root, CATALOG.replace(/^\/+/, ''));
    return readJson(file, MAX_CATALOG, options.fs || fs);
}

function inspectBmwMedia(options) {
    options = options || {};
    const io = options.fs || fs;
    // A root path is only for an offline filesystem fixture; no UI/request may
    // supply a filename. The production paths below are fixed firmware paths.
    const root = options.root || '/';
    const at = file => path.join(root, file.replace(/^\/+/, ''));
    const catalog = options.catalogSnapshot || loadBmwCatalog(options);
    const report = reportFromCatalog(catalog.value);
    report.catalog = catalog.error ? { error: catalog.error } : { bytes: catalog.bytes, sha256: catalog.sha256 };
    report.generatedDefinitions = [];
    const budget = {remaining:Math.max(0,MAX_REPORT-65536-Buffer.byteLength(JSON.stringify(report),'utf8'))};
    for (const name of KNOWN) {
        const file = path.join(MAINAPP, name.replace(/\./g, '_') + '.json');
        const generated = readJson(at(file), MAX_DEFINITION, io);
        if (!generated.error) report.generatedDefinitions.push({ interface: name, definition: bounded(generated.value, budget),
            bytes: generated.bytes, sha256: generated.sha256 });
    }
    if (Buffer.byteLength(JSON.stringify(report), 'utf8') > MAX_REPORT)
        return { format: report.format, source:report.source, catalog: report.catalog, candidates: [], generatedDefinitions: [],
            error: 'report_too_large', integration: report.integration };
    return report;
}

function inspectBmwContracts(options) {
    options=options || {};
    const catalog=loadBmwCatalog(options);
    const report=inspectBmwMedia(Object.assign({},options,{catalogSnapshot:catalog}));
    // Lazy import avoids a circular initialization: the focus inspector uses
    // our shared loader but never exposes the original graph in its report.
    const {inspectFocusCapabilities}=require('./carplay_focus');
    report.focus=inspectFocusCapabilities(options.file,catalog);
    return report;
}

function saveBmwMediaReport(directory, report) {
    if (!report || report.format!=='bmw-airplay-media-contract-v1' || report.source!=='installed_static_schema')
        throw Error('invalid_media_contract_report');
    const st = fs.lstatSync(directory), uid = process.getuid();
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077)) throw Error('invalid_media_report_directory');
    const text = JSON.stringify(report) + '\n';
    if (Buffer.byteLength(text, 'utf8') > MAX_REPORT) throw Error('media_report_too_large');
    const destination = path.join(directory, 'bmw-media-contract.json');
    try {
        const old = fs.lstatSync(destination);
        if (!old.isFile() || old.isSymbolicLink() || old.nlink !== 1 || old.uid !== uid) throw Error('invalid_media_report_file');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const temporary = destination + '.tmp-' + crypto.randomBytes(8).toString('hex');
    try {
        fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, destination);
    } finally { try { fs.unlinkSync(temporary); } catch (e) {} }
    return destination;
}

module.exports = { inspectBmwContracts, inspectBmwMedia, loadBmwCatalog, reportFromCatalog, saveBmwMediaReport, CATALOG, MAINAPP, KNOWN };
