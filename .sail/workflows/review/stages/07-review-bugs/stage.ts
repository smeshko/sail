// review-bugs: one of review's five reviewers: does the change work on every input and path, not only the ones its
// tests take, and can untrusted input, a widened permission or a leaked secret turn it against its user? It reports
// findings with a severity and what it checked, and judges nothing: the judge decides what each finding becomes.
import { reviewer } from '../../reviewer';

export const reviewBugs = reviewer('review-bugs', 'frontier', { maxUsd: 6 });
