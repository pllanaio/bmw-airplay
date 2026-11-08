'use strict';
// UPnP/DLNA MediaRenderer for Android phones ("Streamen auf" / "Smart View"
// for media / Cast-to-device apps such as BubbleUPnP, Web Video Caster, VLC,
// Samsung Gallery and Music). The phone hands over a media URL; the native
// player fetches it and renders it with the AirPlay video/audio path.
//
// Network: SSDP (UDP 1900, 239.255.255.250) and HTTP control on TCP 7103,
// both only on the BMW access point and the Wi-Fi uplink (phone hotspot),
// only for private IPv4 peers. Event callbacks only go back to the
// subscriber's own address. No shell, no files outside the app data dir.
const EventEmitter = require('events');
const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { validUri } = require('./media_player');

const SSDP_ADDRESS = '239.255.255.250', SSDP_PORT = 1900, HTTP_PORT = 7103;
const DEVICE = 'urn:schemas-upnp-org:device:MediaRenderer:1';
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RCS = 'urn:schemas-upnp-org:service:RenderingControl:1';
const CMS = 'urn:schemas-upnp-org:service:ConnectionManager:1';
const SERVICES = { AVTransport: AVT, RenderingControl: RCS, ConnectionManager: CMS };
const INTERFACES = ['wlan_bridge', 'wlan0', 'wlan1'];
const MAX_SUBSCRIPTIONS = 24, MAX_BODY = 65536, MAX_METADATA = 32768;
const PROTOCOLS = ['video/mp4', 'video/x-m4v', 'video/quicktime', 'video/x-matroska', 'video/webm', 'video/mpeg', 'video/mp2t',
    'video/MP2T', 'video/x-msvideo', 'video/avi', 'video/3gpp', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac',
    'audio/x-aac', 'audio/aacp', 'audio/flac', 'audio/x-flac', 'audio/wav', 'audio/x-wav', 'audio/L16', 'audio/ogg', 'audio/opus',
    'application/ogg', 'application/vnd.apple.mpegurl', 'application/x-mpegURL', 'image/jpeg', 'image/png']
    .map(type => 'http-get:*:' + type + ':*').join(',');

