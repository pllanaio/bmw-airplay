'use strict';
// Wi-Fi Direct probe: iw parsing and the summary the app shows.
const assert = require('assert');
const { parseIw, probe } = require('./runtime/p2p_probe');

const iw = [
    'Wiphy phy0',
    '\twiphy index: 0',
    '\tSupported interface modes:',
    '\t\t * IBSS', '\t\t * managed', '\t\t * AP', '\t\t * monitor', '\t\t * P2P-client', '\t\t * P2P-GO', '\t\t * P2P-device',
    '\tBand 1:',
    '\tvalid interface combinations:',
    '\t\t * #{ managed } <= 1, #{ AP, P2P-client, P2P-GO } <= 1, #{ P2P-device } <= 1,',
    '\t\t   total <= 3, #channels <= 2',
    '\tHT Capability overrides:',
    'Wiphy phy1',
    '\tSupported interface modes:',
    '\t\t * managed', '\t\t * monitor',
    '\tvalid interface combinations:',
    '\t\t * #{ managed } <= 1,',
    '\t\t   total <= 1, #channels <= 1',
    '',
].join('\n');
const phys = parseIw(iw);
assert.strictEqual(phys.length, 2);
assert.deepStrictEqual([phys[0].phy, phys[0].p2pGo, phys[0].p2pClient, phys[0].p2pDevice, phys[0].concurrent], ['phy0', true, true, true, true]);
assert(/total <= 3/.test(phys[0].combinations[0]), 'continuation lines are joined');
assert.deepStrictEqual([phys[1].p2pGo, phys[1].p2pClient, phys[1].concurrent], [false, false, false]);

function fakeIo(output, status) {
    const files = { '/usr/sbin/wpa_supplicant': Buffer.from('...P2P_FIND...') };
    return {
        fs: {
            readdirSync: dir => dir === '/sys/class/ieee80211' ? ['phy0'] : ['wlan0', 'wlan_bridge', 'lo'],
            readlinkSync: () => '../../../bus/pci/drivers/iwlwifi',
            existsSync: p => p === '/base/runtime/bin/iw' || p in files || /\/sys\/class\/net\/wlan/.test(p),
            statSync: p => ({ isFile: () => true, size: files[p].length }), readFileSync: p => files[p],
        },
        cp: { spawnSync: (binary, args) => { assert.strictEqual(binary, '/base/runtime/lib/ld-linux-x86-64.so.2'); assert.deepStrictEqual(args.slice(-2), ['/base/runtime/bin/iw', 'phy']); return { status, stdout: output }; } },
    };
}
let record = probe('/base', fakeIo(iw, 0));
assert.strictEqual(record.summary, 'concurrent');
assert.strictEqual(record.drivers.phy0, 'iwlwifi');
assert.deepStrictEqual(record.interfaces, ['wlan0', 'wlan_bridge']);
assert.deepStrictEqual(record.wpaSupplicant, { path: '/usr/sbin/wpa_supplicant', p2p: true });
record = probe('/base', fakeIo(iw.replace(/total <= 3/, 'total <= 1'), 0));
assert.strictEqual(record.summary, 'exclusive', 'P2P only without the uplink station');
record = probe('/base', fakeIo('Wiphy phy0\n\tSupported interface modes:\n\t\t * managed\n', 0));
assert.strictEqual(record.summary, 'unsupported');
record = probe('/base', fakeIo('', 1));
assert.strictEqual(record.summary, 'unknown');
console.log('Wi-Fi Direct probe parsing and summary passed');
