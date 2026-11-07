'use strict';
// Removal hook (root): give the receiver back to an older runtime that is
// still installed, if there is one.
const cp = require('child_process'), fs = require('fs');
const run = args => cp.spawnSync('systemctl', args, { encoding: 'utf8', timeout: 20000 });
if (fs.existsSync('/var/opt/mgu-airplay/current/component.json') && run(['cat', 'mgu-airplay.service']).status === 0) {
    run(['enable', 'mgu-airplay.service']);
    console.log('Re-enabled the previous receiver unit mgu-airplay.service');
}