const xml = value => String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
function unxml(value) {
    return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(lt|gt|quot|apos|amp|#[0-9]{1,7}|#x[0-9a-f]{1,6});/gi, (all, name) => {
        const named = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[name.toLowerCase()];
        if (named) return named;
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}
function element(body, name) {
    const match = new RegExp('<(?:[A-Za-z0-9_]+:)?' + name + '(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?' + name + '\\s*>)').exec(body);
    return match ? unxml(match[1] || '') : undefined;
}
function clock(seconds) {
    if (!(seconds >= 0) || !isFinite(seconds)) return '0:00:00';
    const s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return h + ':' + ('0' + m).slice(-2) + ':' + ('0' + (s % 60)).slice(-2);
}
function parseClock(text) {
    const match = /^\s*(?:([0-9]{1,5}):)?([0-9]{1,2}):([0-9]{1,2}(?:\.[0-9]{1,6})?)\s*$/.exec(String(text || ''));
    if (!match) return null;
    return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
function ipv4(value) {
    if (typeof value !== 'string') return null;
    const address = value.replace(/^::ffff:/i, '');
    if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(address)) return null;
    const words = address.split('.').map(Number);
    return words.some(n => n > 255) ? null : { text: address, number: words.reduce((n, w) => ((n << 8) | w) >>> 0, 0) };
}
function privatePeer(value, loopback) {
    const a = ipv4(value);
    if (!a) return false;
    const [b0, b1] = a.text.split('.').map(Number);
    return b0 === 10 || (b0 === 172 && b1 >= 16 && b1 <= 31) || (b0 === 192 && b1 === 168) || (b0 === 169 && b1 === 254) || (!!loopback && b0 === 127);
}
function didl(metadata) {
    const text = typeof metadata === 'string' ? metadata : '';
    const field = name => { const v = element(text, name); return v ? Array.from(v.trim()).slice(0, 200).join('') : ''; };
    return { title: field('title'), artist: field('artist') || field('creator'), album: field('album'), kind: field('class') };
}

// Compact SCPD tables: [action, [[argument, direction, stateVariable]]].
const IN = 'in', OUT = 'out';
const SCPD = {
    AVTransport: {
        actions: [
            ['SetAVTransportURI', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['CurrentURI', IN, 'AVTransportURI'], ['CurrentURIMetaData', IN, 'AVTransportURIMetaData']]],
            ['SetNextAVTransportURI', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['NextURI', IN, 'NextAVTransportURI'], ['NextURIMetaData', IN, 'NextAVTransportURIMetaData']]],
            ['GetMediaInfo', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['NrTracks', OUT, 'NumberOfTracks'], ['MediaDuration', OUT, 'CurrentMediaDuration'],
                ['CurrentURI', OUT, 'AVTransportURI'], ['CurrentURIMetaData', OUT, 'AVTransportURIMetaData'], ['NextURI', OUT, 'NextAVTransportURI'],
                ['NextURIMetaData', OUT, 'NextAVTransportURIMetaData'], ['PlayMedium', OUT, 'PlaybackStorageMedium'], ['RecordMedium', OUT, 'RecordStorageMedium'],
                ['WriteStatus', OUT, 'RecordMediumWriteStatus']]],
            ['GetTransportInfo', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['CurrentTransportState', OUT, 'TransportState'],
                ['CurrentTransportStatus', OUT, 'TransportStatus'], ['CurrentSpeed', OUT, 'TransportPlaySpeed']]],
            ['GetPositionInfo', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['Track', OUT, 'CurrentTrack'], ['TrackDuration', OUT, 'CurrentTrackDuration'],
                ['TrackMetaData', OUT, 'CurrentTrackMetaData'], ['TrackURI', OUT, 'CurrentTrackURI'], ['RelTime', OUT, 'RelativeTimePosition'],
                ['AbsTime', OUT, 'AbsoluteTimePosition'], ['RelCount', OUT, 'RelativeCounterPosition'], ['AbsCount', OUT, 'AbsoluteCounterPosition']]],
            ['GetDeviceCapabilities', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['PlayMedia', OUT, 'PossiblePlaybackStorageMedia'],
                ['RecMedia', OUT, 'PossibleRecordStorageMedia'], ['RecQualityModes', OUT, 'PossibleRecordQualityModes']]],
            ['GetTransportSettings', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['PlayMode', OUT, 'CurrentPlayMode'], ['RecQualityMode', OUT, 'CurrentRecordQualityMode']]],
            ['GetCurrentTransportActions', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['Actions', OUT, 'CurrentTransportActions']]],
            ['Stop', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID']]],
            ['Play', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['Speed', IN, 'TransportPlaySpeed']]],
            ['Pause', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID']]],
            ['Seek', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['Unit', IN, 'A_ARG_TYPE_SeekMode'], ['Target', IN, 'A_ARG_TYPE_SeekTarget']]],
            ['Next', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID']]],
            ['Previous', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID']]],
            ['SetPlayMode', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['NewPlayMode', IN, 'CurrentPlayMode']]],
        ],
        variables: [
            ['TransportState', 'string', false, ['STOPPED', 'PLAYING', 'TRANSITIONING', 'PAUSED_PLAYBACK', 'NO_MEDIA_PRESENT']],
            ['TransportStatus', 'string', false, ['OK', 'ERROR_OCCURRED']], ['PlaybackStorageMedium', 'string', false, ['NETWORK', 'NONE']],
            ['RecordStorageMedium', 'string', false, ['NOT_IMPLEMENTED']], ['PossiblePlaybackStorageMedia', 'string', false],
            ['PossibleRecordStorageMedia', 'string', false], ['CurrentPlayMode', 'string', false, ['NORMAL']], ['TransportPlaySpeed', 'string', false, ['1']],
            ['RecordMediumWriteStatus', 'string', false, ['NOT_IMPLEMENTED']], ['CurrentRecordQualityMode', 'string', false, ['NOT_IMPLEMENTED']],
            ['PossibleRecordQualityModes', 'string', false], ['NumberOfTracks', 'ui4', false], ['CurrentTrack', 'ui4', false],
            ['CurrentTrackDuration', 'string', false], ['CurrentMediaDuration', 'string', false], ['CurrentTrackMetaData', 'string', false],
            ['CurrentTrackURI', 'string', false], ['AVTransportURI', 'string', false], ['AVTransportURIMetaData', 'string', false],
            ['NextAVTransportURI', 'string', false], ['NextAVTransportURIMetaData', 'string', false], ['RelativeTimePosition', 'string', false],
            ['AbsoluteTimePosition', 'string', false], ['RelativeCounterPosition', 'i4', false], ['AbsoluteCounterPosition', 'i4', false],
            ['CurrentTransportActions', 'string', false], ['LastChange', 'string', true], ['A_ARG_TYPE_SeekMode', 'string', false, ['REL_TIME', 'ABS_TIME', 'TRACK_NR']],
            ['A_ARG_TYPE_SeekTarget', 'string', false], ['A_ARG_TYPE_InstanceID', 'ui4', false],
        ],
    },
    RenderingControl: {
        actions: [
            ['ListPresets', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['CurrentPresetNameList', OUT, 'PresetNameList']]],
            ['SelectPreset', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['PresetName', IN, 'A_ARG_TYPE_PresetName']]],
            ['GetMute', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['Channel', IN, 'A_ARG_TYPE_Channel'], ['CurrentMute', OUT, 'Mute']]],
            ['SetMute', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['Channel', IN, 'A_ARG_TYPE_Channel'], ['DesiredMute', IN, 'Mute']]],
            ['GetVolume', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['Channel', IN, 'A_ARG_TYPE_Channel'], ['CurrentVolume', OUT, 'Volume']]],
            ['SetVolume', [['InstanceID', IN, 'A_ARG_TYPE_InstanceID'], ['Channel', IN, 'A_ARG_TYPE_Channel'], ['DesiredVolume', IN, 'Volume']]],
        ],
        variables: [
            ['PresetNameList', 'string', false], ['LastChange', 'string', true], ['Mute', 'boolean', false],
            ['Volume', 'ui2', false, null, [0, 100, 1]], ['A_ARG_TYPE_Channel', 'string', false, ['Master']],
            ['A_ARG_TYPE_InstanceID', 'ui4', false], ['A_ARG_TYPE_PresetName', 'string', false, ['FactoryDefaults']],
        ],
    },
    ConnectionManager: {
        actions: [
            ['GetProtocolInfo', [['Source', OUT, 'SourceProtocolInfo'], ['Sink', OUT, 'SinkProtocolInfo']]],
            ['GetCurrentConnectionIDs', [['ConnectionIDs', OUT, 'CurrentConnectionIDs']]],
            ['GetCurrentConnectionInfo', [['ConnectionID', IN, 'A_ARG_TYPE_ConnectionID'], ['RcsID', OUT, 'A_ARG_TYPE_RcsID'],
                ['AVTransportID', OUT, 'A_ARG_TYPE_AVTransportID'], ['ProtocolInfo', OUT, 'A_ARG_TYPE_ProtocolInfo'],
                ['PeerConnectionManager', OUT, 'A_ARG_TYPE_ConnectionManager'], ['PeerConnectionID', OUT, 'A_ARG_TYPE_ConnectionID'],
                ['Direction', OUT, 'A_ARG_TYPE_Direction'], ['Status', OUT, 'A_ARG_TYPE_ConnectionStatus']]],
        ],
        variables: [
            ['SourceProtocolInfo', 'string', true], ['SinkProtocolInfo', 'string', true], ['CurrentConnectionIDs', 'string', true],
            ['A_ARG_TYPE_ConnectionStatus', 'string', false, ['OK', 'ContentFormatMismatch', 'InsufficientBandwidth', 'UnreliableChannel', 'Unknown']],
            ['A_ARG_TYPE_ConnectionManager', 'string', false], ['A_ARG_TYPE_Direction', 'string', false, ['Input', 'Output']],
            ['A_ARG_TYPE_ProtocolInfo', 'string', false], ['A_ARG_TYPE_ConnectionID', 'i4', false],
            ['A_ARG_TYPE_AVTransportID', 'i4', false], ['A_ARG_TYPE_RcsID', 'i4', false],
        ],
    },
};
function scpd(name) {
    const spec = SCPD[name];
    const actions = spec.actions.map(a => '<action><name>' + a[0] + '</name>' + (a[1].length ? '<argumentList>' + a[1].map(arg =>
        '<argument><name>' + arg[0] + '</name><direction>' + arg[1] + '</direction><relatedStateVariable>' + arg[2] + '</relatedStateVariable></argument>').join('') + '</argumentList>' : '') + '</action>').join('');
    const variables = spec.variables.map(v => '<stateVariable sendEvents="' + (v[2] ? 'yes' : 'no') + '"><name>' + v[0] + '</name><dataType>' + v[1] + '</dataType>' +
        (v[3] ? '<allowedValueList>' + v[3].map(x => '<allowedValue>' + x + '</allowedValue>').join('') + '</allowedValueList>' : '') +
        (v[4] ? '<allowedValueRange><minimum>' + v[4][0] + '</minimum><maximum>' + v[4][1] + '</maximum><step>' + v[4][2] + '</step></allowedValueRange>' : '') + '</stateVariable>').join('');
    return '<?xml version="1.0" encoding="utf-8"?>\n<scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion>' +
        '<actionList>' + actions + '</actionList><serviceStateTable>' + variables + '</serviceStateTable></scpd>\n';
}
class SoapError extends Error { constructor(code, text) { super(text); this.code = code; } }

