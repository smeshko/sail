// questions: lists what a planner could not settle from the ticket and the repository alone.
import { checker } from '../../checker';
import { Questions } from '../../schemas';

export const questions = checker('questions', Questions);
