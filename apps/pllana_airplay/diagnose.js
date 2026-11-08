'use strict';
// Explains in the app why the receiver service cannot be reached, from what
// the receiver runtime writes (/run/pllana-airplay/status.json) and which
// runtime is installed. Read-only; returns '' when there is nothing to say.
const fs = require('fs');
const STATUS = '/run/pllana-airplay/status.json';
const RECEIVER = '/var/opt/pllana-airplay-receiver/current/component.json';
const OLD = '/var/opt/mgu-airplay/current/component.json';
function readJson(io, file) {
    try { const text = io.readFileSync(file, 'utf8'); return text.length < 65536 ? JSON.parse(text) : null; } catch (e) { return null; }
}
function diagnose(uid, io) {
    io = io || fs;
    const receiver = readJson(io, RECEIVER), old = readJson(io, OLD), status = readJson(io, STATUS);
    if (!receiver && !old) return 'AirPlay-Empfänger fehlt: im Store „AirPlay receiver“ über Quelle „Releases“ installieren.';
    if (receiver && status && typeof status.state === 'string') {
        const other = Number.isInteger(status.uid) && status.uid !== uid;
        switch (status.state) {
            case 'waiting_for_app': return 'Empfänger wartet auf die App-Registrierung. Headunit einmal neu starten.';
            case 'app_identity_invalid': return 'Empfänger findet keine eindeutige App-Kennung (' + String(status.error || '').slice(0, 40) + ').';
            case 'starting': return 'Empfangsdienst startet …';
            case 'backend_launch_failed': return 'Empfangsdienst konnte nicht starten: ' + String(status.error || '').slice(0, 60);
            case 'backend_exited': return 'Empfangsdienst beendet (Code ' + (status.signal || status.code) + ') – Neustart läuft …';
            case 'running': if (other) return 'Empfänger läuft für App-UID ' + status.uid + ', diese App hat ' + uid + '. Headunit neu starten.'; break;
            case 'stopped': return 'Empfangsdienst ist angehalten. Headunit einmal neu starten.';
        }
        return '';
    }
    if (receiver) return 'Empfangsdienst startet … (noch kein Status)';
    const bound = /UID (\d+)/.exec(String(old.description || ''));
    if (bound && Number(bound[1]) !== uid)
        return 'Alte AirPlay-Laufzeit gehört zu UID ' + bound[1] + ' (App: ' + uid + '). „AirPlay receiver“ über „Releases“ installieren.';
    return 'Alte AirPlay-Laufzeit ' + (old.version || '') + ' antwortet nicht. „AirPlay receiver“ über „Releases“ installieren.';
}
// Miracast pre-check written by the receiver runtime (p2p_probe.js).
const P2P = '/run/pllana-airplay/p2p.json';
function wifiDirect(io) {
    const record = readJson(io || fs, P2P);
    const texts = { concurrent: 'Miracast-Vorprüfung: Wi-Fi Direct neben dem Hotspot möglich',
        exclusive: 'Miracast-Vorprüfung: Wi-Fi Direct nur ohne Hotspot', unsupported: 'Miracast-Vorprüfung: WLAN-Chip ohne Wi-Fi Direct' };
    return record && texts[record.summary] || '';
}
module.exports = { diagnose, wifiDirect, STATUS, RECEIVER, OLD, P2P };
