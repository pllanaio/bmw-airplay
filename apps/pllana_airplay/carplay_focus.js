'use strict';
// Structural discovery only. The available public references establish these
// interfaces, but no verified BMW presentation claim/release/priority contract.
// A catalog method name is not evidence that calling it would preserve calls,
// OEM priority or an existing CarPlay session. This module never writes/calls.
const { CATALOG, loadBmwCatalog } = require('./bmw_media');
const MAX_REPORT = 16384, MAX_INTERFACES = 16, MAX_MEMBERS = 48;
const INTERFACES = [
    'de.bmw.infotainment.a4a.carplay.CarPlayManager',
    'de.bmw.infotainment.hmi.hmimediastate.HmiMediaState',
    'de.bmw.infotainment.entertainment.dynamicmediaplayer.DynamicMediaPlayer',
    'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer',
];
const NAME = /^[A-Za-z_][A-Za-z0-9_.:\[\]<>-]{0,191}$/;
const CANDIDATE = /carplay|devicepresentation|presentation|mediafocus|audiofocus|hmimediastate|telephony|phonecall/i;
const SIGNATURE = ['type', 'dataType', 'datatype', 'typeName', 'typeRef', 'dataRef', 'elementDataRef', 'baseType', 'input', 'output', 'in', 'out',
    'inArgs', 'outArgs', 'inParameters', 'outParameters', 'arguments', 'parameters', 'params', 'request', 'response', 'result'];

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function named(value) { return typeof value === 'string' && NAME.test(value); }
function entries(value) {
    if (Array.isArray(value)) return value.slice(0, MAX_MEMBERS).map(item =>
        [typeof item === 'string' ? item : item && item.name, item]).filter(pair => named(pair[0]));
    return object(value) ? Object.keys(value).filter(named).sort().slice(0, MAX_MEMBERS).map(key => [key, value[key]]) : [];
}
function instances(value) {
    let all = Array.isArray(value) ? value.map(item => object(item) ? item.name || item.instance || item.id : item) :
        object(value) ? Object.keys(value) : [value];
    return all.filter(item => typeof item === 'string' || Number.isSafeInteger(item)).map(String)
        .filter(name => /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,95}$/.test(name)).sort().slice(0, 16);
}
function shape(value, depth, key, budget) {
    if (--budget.left < 0) return '<node-limit>';
    if (depth < 0) return '<depth-limit>';
    if (typeof value === 'string')
        return ['name', 'type', 'dataType', 'datatype', 'typeName', 'typeRef', 'dataRef', 'elementDataRef', 'baseType'].indexOf(key) >= 0 && named(value) ? value : '<string>';
    if (typeof value === 'number') return '<number>';
    if (typeof value === 'boolean') return '<boolean>';
    if (Array.isArray(value)) return value.slice(0, Math.max(0, Math.min(16, budget.left))).map(item => shape(item, depth - 1, '', budget));
    if (!object(value)) return null;
    const out = Object.create(null);
    Object.keys(value).filter(named).sort().slice(0, Math.max(0, Math.min(24, budget.left))).forEach(name => {
        // Default/example/runtime values have no place in a capability report.
        if (/^(?:default(?:Value)?|example|examples|currentValue|value|values|description)$/i.test(name)) return;
        out[name] = shape(value[name], depth - 1, name, budget);
    });
    return out;
}
function member(name, definition, field, budget) {
    const out = { name };
    if (object(definition)) {
        if (field) {
            out.readable = !!definition.getter;
            out.writable = !!definition.setter;
        }
        const signature = Object.create(null);
        SIGNATURE.forEach(key => {
            if (budget.left > 0 && Object.prototype.hasOwnProperty.call(definition, key)) signature[key] = shape(definition[key], 3, key, budget);
        });
        if (Object.keys(signature).length) out.signature = signature;
    }
    return out;
}
function describe(name, definition, catalogInstances) {
    definition = object(definition) ? definition : {};
    const budget = { left: 96 };
    return {
        interface: name,
        instances: instances(catalogInstances || definition.instances),
        methods: entries(definition.methods).map(pair => member(pair[0], pair[1], false, budget)),
        fields: entries(definition.fields || definition.attributes).map(pair => member(pair[0], pair[1], true, budget)),
    };
}
function result(reason, candidates) {
    return { supported: false, canClaim: false, reason, readOnly: true, candidates: candidates || [] };
}
function inspectFocusCapabilities(file, catalogSnapshot) {
    // The combined diagnostics capture passes its already-read snapshot so
    // media and presentation capabilities describe the same static catalog.
    const loaded = catalogSnapshot || loadBmwCatalog({ file });
    if (loaded.error) {
        const reasons = { ENOENT: 'focus_catalog_missing', EACCES: 'focus_catalog_denied', EPERM: 'focus_catalog_denied',
            invalid_size_or_type: 'focus_catalog_invalid_size_or_type', changed_during_read: 'focus_catalog_incomplete',
            invalid_json_or_read: 'focus_catalog_invalid' };
        return result(reasons[loaded.error] || 'focus_catalog_unreadable');
    }
    try {
        const catalog = loaded.value;
        const all = object(catalog) && object(catalog.interfaces) ? catalog.interfaces : catalog;
        if (!object(all)) return result('focus_catalog_invalid');
        const names = Object.keys(all).filter(name => named(name) && (CANDIDATE.test(name) || INTERFACES.indexOf(name) >= 0));
        const candidates = []; let truncated = names.length > MAX_INTERFACES;
        names.sort().slice(0, MAX_INTERFACES).forEach(name => {
            const candidate = describe(name, all[name], object(catalog.instanceIDs) && catalog.instanceIDs[name]);
            if (Buffer.byteLength(JSON.stringify(candidates.concat([candidate])), 'utf8') > MAX_REPORT - 256) {
                candidate.methods.forEach(item => { delete item.signature; });
                candidate.fields.forEach(item => { delete item.signature; });
                truncated = true;
            }
            if (Buffer.byteLength(JSON.stringify(candidates.concat([candidate])), 'utf8') <= MAX_REPORT - 256) candidates.push(candidate);
            else truncated = true;
        });
        const report = result(names.length ? 'focus_contract_unverified' : 'focus_interfaces_absent', candidates);
        report.truncated = truncated;
        return report;
    } catch (e) { return result('focus_catalog_invalid'); }
}
module.exports = { CATALOG, INTERFACES, inspectFocusCapabilities };
