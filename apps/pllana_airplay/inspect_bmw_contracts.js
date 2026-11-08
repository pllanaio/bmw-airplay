'use strict';
// Optional local diagnostic runner; never offers/calls a vehicle service.
const { inspectBmwContracts, saveBmwMediaReport } = require('./bmw_media');
function run(args) {
    const options = {}; let output;
    for (let i=0;i<args.length;i++) {
        if (args[i] === '--root' && args[i+1]) options.root = args[++i];
        else if (args[i] === '--output-dir' && args[i+1]) output = args[++i];
        else throw Error('invalid_contract_inspection_argument');
    }
    if (!output) throw Error('private_output_directory_required');
    const report = inspectBmwContracts(options);
    const file = saveBmwMediaReport(output, report);
    return { file, catalog: report.catalog, candidateCount: (report.candidates || []).length,
        supported:false, reason:'provider_and_ownership_contract_not_verified' };
}
module.exports = { run };
if (require.main === module) {
    try { process.stdout.write(JSON.stringify(run(process.argv.slice(2)))+'\n'); }
    catch (e) { process.stderr.write(String(e.message || 'contract_inspection_failed')+'\n'); process.exitCode=1; }
}
