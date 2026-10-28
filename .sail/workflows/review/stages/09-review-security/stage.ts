// review-security: one of review's six reviewers: can untrusted input, a widened permission or a leaked secret turn the
// change against its user? It reports findings with a severity and what it checked, and judges nothing: the judge
// decides what each finding becomes.
import { reviewer } from '../../reviewer';

export const reviewSecurity = reviewer('review-security', 'deep');
