// Generated from src/sdk by `bun run types`. Do not edit.
import { z } from 'zod';
/** A ticket as the `ticket` intake hands it to the workflow: `run.input`. */
export declare const TicketInput: z.ZodObject<{
    ticketKey: z.ZodString;
    title: z.ZodString;
    url: z.ZodURL;
    acceptanceCriteria: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export type TicketInput = z.infer<typeof TicketInput>;
/** The built-in intake for ticket sources. It leaves `ticket.json` and `brief.md`. Declared here; its body comes later. */
export declare const ticket: import("./intake").Intake<z.ZodObject<{
    ticketKey: z.ZodString;
    title: z.ZodString;
    url: z.ZodURL;
    acceptanceCriteria: z.ZodArray<z.ZodString>;
}, z.core.$strip>, {
    'ticket.json': "file";
    'brief.md': "file";
}, import("./steps").StepList>;
