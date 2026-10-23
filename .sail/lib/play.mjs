// Plays one seeded script report: the seed is a list of { exit, output, files? } by call, and the last one repeats.
// It writes the report's files into $STAGE_OUT, prints its output as the last stdout line, and exits with its code.
// Usage: bun .sail/lib/play.mjs <seed.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const reports = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const call = Number(process.env.CALL ?? '1');
const report = reports[Math.min(call, reports.length) - 1];
for (const [name, text] of Object.entries(report.files ?? {})) writeFileSync(join(process.env.STAGE_OUT, name), text);
console.error(`played ${process.env.STAGE}#${call} from the fake seed: exit ${report.exit}`);
console.log(JSON.stringify(report.output));
process.exit(report.exit);
