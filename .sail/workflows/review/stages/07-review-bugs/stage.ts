// review-bugs: one of review's six reviewers: does the change work on every input and path, not only the ones its tests
// take? It reports findings with a severity and what it checked, and judges nothing: the judge decides what each
// finding becomes.
import { reviewer } from '../../reviewer';

export const reviewBugs = reviewer('review-bugs', 'default');
