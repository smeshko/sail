// review-tests: one of review's six reviewers: do the change's tests prove its behaviour, and would they fail if it
// broke? It reports findings with a severity and what it checked, and judges nothing: the judge decides what each
// finding becomes.
import { reviewer } from '../../reviewer';

export const reviewTests = reviewer('review-tests');
