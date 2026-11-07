'use strict';
// Validate the built packages with the MGU Store's own deploy-tool parser.
// node test/store_package_check.js <store-checkout> <app.tgz> <receiver.tgz>
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), vm = require('vm'), Module = require('module');
const [storePath, appPath, toolPath] = process.argv.slice(2);
if (!storePath || !appPath || !toolPath) throw new Error('Expected Store checkout, app.tgz and receiver.tgz');
const unit = path.join(path.resolve(storePath), 'deploy/unit/mgu-deploy.js');
const source = fs.readFileSync(unit, 'utf8'), entry = 'process.exit(main());';
assert.equal(source.split(entry).length, 2, 'Unexpected deploy entry point');
const sandbox = { require: Module.createRequire(unit), __dirname: path.dirname(unit), process, Buffer, console, module: { exports: {} } };
vm.runInNewContext(source.replace(entry, 'module.exports = {validateArtifact};'), sandbox, { filename: unit });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'airplay-store-check-'));
const app = sandbox.module.exports.validateArtifact(path.resolve(appPath), work);
const tool = sandbox.module.exports.validateArtifact(path.resolve(toolPath), work);
assert.equal(app.id, 'pllana_airplay'); assert.equal(tool.id, 'pllana-airplay-receiver');
assert.equal(app.version, tool.version);
console.log('Store deploy validator accepted ' + app.id + '@' + app.version + ' and ' + tool.id + '@' + tool.version);
