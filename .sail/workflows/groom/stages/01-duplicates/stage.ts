// duplicates: names the open tickets that describe the same work as the groomed ticket, each with a confidence. It
// searches others.md rather than reading all of it, so it reads only the tickets that match however long the backlog
// is. The workflow, not the judge, applies the threshold to these numbers.
import { checker } from '../../checker';
import { Duplicates } from '../../schemas';

export const duplicates = checker('duplicates', Duplicates);
