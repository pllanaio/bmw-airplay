'use strict';
// Install hook (root): take over from an older AirPlay receiver service.
// The privately deployed "mgu-airplay" runtime was bound to one app UID at
// build time and cannot be replaced by the Store; stop and disable its unit
// so only this receiver serves the app. deactivate.js gives it back.
const cp = require('child_process');
const run = args => cp.spawnSync('systemctl', args, { encoding: 'utf8', timeout: 20000 });
const old = 'mgu-airplay.service';
const known = run(['cat', old]).status === 0;
if (known) {
    run(['stop', old]);
    run(['disable', old]);
    console.log('Stopped and disabled the previous receiver unit ' + old);
} else console.log('No previous receiver unit');
