// duplicates: names the team's open tickets the groomed ticket may duplicate, each with a confidence. The workflow, not
// the judge, applies the threshold to these numbers.
import { checker } from '../../checker';
import { Duplicates } from '../../schemas';

export const duplicates = checker('duplicates', Duplicates);
