// A workflow's run budget: dollars and minutes, field by field over project.yaml's budgets.run. A step's turns are no
// run budget. test/types/expect-error.test.ts proves that each directive's line fails with the code it names.
import { workflow } from 'sail';
import { ticket } from 'sail/intakes';

workflow('budgeted', { intake: ticket, budget: { maxUsd: 1, maxMinutes: 30 } }, async () => 'done');

workflow('dollars-only', { intake: ticket, budget: { maxUsd: 0.5 } }, async () => 'done');

// @ts-expect-error TS2353: maxTurns is no run budget field
workflow('turns', { intake: ticket, budget: { maxTurns: 1 } }, async () => 'done');