class DlnaRenderer extends EventEmitter {
    constructor(options) {
        super();
        this.options = options || {};
        this.player = this.options.player;
        this.name = this.options.name || 'BMW AirPlay by pllana.io';
        this.version = this.options.version || '0';
        this.port = this.options.port === undefined ? HTTP_PORT : this.options.port;
        this.ssdpPort = this.options.ssdpPort === undefined ? SSDP_PORT : this.options.ssdpPort;
        this.interfaces = this.options.interfaces || os.networkInterfaces;
        this.names = this.options.interfaceNames || INTERFACES;
        this.allowLoopback = !!this.options.allowLoopback;
        this.uuid = this.options.uuid || this.loadUuid();
        this.server = null; this.ssdp = null; this.notifyTimer = null; this.memberships = new Set(); this.running = false;
        this.subscriptions = new Map(); this.eventTimer = null;
        this.transport = { uri: '', metadata: '', nextUri: '', nextMetadata: '', state: 'NO_MEDIA_PRESENT', status: 'OK', want: false, start: 0, info: didl('') };
        this.volume = 100; this.muted = false; this.epoch = 0;
        if (this.player) {
            this.player.on('state', state => this.playerState(state));
            this.player.on('diagnostic', code => this.emit('diagnostic', code));
        }
    }
    loadUuid() {
        const dir = this.options.dataDir;
        const fallback = () => { const b = crypto.randomBytes(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; const h = b.toString('hex'); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20); };
        if (!dir) return fallback();
        const file = path.join(dir, 'dlna.json');
        try {
            const st = fs.lstatSync(file);
            if (st.isFile() && !st.isSymbolicLink() && st.size < 1024) {
                const value = JSON.parse(fs.readFileSync(file, 'utf8')).uuid;
                if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) return value;
            }
        } catch (e) { /* first start */ }
        const uuid = fallback();
        try { fs.writeFileSync(file, JSON.stringify({ uuid }), { mode: 0o600 }); } catch (e) { /* in-memory identity */ }
        return uuid;
    }
    // --- lifecycle ------------------------------------------------------
    start() {
        if (this.running) return Promise.resolve();
        this.running = true;
        const httpReady = new Promise(resolve => {
            this.server = http.createServer((req, res) => this.request(req, res));
            this.server.on('error', () => { this.emit('diagnostic', 'dlna_http_unavailable'); resolve(); });
            this.server.timeout = 15000;
            this.server.listen(this.port, this.options.host || '0.0.0.0', () => { if (!this.port) this.port = this.server.address().port; resolve(); });
        });
        const ssdpReady = new Promise(resolve => {
            const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            this.ssdp = socket;
            let bound = false;
            socket.on('message', (message, rinfo) => this.ssdpMessage(String(message), rinfo));
            socket.on('error', error => {
                if (!bound && this.ssdp === socket && this.ssdpPort) {
                    // Another stock service may hold UDP 1900 exclusively.
                    // Announce from an ephemeral port: Android controllers
                    // still learn the renderer from these NOTIFY messages.
                    this.emit('diagnostic', 'dlna_ssdp_port_busy');
                    try { socket.close(); } catch (e) {}
                    const fallback = dgram.createSocket({ type: 'udp4', reuseAddr: true });
                    this.ssdp = fallback;
                    fallback.on('error', () => this.emit('diagnostic', 'dlna_ssdp_failed'));
                    fallback.on('message', (message, rinfo) => this.ssdpMessage(String(message), rinfo));
                    fallback.bind(0, () => { bound = true; this.ssdpSetup(); resolve(); });
                    return;
                }
                this.emit('diagnostic', 'dlna_ssdp_failed');
            });
            socket.bind(this.ssdpPort, () => { bound = true; this.ssdpSetup(); resolve(); });
        });
        return Promise.all([httpReady, ssdpReady]).then(() => {
            if (!this.running) return;
            this.announce('ssdp:alive');
            setTimeout(() => { if (this.running) this.announce('ssdp:alive'); }, 1500);
            this.notifyTimer = setInterval(() => { this.refreshMemberships(); this.announce('ssdp:alive'); }, 30000);
            if (this.notifyTimer.unref) this.notifyTimer.unref();
        });
    }
    ssdpSetup() {
        try { this.ssdp.setMulticastTTL(2); } catch (e) {}
        try { this.ssdp.setMulticastLoopback(!!this.options.multicastLoopback); } catch (e) {}
        this.refreshMemberships();
    }
    localAddresses() {
        let all;
        try { all = this.interfaces(); } catch (e) { return []; }
        const result = [];
        for (const name of this.names) for (const a of all[name] || []) {
            if ((a.family !== 'IPv4' && a.family !== 4) || !privatePeer(a.address, this.allowLoopback)) continue;
            const mask = ipv4(a.netmask);
            result.push({ name, address: a.address, number: ipv4(a.address).number, mask: mask ? mask.number : 0xffffff00 });
        }
        return result;
    }
    refreshMemberships() {
        if (!this.ssdp || !this.ssdpPort) return;
        const now = new Set(this.localAddresses().map(a => a.address));
        for (const address of now) if (!this.memberships.has(address)) {
            try { this.ssdp.addMembership(SSDP_ADDRESS, address); this.memberships.add(address); } catch (e) { /* interface not ready */ }
        }
        for (const address of Array.from(this.memberships)) if (!now.has(address)) {
            try { this.ssdp.dropMembership(SSDP_ADDRESS, address); } catch (e) {}
            this.memberships.delete(address);
        }
    }
    stop() {
        if (!this.running) return Promise.resolve();
        this.running = false;
        clearInterval(this.notifyTimer); this.notifyTimer = null; clearTimeout(this.eventTimer); this.eventTimer = null;
        try { this.announce('ssdp:byebye'); } catch (e) {}
        const socket = this.ssdp, server = this.server;
        this.ssdp = null; this.server = null; this.memberships.clear(); this.subscriptions.clear();
        this.transport = { uri: '', metadata: '', nextUri: '', nextMetadata: '', state: 'NO_MEDIA_PRESENT', status: 'OK', want: false, start: 0, info: didl('') };
        if (this.player) this.player.stop();
        this.publish();
        return new Promise(resolve => {
            // Let the byebye datagrams leave before the socket closes.
            setTimeout(() => { try { socket && socket.close(); } catch (e) {} resolve(); }, 50);
            if (server) server.close();
        });
    }
    // --- SSDP -----------------------------------------------------------
    targets() {
        return [['upnp:rootdevice', 'uuid:' + this.uuid + '::upnp:rootdevice'], ['uuid:' + this.uuid, 'uuid:' + this.uuid],
            [DEVICE, 'uuid:' + this.uuid + '::' + DEVICE]].concat(Object.keys(SERVICES).map(k => [SERVICES[k], 'uuid:' + this.uuid + '::' + SERVICES[k]]));
    }
    location(address) { return 'http://' + address + ':' + this.port + '/dlna/description.xml'; }
    server_header() { return 'Linux/4.14 UPnP/1.0 pllana-airplay/' + this.version; }
    announce(nts) {
        if (!this.ssdp) return;
        for (const local of this.localAddresses()) {
            try { this.ssdp.setMulticastInterface(local.address); } catch (e) { continue; }
            for (const target of this.targets()) {
                const lines = ['NOTIFY * HTTP/1.1', 'HOST: ' + SSDP_ADDRESS + ':' + SSDP_PORT, 'NT: ' + target[0], 'NTS: ' + nts, 'USN: ' + target[1]];
                if (nts === 'ssdp:alive') lines.push('CACHE-CONTROL: max-age=1800', 'LOCATION: ' + this.location(local.address), 'SERVER: ' + this.server_header());
                const message = Buffer.from(lines.join('\r\n') + '\r\n\r\n');
                this.ssdp.send(message, 0, message.length, SSDP_PORT, SSDP_ADDRESS, () => {});
            }
        }
    }
    ssdpMessage(text, rinfo) {
        if (!this.running || !rinfo || text.length > 4096 || !/^M-SEARCH \* HTTP\/1\.1\r?\n/i.test(text)) return;
        if (!privatePeer(rinfo.address, this.allowLoopback) || !Number.isInteger(rinfo.port) || rinfo.port < 1 || rinfo.port > 65535) return;
        const headers = {};
        for (const line of text.split(/\r?\n/).slice(1)) { const at = line.indexOf(':'); if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim(); }
        if (!/^"?ssdp:discover"?$/i.test(headers.man || '')) return;
        const st = headers.st || '';
        const peer = ipv4(rinfo.address).number;
        const local = this.localAddresses().find(a => ((a.number & a.mask) >>> 0) === ((peer & a.mask) >>> 0)) ||
            (this.allowLoopback && /^127\./.test(rinfo.address) ? { address: rinfo.address } : null);
        if (!local) return;
        const matches = st === 'ssdp:all' ? this.targets() : this.targets().filter(t => t[0].toLowerCase() === st.toLowerCase());
        if (!matches.length) return;
        const delay = Math.min(Math.max(Number(headers.mx) || 1, 1), 3) * 100 * Math.random();
        setTimeout(() => {
            if (!this.running || !this.ssdp) return;
            for (const target of matches) {
                const message = Buffer.from(['HTTP/1.1 200 OK', 'CACHE-CONTROL: max-age=1800', 'DATE: ' + new Date().toUTCString(), 'EXT:',
                    'LOCATION: ' + this.location(local.address), 'SERVER: ' + this.server_header(), 'ST: ' + target[0], 'USN: ' + target[1],
                    'BOOTID.UPNP.ORG: 1', 'CONFIGID.UPNP.ORG: 1'].join('\r\n') + '\r\n\r\n');
                this.ssdp.send(message, 0, message.length, rinfo.port, rinfo.address, () => {});
            }
        }, delay);
    }
    // --- HTTP -----------------------------------------------------------
    description() {
        const services = Object.keys(SERVICES).map(k => '<service><serviceType>' + SERVICES[k] + '</serviceType><serviceId>urn:upnp-org:serviceId:' + k + '</serviceId>' +
            '<SCPDURL>/dlna/' + k + '.xml</SCPDURL><controlURL>/dlna/' + k + '/control</controlURL><eventSubURL>/dlna/' + k + '/event</eventSubURL></service>').join('');
        return '<?xml version="1.0" encoding="utf-8"?>\n<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0">' +
            '<specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>' + DEVICE + '</deviceType>' +
            '<friendlyName>' + xml(this.name) + '</friendlyName><manufacturer>Leon Pllana IT-Solutions</manufacturer><manufacturerURL>https://pllana.io</manufacturerURL>' +
            '<modelDescription>BMW Media Renderer</modelDescription><modelName>' + xml(this.name) + '</modelName><modelNumber>' + xml(this.version) + '</modelNumber>' +
            '<modelURL>https://pllana.io</modelURL><UDN>uuid:' + this.uuid + '</UDN><dlna:X_DLNADOC>DMR-1.50</dlna:X_DLNADOC>' +
            '<iconList><icon><mimetype>image/png</mimetype><width>140</width><height>140</height><depth>24</depth><url>/dlna/icon.png</url></icon></iconList>' +
            '<serviceList>' + services + '</serviceList></device></root>\n';
    }
    request(req, res) {
        const peer = req.socket && req.socket.remoteAddress;
        if (!privatePeer(peer, this.allowLoopback)) { req.socket.destroy(); return; }
        res.setHeader('Server', this.server_header());
        res.setHeader('Connection', 'close');
        const url = String(req.url || '').split('?')[0];
        const send = (status, type, body, headers) => {
            const data = Buffer.from(body || '');
            res.writeHead(status, Object.assign(type ? { 'Content-Type': type } : {}, { 'Content-Length': data.length }, headers || {}));
            res.end(req.method === 'HEAD' ? undefined : data);
        };
        if ((req.method === 'GET' || req.method === 'HEAD') && url === '/dlna/description.xml') return send(200, 'text/xml; charset="utf-8"', this.description());
        const scpdMatch = /^\/dlna\/(AVTransport|RenderingControl|ConnectionManager)\.xml$/.exec(url);
        if ((req.method === 'GET' || req.method === 'HEAD') && scpdMatch) return send(200, 'text/xml; charset="utf-8"', scpd(scpdMatch[1]));
        if ((req.method === 'GET' || req.method === 'HEAD') && url === '/dlna/icon.png') {
            let icon = Buffer.alloc(0);
            try { icon = fs.readFileSync(path.join(__dirname, 'icon.png')); } catch (e) { return send(404); }
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': icon.length });
            return res.end(req.method === 'HEAD' ? undefined : icon);
        }
        const control = /^\/dlna\/(AVTransport|RenderingControl|ConnectionManager)\/control$/.exec(url);
        if (control && req.method === 'POST') return this.readBody(req, res, body => this.soap(control[1], req, body, send));
        const events = /^\/dlna\/(AVTransport|RenderingControl|ConnectionManager)\/event$/.exec(url);
        if (events && (req.method === 'SUBSCRIBE' || req.method === 'UNSUBSCRIBE')) return this.readBody(req, res, () => this.gena(events[1], req, send));
        send(404, 'text/plain', 'not found');
    }
    readBody(req, res, done) {
        const parts = []; let size = 0, failed = false;
        req.on('data', chunk => {
            if (failed) return;
            size += chunk.length;
            if (size > MAX_BODY) { failed = true; res.writeHead(413, { 'Content-Length': 0 }); res.end(); req.socket.destroy(); return; }
            parts.push(chunk);
        });
        req.on('end', () => { if (!failed) done(Buffer.concat(parts).toString('utf8')); });
        req.on('error', () => {});
    }
    soap(service, req, body, send) {
        const header = String(req.headers.soapaction || '').replace(/"/g, '').trim();
        const at = header.lastIndexOf('#');
        const type = at > 0 ? header.slice(0, at) : SERVICES[service], action = at > 0 ? header.slice(at + 1) : '';
        const spec = SCPD[service].actions.find(a => a[0] === action);
        const fault = (code, text) => send(500, 'text/xml; charset="utf-8"', '<?xml version="1.0" encoding="utf-8"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><s:Fault>' +
            '<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>' + code + '</errorCode>' +
            '<errorDescription>' + xml(text) + '</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>\n');
        if (type !== SERVICES[service] || !spec) return fault(401, 'Invalid Action');
        const args = {};
        for (const arg of spec[1]) if (arg[1] === IN) args[arg[0]] = element(body, arg[0]);
        let result;
        try { result = this.action(service, action, args, req.socket.remoteAddress) || {}; }
        catch (e) { return fault(e.code || 501, e.message || 'Action Failed'); }
        const out = spec[1].filter(a => a[1] === OUT).map(a => '<' + a[0] + '>' + xml(result[a[0]]) + '</' + a[0] + '>').join('');
        send(200, 'text/xml; charset="utf-8"', '<?xml version="1.0" encoding="utf-8"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
            '<u:' + action + 'Response xmlns:u="' + SERVICES[service] + '">' + out + '</u:' + action + 'Response></s:Body></s:Envelope>\n', { EXT: '' });
    }
    // --- transport ------------------------------------------------------
    actions() {
        const t = this.transport;
        if (!t.uri) return '';
        if (t.state === 'PLAYING') return 'Pause,Stop,Seek' + (t.nextUri ? ',Next' : '');
        if (t.state === 'PAUSED_PLAYBACK') return 'Play,Stop,Seek' + (t.nextUri ? ',Next' : '');
        if (t.state === 'TRANSITIONING') return 'Stop';
        return 'Play' + (t.nextUri ? ',Next' : '');
    }
    action(service, action, args) {
        const t = this.transport, p = this.player ? this.player.state : { position: 0, duration: -1 };
        if (service === 'ConnectionManager') {
            if (action === 'GetProtocolInfo') return { Source: '', Sink: PROTOCOLS };
            if (action === 'GetCurrentConnectionIDs') return { ConnectionIDs: '0' };
            if (action === 'GetCurrentConnectionInfo') {
                if (String(args.ConnectionID || '0') !== '0') throw new SoapError(706, 'Invalid connection reference');
                return { RcsID: 0, AVTransportID: 0, ProtocolInfo: '', PeerConnectionManager: '', PeerConnectionID: -1, Direction: 'Input', Status: 'OK' };
            }
        }
        if (String(args.InstanceID === undefined ? '0' : args.InstanceID).trim() !== '0') throw new SoapError(718, 'Invalid InstanceID');
        if (service === 'RenderingControl') {
            if (action === 'ListPresets') return { CurrentPresetNameList: 'FactoryDefaults' };
            if (action === 'SelectPreset') { if (args.PresetName !== 'FactoryDefaults') throw new SoapError(701, 'Invalid Name'); this.setVolume(100); this.setMute(false); return {}; }
            if (action === 'GetVolume') return { CurrentVolume: this.volume };
            if (action === 'GetMute') return { CurrentMute: this.muted ? 1 : 0 };
            if (action === 'SetVolume') {
                const value = Number(args.DesiredVolume);
                if (!Number.isInteger(value) || value < 0 || value > 100) throw new SoapError(402, 'Invalid Args');
                this.setVolume(value); return {};
            }
            if (action === 'SetMute') { this.setMute(/^(1|true|yes)$/i.test(String(args.DesiredMute || '').trim())); return {}; }
        }
        if (action === 'SetAVTransportURI') {
            const uri = String(args.CurrentURI || '').trim(), metadata = String(args.CurrentURIMetaData || '').slice(0, MAX_METADATA);
            if (!uri) { this.stopPlayback(true); return {}; }
            if (!validUri(uri)) throw new SoapError(714, 'Illegal MIME-type');
            const playing = t.want;
            Object.assign(t, { uri, metadata, start: 0, info: didl(metadata), status: 'OK' });
            this.epoch++;
            if (playing) this.load(true);
            else { if (this.player) this.player.stop(); t.state = 'STOPPED'; }
            this.changed(); return {};
        }
        if (action === 'SetNextAVTransportURI') {
            const uri = String(args.NextURI || '').trim();
            if (uri && !validUri(uri)) throw new SoapError(714, 'Illegal MIME-type');
            t.nextUri = uri; t.nextMetadata = uri ? String(args.NextURIMetaData || '').slice(0, MAX_METADATA) : '';
            this.changed(); return {};
        }
        if (action === 'Play') {
            if (!t.uri) throw new SoapError(701, 'Transition not available');
            if (this.player && this.player.child && (this.player.state.state === 'paused' || this.player.state.state === 'playing' ||
                this.player.state.state === 'buffering' || this.player.state.state === 'loading')) { t.want = true; this.player.play(); }
            else this.load(true);
            this.changed(); return {};
        }
        if (action === 'Pause') {
            if (!t.uri || t.state === 'STOPPED' || t.state === 'NO_MEDIA_PRESENT') throw new SoapError(701, 'Transition not available');
            t.want = false; if (this.player) this.player.pause();
            t.state = 'PAUSED_PLAYBACK'; this.changed(); return {};
        }
        if (action === 'Stop') { this.stopPlayback(false); return {}; }
        if (action === 'Seek') {
            const unit = String(args.Unit || '').trim().toUpperCase();
            if (unit === 'TRACK_NR') { if (String(args.Target).trim() === '1') { this.seek(0); return {}; } throw new SoapError(711, 'Illegal seek target'); }
            if (unit !== 'REL_TIME' && unit !== 'ABS_TIME') throw new SoapError(710, 'Seek mode not supported');
            const seconds = parseClock(args.Target);
            if (seconds === null || (p.duration > 0 && seconds > p.duration + 1)) throw new SoapError(711, 'Illegal seek target');
            this.seek(seconds); return {};
        }
        if (action === 'Next') { if (!t.nextUri) throw new SoapError(711, 'Illegal seek target'); this.advance(); return {}; }
        if (action === 'Previous') { if (!t.uri) throw new SoapError(711, 'Illegal seek target'); this.seek(0); return {}; }
        if (action === 'SetPlayMode') { if (String(args.NewPlayMode || '').trim() !== 'NORMAL') throw new SoapError(712, 'Play mode not supported'); return {}; }
        if (action === 'GetTransportInfo') return { CurrentTransportState: t.state, CurrentTransportStatus: t.status, CurrentSpeed: '1' };
        if (action === 'GetPositionInfo') {
            const active = t.state !== 'STOPPED' && t.state !== 'NO_MEDIA_PRESENT';
            return { Track: t.uri ? 1 : 0, TrackDuration: clock(p.duration), TrackMetaData: t.metadata || 'NOT_IMPLEMENTED', TrackURI: t.uri,
                RelTime: clock(active ? p.position : 0), AbsTime: clock(active ? p.position : 0), RelCount: 2147483647, AbsCount: 2147483647 };
        }
        if (action === 'GetMediaInfo') return { NrTracks: t.uri ? 1 : 0, MediaDuration: clock(p.duration), CurrentURI: t.uri, CurrentURIMetaData: t.metadata,
            NextURI: t.nextUri, NextURIMetaData: t.nextMetadata, PlayMedium: t.uri ? 'NETWORK' : 'NONE', RecordMedium: 'NOT_IMPLEMENTED', WriteStatus: 'NOT_IMPLEMENTED' };
        if (action === 'GetDeviceCapabilities') return { PlayMedia: 'NETWORK', RecMedia: 'NOT_IMPLEMENTED', RecQualityModes: 'NOT_IMPLEMENTED' };
        if (action === 'GetTransportSettings') return { PlayMode: 'NORMAL', RecQualityMode: 'NOT_IMPLEMENTED' };
        if (action === 'GetCurrentTransportActions') return { Actions: this.actions() };
        throw new SoapError(401, 'Invalid Action');
    }
    isImage() { return /imageItem/i.test(this.transport.info.kind) || /\.(jpe?g|png)(\?|$)/i.test(this.transport.uri); }
    load(play) {
        const t = this.transport;
        if (!this.player || !t.uri) return;
        t.want = !!play; t.state = 'TRANSITIONING'; t.status = 'OK';
        if (!this.player.load(t.uri, t.start)) { t.state = 'STOPPED'; t.status = 'ERROR_OCCURRED'; t.want = false; return; }
        t.start = 0;
        if (play) this.player.play();
    }
    seek(seconds) {
        const t = this.transport;
        if (!t.uri) throw new SoapError(711, 'Illegal seek target');
        if (this.player && this.player.child && this.player.state.state !== 'stopped') this.player.seek(seconds);
        else t.start = seconds;
    }
    advance() {
        const t = this.transport;
        Object.assign(t, { uri: t.nextUri, metadata: t.nextMetadata, nextUri: '', nextMetadata: '', start: 0, info: didl(t.nextMetadata) });
        this.epoch++;
        this.load(true); this.changed();
    }
    stopPlayback(clear) {
        const t = this.transport;
        t.want = false;
        if (this.player) this.player.stop();
        if (clear) Object.assign(t, { uri: '', metadata: '', nextUri: '', nextMetadata: '', info: didl('') });
        t.state = t.uri ? 'STOPPED' : 'NO_MEDIA_PRESENT'; t.status = 'OK';
        this.changed();
    }
    togglePause() {
        const t = this.transport;
        if (t.state === 'PLAYING' || t.state === 'TRANSITIONING') { t.want = false; if (this.player) this.player.pause(); t.state = 'PAUSED_PLAYBACK'; }
        else if (t.uri) { if (this.player && this.player.child && this.player.state.state === 'paused') { t.want = true; this.player.play(); } else this.load(true); }
        this.changed();
    }
    setVolume(value) { this.volume = value; if (this.player) this.player.volume(value); this.changed('rcs'); }
    setMute(on) { this.muted = !!on; if (this.player) this.player.mute(this.muted); this.changed('rcs'); }
    playerState(state) {
        const t = this.transport;
        if (!t.uri) { this.publish(); return; }
        const before = t.state;
        if (state.state === 'playing') { t.state = 'PLAYING'; t.want = true; }
        else if (state.state === 'paused') t.state = t.want ? 'TRANSITIONING' : 'PAUSED_PLAYBACK';
        else if (state.state === 'loading' || state.state === 'buffering') t.state = 'TRANSITIONING';
        else if (state.state === 'ended') {
            if (t.nextUri) { this.advance(); return; }
            // A photo stays on screen until the phone stops or sends the next one.
            if (this.isImage()) t.state = 'PLAYING';
            else { t.want = false; t.state = 'STOPPED'; }
        } else if (state.state === 'stopped') {
            if (state.error) { t.status = 'ERROR_OCCURRED'; this.emit('diagnostic', 'dlna_' + state.error); }
            if (t.state !== 'NO_MEDIA_PRESENT') t.state = 'STOPPED';
            t.want = false;
        }
        if (before !== t.state) this.changed(); else this.publish();
    }
    // --- presentation to the backend ------------------------------------
    presentation() {
        const t = this.transport, p = this.player ? this.player.state : {};
        const active = this.running && !!t.uri && (t.state === 'PLAYING' || t.state === 'PAUSED_PLAYBACK' || t.state === 'TRANSITIONING');
        if (!active) return null;
        return { transport: t.state, media: p.media || null, frame: p.frame || null, file: p.file || '', error: p.error || null,
            title: t.info.title, artist: t.info.artist, album: t.info.album, epoch: 'dlna-' + this.epoch, next: !!t.nextUri,
            position: p.position || 0, duration: p.duration };
    }
    publish() { this.emit('state', this.presentation()); }
    changed(which) {
        this.publish();
        if (!this.subscriptions.size) return;
        this.pendingEvents = Object.assign(this.pendingEvents || {}, which === 'rcs' ? { RenderingControl: true } : { AVTransport: true });
        if (this.eventTimer) return;
        this.eventTimer = setTimeout(() => {
            this.eventTimer = null;
            const pending = this.pendingEvents || {}; this.pendingEvents = {};
            for (const entry of this.subscriptions.values()) if (pending[entry.service]) this.notify(entry);
        }, 150);
    }
    // --- GENA eventing --------------------------------------------------
    lastChange(service) {
        const t = this.transport, p = this.player ? this.player.state : { duration: -1 };
        if (service === 'RenderingControl') return '<Event xmlns="urn:schemas-upnp-org:metadata-1-0/RCS/"><InstanceID val="0">' +
            '<Volume channel="Master" val="' + this.volume + '"/><Mute channel="Master" val="' + (this.muted ? 1 : 0) + '"/>' +
            '<PresetNameList val="FactoryDefaults"/></InstanceID></Event>';
        const v = (name, value) => '<' + name + ' val="' + xml(value) + '"/>';
        return '<Event xmlns="urn:schemas-upnp-org:metadata-1-0/AVT/"><InstanceID val="0">' + v('TransportState', t.state) + v('TransportStatus', t.status) +
            v('PlaybackStorageMedium', t.uri ? 'NETWORK' : 'NONE') + v('CurrentPlayMode', 'NORMAL') + v('TransportPlaySpeed', '1') +
            v('NumberOfTracks', t.uri ? 1 : 0) + v('CurrentTrack', t.uri ? 1 : 0) + v('CurrentTrackDuration', clock(p.duration)) +
            v('CurrentMediaDuration', clock(p.duration)) + v('AVTransportURI', t.uri) + v('CurrentTrackURI', t.uri) +
            v('AVTransportURIMetaData', t.metadata) + v('CurrentTrackMetaData', t.metadata) + v('NextAVTransportURI', t.nextUri) +
            v('NextAVTransportURIMetaData', t.nextMetadata) + v('CurrentTransportActions', this.actions()) + '</InstanceID></Event>';
    }
    properties(service) {
        if (service === 'ConnectionManager') return [['SourceProtocolInfo', ''], ['SinkProtocolInfo', PROTOCOLS], ['CurrentConnectionIDs', '0']];
        return [['LastChange', this.lastChange(service)]];
    }
    notify(entry) {
        if (Date.now() > entry.expires) { this.subscriptions.delete(entry.sid); return; }
        const body = Buffer.from('<?xml version="1.0" encoding="utf-8"?>\n<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">' +
            this.properties(entry.service).map(p => '<e:property><' + p[0] + '>' + xml(p[1]) + '</' + p[0] + '></e:property>').join('') + '</e:propertyset>\n');
        const seq = entry.seq; entry.seq = entry.seq >= 4294967295 ? 1 : entry.seq + 1;
        const request = http.request({ host: entry.host, port: entry.port, path: entry.path, method: 'NOTIFY', timeout: 3000, agent: false, headers: {
            HOST: entry.host + ':' + entry.port, 'CONTENT-TYPE': 'text/xml; charset="utf-8"', 'CONTENT-LENGTH': body.length,
            NT: 'upnp:event', NTS: 'upnp:propchange', SID: entry.sid, SEQ: seq, CONNECTION: 'close' } }, res => { res.resume(); });
        request.on('timeout', () => request.destroy());
        request.on('error', () => { entry.failures = (entry.failures || 0) + 1; if (entry.failures >= 3) this.subscriptions.delete(entry.sid); });
        request.end(body);
    }
    gena(service, req, send) {
        const timeout = /^Second-([0-9]{1,6})$/i.exec(String(req.headers.timeout || '').trim());
        const seconds = Math.min(Math.max(timeout ? Number(timeout[1]) : 1800, 60), 3600);
        if (req.method === 'UNSUBSCRIBE') {
            const sid = String(req.headers.sid || '').trim();
            const entry = this.subscriptions.get(sid);
            if (!entry || entry.service !== service) return send(412);
            this.subscriptions.delete(sid); return send(200);
        }
        if (req.headers.sid) {
            const entry = this.subscriptions.get(String(req.headers.sid).trim());
            if (!entry || entry.service !== service || req.headers.callback || req.headers.nt) return send(412);
            entry.expires = Date.now() + seconds * 1000;
            return send(200, null, '', { SID: entry.sid, TIMEOUT: 'Second-' + seconds });
        }
        if (String(req.headers.nt || '').trim() !== 'upnp:event') return send(412);
        const peer = ipv4(req.socket.remoteAddress);
        const callback = /<(http:\/\/[^>\s]{1,512})>/.exec(String(req.headers.callback || ''));
        let target = null;
        if (callback) try { target = new (require('url').URL)(callback[1]); } catch (e) { target = null; }
        // Events go only back to the subscribing phone itself.
        const port = target ? Number(target.port || 80) : 0;
        if (!peer || !target || target.hostname !== peer.text || port < 1024 || port > 65535) return send(412);
        for (const [sid, entry] of this.subscriptions) if (Date.now() > entry.expires) this.subscriptions.delete(sid);
        if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) {
            const oldest = Array.from(this.subscriptions.values()).sort((a, b) => a.created - b.created)[0];
            this.subscriptions.delete(oldest.sid);
        }
        const hex = crypto.randomBytes(16).toString('hex');
        const sid = 'uuid:' + hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
        const entry = { sid, service, host: peer.text, port, path: (target.pathname || '/') + (target.search || ''), seq: 0, expires: Date.now() + seconds * 1000, created: Date.now() };
        this.subscriptions.set(sid, entry);
        send(200, null, '', { SID: sid, TIMEOUT: 'Second-' + seconds });
        // The initial event follows the subscription response.
        setTimeout(() => { if (this.subscriptions.get(sid) === entry) this.notify(entry); }, 100);
    }
}
module.exports = { DlnaRenderer, clock, parseClock, privatePeer, scpd, didl, HTTP_PORT, SSDP_PORT, PROTOCOLS };
