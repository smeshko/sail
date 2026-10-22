// Generated from src/sdk by `bun run types`. Do not edit.
import { z } from 'zod';
/**
 * A ticket as the `ticket` intake hands it to the workflow: `run.input`. Every string the provider returned is marked
 * untrusted, the ticket's URL included, which is checked as a URL too. The ticket key is the run's own.
 */
export declare const TicketInput: z.ZodObject<{
    ticketKey: z.ZodString;
    title: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    url: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    acceptanceCriteria: z.ZodArray<z.core.$ZodBranded<z.ZodString, "untrusted", "out">>;
    labels: z.ZodArray<z.core.$ZodBranded<z.ZodString, "untrusted", "out">>;
    links: z.ZodArray<z.ZodObject<{
        url: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
        title: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "untrusted", "out">>;
    }, z.core.$strip>>;
    attachments: z.ZodArray<z.ZodObject<{
        name: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
        url: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
        mimeType: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "untrusted", "out">>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type TicketInput = z.infer<typeof TicketInput>;
/** The built-in intake for ticket sources. The engine runs its body, which leaves `ticket.json` and `brief.md`. */
export declare const ticket: import("./intake").Intake<z.ZodObject<{
    ticketKey: z.ZodString;
    title: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    url: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    acceptanceCriteria: z.ZodArray<z.core.$ZodBranded<z.ZodString, "untrusted", "out">>;
    labels: z.ZodArray<z.core.$ZodBranded<z.ZodString, "untrusted", "out">>;
    links: z.ZodArray<z.ZodObject<{
        url: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
        title: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "untrusted", "out">>;
    }, z.core.$strip>>;
    attachments: z.ZodArray<z.ZodObject<{
        name: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
        url: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
        mimeType: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "untrusted", "out">>;
    }, z.core.$strip>>;
}, z.core.$strip>, {
    'ticket.json': "file";
    'brief.md': "file";
}, import("./steps").StepList>;
/**
 * A pull request as the `pr` intake hands it to the workflow: `run.input`. Every string the host returned is marked
 * untrusted: the title, body, author, branch names, labels, comments and URL, which is checked as a URL too. The head
 * sha is the run's own, the one its workspace starts at, and the ticket key is there only when the pull request's ticket
 * marker matches its head branch.
 */
declare const PrInputFinal: z.ZodObject<{
    number: z.ZodNumber;
    url: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    title: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    body: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    author: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    base: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    head: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    headSha: z.ZodString;
    baseSha: z.ZodString;
    draft: z.ZodBoolean;
    labels: z.ZodArray<z.core.$ZodBranded<z.ZodString, "untrusted", "out">>;
    comments: z.ZodArray<z.ZodObject<{
        author: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
        body: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    }, z.core.$strip>>;
    ticketKey: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const PrInput: typeof PrInputFinal;
export type PrInput = z.infer<typeof PrInput>;
/**
 * The built-in intake for pull requests. The engine runs its body, which leaves `pr.json`, `diff.patch`, the change
 * from the merge base to the head sha, and `brief.md`.
 */
export declare const pr: import("./intake").Intake<z.ZodObject<{
    number: z.ZodNumber;
    url: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    title: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    body: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    author: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    base: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    head: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    headSha: z.ZodString;
    baseSha: z.ZodString;
    draft: z.ZodBoolean;
    labels: z.ZodArray<z.core.$ZodBranded<z.ZodString, "untrusted", "out">>;
    comments: z.ZodArray<z.ZodObject<{
        author: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
        body: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    }, z.core.$strip>>;
    ticketKey: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, {
    'pr.json': "file";
    'diff.patch': "file";
    'brief.md': "file";
}, import("./steps").StepList>;
export {};
