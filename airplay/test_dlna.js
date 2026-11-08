'use strict';
// DLNA/UPnP MediaRenderer over real HTTP on loopback with a fake native player.
const assert = require('assert'), http = require('http'), EventEmitter = require('events'), fs = require('fs'), os = require('os'), path = require('path');
const { DlnaRenderer, clock, parseClock, privatePeer, scpd, didl } = require('../apps/pllana_airplay/dlna_renderer');

class FakePlayer extends EventEmitter {
    constructor() { super(); this.commands = []; this.child = null; this.state = { state: 'stopped', media: null, position: 0, duration: -1, frame: null, file: '', error: null }; }
    update(fields) { Object.assign(this.state, fields); this.emit('state', Object.assign({}, this.state)); }
    load(uri, start) { this.child = {}; this.commands.push(['load', uri, start]); this.update({ state: 'loading', media: null }); return true; }
    play() { this.commands.push(['play']); }
    pause() { this.commands.push(['pause']); if (this.child) this.update({ state: 'paused' }); }
    seek(s) { this.commands.push(['seek', s]); }
    volume(v) { this.commands.push(['volume', v]); }
    mute(m) { this.commands.push(['mute', m]); }
    stop() { this.commands.push(['stop']); this.update({ state: 'stopped', media: null, frame: null }); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
function request(port, method, url, body, headers) {
    return new Promise((resolve, reject) => {
        const data = body ? Buffer.from(body) : null;
        const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: Object.assign(data ? { 'Content-Length': data.length } : {}, headers || {}) }, res => {
            const parts = []; res.on('data', c => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
        });
        req.on('error', reject); req.end(data);
    });
}
function soap(port, service, action, args) {
    const type = 'urn:schemas-upnp-org:service:' + service + ':1';
    const body = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:' + action + ' xmlns:u="' + type + '">' +
        Object.keys(args || {}).map(k => '<' + k + '>' + args[k] + '</' + k + '>').join('') + '</u:' + action + '></s:Body></s:Envelope>';
    return request(port, 'POST', '/dlna/' + service + '/control', body, { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: '"' + type + '#' + action + '"' });
}
const value = (body, name) => { const m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(body); return m ? m[1] : null; };

(async () => {
    assert.strictEqual(clock(3725.6), '1:02:05'); assert.strictEqual(clock(-1), '0:00:00');
    assert.strictEqual(parseClock('0:01:30'), 90); assert.strictEqual(parseClock('01:02:03.500'), 3723.5); assert.strictEqual(parseClock('12:34'), 754);
    assert.strictEqual(parseClock('abc'), null);
    assert(privatePeer('192.168.43.20') && privatePeer('::ffff:10.0.0.4') && privatePeer('172.20.1.1') && !privatePeer('8.8.8.8') && !privatePeer('127.0.0.1'));
    assert(privatePeer('127.0.0.1', true));
    assert(/<name>SetAVTransportURI<\/name>/.test(scpd('AVTransport')) && /<name>LastChange<\/name>/.test(scpd('RenderingControl')));
    const meta = didl('<DIDL-Lite><item><dc:title>Urlaub &amp; Meer</dc:title><upnp:artist>A</upnp:artist></item></DIDL-Lite>');
    assert.strictEqual(meta.artist, 'A');
    assert.strictEqual(meta.title, 'Urlaub & Meer');

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlna-test-'));
    const player = new FakePlayer();
    const sent = [];
    const renderer = new DlnaRenderer({ player, dataDir, port: 0, ssdpPort: 0, allowLoopback: true, host: '127.0.0.1', version: '9.9.9',
        interfaces: () => ({ wlan0: [{ family: 'IPv4', address: '192.168.43.1', netmask: '255.255.255.0', internal: false }], eth9: [{ family: 'IPv4', address: '10.9.9.9', netmask: '255.0.0.0' }] }) });
    const states = [];
    renderer.on('state', s => states.push(s));
    await renderer.start();
    // Capture SSDP traffic instead of touching the network.
    renderer.ssdp.send = (message, offset, length, port, address) => sent.push({ text: message.toString(), port, address });
    renderer.ssdp.setMulticastInterface = () => {};
    const port = renderer.port;
    assert.strictEqual(renderer.uuid, new DlnaRenderer({ dataDir, port: 0 }).uuid, 'the renderer identity is persistent');

    // Discovery: alive announcements only on the WLAN interfaces.
    renderer.announce('ssdp:alive');
    assert(sent.length >= 6 && sent.every(m => m.address === '239.255.255.250' && m.port === 1900));
    assert(sent.some(m => /NT: urn:schemas-upnp-org:device:MediaRenderer:1/.test(m.text) && /LOCATION: http:\/\/192\.168\.43\.1:\d+\/dlna\/description\.xml/.test(m.text)));
    assert(!sent.some(m => /10\.9\.9\.9/.test(m.text)), 'no announcement on other interfaces');
    sent.length = 0;
    renderer.ssdpMessage('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n', { address: '192.168.43.20', port: 50000 });
    renderer.ssdpMessage('M-SEARCH * HTTP/1.1\r\nMAN: "ssdp:discover"\r\nST: ssdp:all\r\n\r\n', { address: '8.8.8.8', port: 50000 });
    renderer.ssdpMessage('M-SEARCH * HTTP/1.1\r\nMAN: "ssdp:discover"\r\nST: urn:other:device\r\n\r\n', { address: '192.168.43.20', port: 50001 });
    await wait(350);
    assert.strictEqual(sent.length, 1, 'one answer to the matching search, none to public or foreign searches');
    assert(/^HTTP\/1\.1 200 OK/.test(sent[0].text) && sent[0].address === '192.168.43.20' && sent[0].port === 50000);
    assert(/USN: uuid:[0-9a-f-]+::urn:schemas-upnp-org:device:MediaRenderer:1/.test(sent[0].text));
    assert(/LOCATION: http:\/\/192\.168\.43\.1:/.test(sent[0].text), 'the answer names the address in the phone subnet');

    // Description and service descriptions.
    const description = await request(port, 'GET', '/dlna/description.xml');
    assert.strictEqual(description.status, 200);
    assert(/<friendlyName>PllanaCast for BMW<\/friendlyName>/.test(description.body) && /MediaRenderer:1/.test(description.body));
    assert(/<modelNumber>9\.9\.9<\/modelNumber>/.test(description.body));
    for (const service of ['AVTransport', 'RenderingControl', 'ConnectionManager'])
        assert.strictEqual((await request(port, 'GET', '/dlna/' + service + '.xml')).status, 200);
    assert.strictEqual((await request(port, 'GET', '/dlna/icon.png')).headers['content-type'], 'image/png');
    assert.strictEqual((await request(port, 'GET', '/etc/passwd')).status, 404);

    const protocols = await soap(port, 'ConnectionManager', 'GetProtocolInfo');
    assert(/http-get:\*:video\/mp4:\*/.test(value(protocols.body, 'Sink')) && /audio\/mpeg/.test(value(protocols.body, 'Sink')));

    // Event subscription back to the phone (here: loopback).
    const notifications = [];
    const phone = http.createServer((req, res) => { const parts = []; req.on('data', c => parts.push(c)); req.on('end', () => { notifications.push({ headers: req.headers, body: Buffer.concat(parts).toString() }); res.end(); }); });
    await new Promise(r => phone.listen(0, '127.0.0.1', r));
    const subscribed = await request(port, 'SUBSCRIBE', '/dlna/AVTransport/event', null, { CALLBACK: '<http://127.0.0.1:' + phone.address().port + '/events>', NT: 'upnp:event', TIMEOUT: 'Second-300' });
    assert.strictEqual(subscribed.status, 200); assert(/^uuid:/.test(subscribed.headers.sid)); assert.strictEqual(subscribed.headers.timeout, 'Second-300');
    const foreign = await request(port, 'SUBSCRIBE', '/dlna/AVTransport/event', null, { CALLBACK: '<http://10.1.2.3:8080/events>', NT: 'upnp:event' });
    assert.strictEqual(foreign.status, 412, 'events never go to a third address');
    await wait(300);
    assert.strictEqual(notifications.length, 1, 'initial event');
    assert.strictEqual(notifications[0].headers.seq, '0'); assert.strictEqual(notifications[0].headers.nts, 'upnp:propchange');
    assert(/TransportState val=&quot;NO_MEDIA_PRESENT&quot;/.test(notifications[0].body));

    // Play a video from the phone.
    const didlText = '&lt;DIDL-Lite xmlns:dc=&quot;http://purl.org/dc/elements/1.1/&quot; xmlns:upnp=&quot;urn:schemas-upnp-org:metadata-1-0/upnp/&quot;&gt;&lt;item&gt;&lt;dc:title&gt;Urlaubsvideo&lt;/dc:title&gt;&lt;upnp:class&gt;object.item.videoItem&lt;/upnp:class&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;';
    let r = await soap(port, 'AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: 'http://192.168.43.20:8192/video.mp4?id=1&amp;x=2', CurrentURIMetaData: didlText });
    assert.strictEqual(r.status, 200, r.body);
    assert.strictEqual(player.commands.filter(c => c[0] === 'load').length, 0, 'a stopped renderer loads only on Play');
    r = await soap(port, 'AVTransport', 'GetTransportInfo', { InstanceID: 0 });
    assert.strictEqual(value(r.body, 'CurrentTransportState'), 'STOPPED');
    r = await soap(port, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(player.commands.slice(-2), [['load', 'http://192.168.43.20:8192/video.mp4?id=1&x=2', 0], ['play']], 'XML entities are decoded in the URL');
    assert.strictEqual(renderer.transport.state, 'TRANSITIONING');
    player.update({ state: 'playing', media: 'video', frame: { width: 1600, height: 520, sequence: 1, generation: '1:2' }, file: '/dev/shm/mgu-video-android-1' });
    player.state.position = 61; player.state.duration = 3600;
    let shown = renderer.presentation();
    assert.strictEqual(shown.transport, 'PLAYING'); assert.strictEqual(shown.media, 'video'); assert.strictEqual(shown.title, 'Urlaubsvideo');
    assert.strictEqual(shown.file, '/dev/shm/mgu-video-android-1');
    r = await soap(port, 'AVTransport', 'GetPositionInfo', { InstanceID: 0 });
    assert.strictEqual(value(r.body, 'RelTime'), '0:01:01'); assert.strictEqual(value(r.body, 'TrackDuration'), '1:00:00');
    r = await soap(port, 'AVTransport', 'GetCurrentTransportActions', { InstanceID: 0 });
    assert.strictEqual(value(r.body, 'Actions'), 'Pause,Stop,Seek');
    r = await soap(port, 'AVTransport', 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: '0:10:00' });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(player.commands[player.commands.length - 1], ['seek', 600]);
    r = await soap(port, 'AVTransport', 'Seek', { InstanceID: 0, Unit: 'X_DLNA_REL_BYTE', Target: '100' });
    assert.strictEqual(r.status, 500); assert.strictEqual(value(r.body, 'errorCode'), '710');
    r = await soap(port, 'AVTransport', 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: '9:00:00' });
    assert.strictEqual(value(r.body, 'errorCode'), '711', 'seeks beyond the duration are refused');
    r = await soap(port, 'AVTransport', 'Pause', { InstanceID: 0 });
    assert.strictEqual(renderer.transport.state, 'PAUSED_PLAYBACK');
    r = await soap(port, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
    assert.deepStrictEqual(player.commands[player.commands.length - 1], ['play'], 'resume without reloading');
    player.update({ state: 'playing' });
    await wait(300);
    assert(notifications.some(n => /TransportState val=&quot;PLAYING&quot;/.test(n.body) && /Urlaubsvideo/.test(n.body)), 'state changes are evented');
    assert(Number(notifications[notifications.length - 1].headers.seq) >= 1);

    // Volume and mute.
    await soap(port, 'RenderingControl', 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: 40 });
    r = await soap(port, 'RenderingControl', 'GetVolume', { InstanceID: 0, Channel: 'Master' });
    assert.strictEqual(value(r.body, 'CurrentVolume'), '40');
    r = await soap(port, 'RenderingControl', 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: 140 });
    assert.strictEqual(value(r.body, 'errorCode'), '402');
    await soap(port, 'RenderingControl', 'SetMute', { InstanceID: 0, Channel: 'Master', DesiredMute: 'true' });
    assert(player.commands.some(c => c[0] === 'mute' && c[1] === true));

    // Gapless next item and end of playback.
    await soap(port, 'AVTransport', 'SetNextAVTransportURI', { InstanceID: 0, NextURI: 'http://192.168.43.20:8192/song.mp3', NextURIMetaData: '' });
    player.update({ state: 'ended' });
    assert.deepStrictEqual(player.commands.slice(-2), [['load', 'http://192.168.43.20:8192/song.mp3', 0], ['play']], 'the next item follows automatically');
    player.update({ state: 'playing', media: 'audio', frame: null });
    assert.strictEqual(renderer.presentation().media, 'audio');
    player.update({ state: 'ended' });
    assert.strictEqual(renderer.transport.state, 'STOPPED'); assert.strictEqual(renderer.presentation(), null, 'a finished item releases the screen');

    // Unsafe or unsupported requests.
    r = await soap(port, 'AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: 'file:///etc/passwd', CurrentURIMetaData: '' });
    assert.strictEqual(value(r.body, 'errorCode'), '714');
    r = await soap(port, 'AVTransport', 'Play', { InstanceID: 7, Speed: 1 });
    assert.strictEqual(value(r.body, 'errorCode'), '718');
    r = await request(port, 'POST', '/dlna/AVTransport/control', 'x', { SOAPACTION: '"urn:schemas-upnp-org:service:AVTransport:1#Format"' });
    assert.strictEqual(value(r.body, 'errorCode'), '401');
    r = await request(port, 'POST', '/dlna/AVTransport/control', 'x'.repeat(70000), { SOAPACTION: '"urn:schemas-upnp-org:service:AVTransport:1#Play"' }).catch(() => ({ status: 413 }));
    assert.strictEqual(r.status, 413, 'oversized requests are refused');

    // A photo stays on screen after its single frame.
    await soap(port, 'AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: 'http://192.168.43.20:8192/photo.jpg', CurrentURIMetaData: '' });
    await soap(port, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
    player.update({ state: 'playing', media: 'video', frame: { width: 1600, height: 520, sequence: 1, generation: '1:3' } });
    player.update({ state: 'ended' });
    assert.strictEqual(renderer.transport.state, 'PLAYING');
    // A failing stream reports an error and returns to STOPPED.
    player.update({ state: 'stopped', error: 'player_network_failed' });
    assert.strictEqual(renderer.transport.state, 'STOPPED'); assert.strictEqual(renderer.transport.status, 'ERROR_OCCURRED');
    await soap(port, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
    player.update({ state: 'playing', error: null });
    await soap(port, 'AVTransport', 'Stop', { InstanceID: 0 });
    assert.deepStrictEqual(player.commands[player.commands.length - 1], ['stop']);
    assert.strictEqual(renderer.presentation(), null);

    // Unsubscribe, then stop: goodbye on every WLAN interface.
    assert.strictEqual((await request(port, 'UNSUBSCRIBE', '/dlna/AVTransport/event', null, { SID: subscribed.headers.sid })).status, 200);
    assert.strictEqual((await request(port, 'UNSUBSCRIBE', '/dlna/AVTransport/event', null, { SID: subscribed.headers.sid })).status, 412);
    sent.length = 0;
    await renderer.stop();
    assert(sent.length >= 6 && sent.every(m => /NTS: ssdp:byebye/.test(m.text)));
    assert(!renderer.running && renderer.presentation() === null);
    phone.close();
    fs.rmSync ? fs.rmSync(dataDir, { recursive: true, force: true }) : null;
    console.log('DLNA renderer: discovery, description, SOAP transport/volume, events, next item, photos, errors and limits passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
