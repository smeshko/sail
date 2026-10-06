// Generated from src/sdk by `bun run types`. Do not edit.
import { z } from 'zod';
declare const Shape: z.ZodObject<{
    ticketKey: z.ZodString;
    title: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    url: z.ZodURL;
    acceptanceCriteria: z.ZodArray<z.core.$ZodBranded<z.ZodString, "untrusted", "out">>;
    labels: z.ZodArray<z.core.$ZodBranded<z.ZodString, "untrusted", "out">>;
    links: z.ZodArray<z.ZodObject<{
        url: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
        title: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "untrusted", "out">>;
    }, z.core.$strip>>;
    attachments: z.ZodArray<z.ZodObject<{
        name: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
        url: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
        mimeType: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** A ticket as the `ticket` intake hands it to the workflow: `run.input`. */
export declare const TicketInput: typeof Shape;
export type TicketInput = z.infer<typeof TicketInput>;
/** The built-in intake for ticket sources. It leaves `ticket.json` and `brief.md`. Declared here; its body comes later. */
export declare const ticket: import("./intake").Intake<z.ZodObject<{
    ticketKey: z.ZodString;
    title: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
    url: z.ZodURL;
    acceptanceCriteria: z.ZodArray<z.core.$ZodBranded<z.ZodString, "untrusted", "out">>;
    labels: z.ZodArray<z.core.$ZodBranded<z.ZodString, "untrusted", "out">>;
    links: z.ZodArray<z.ZodObject<{
        url: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
        title: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "untrusted", "out">>;
    }, z.core.$strip>>;
    attachments: z.ZodArray<z.ZodObject<{
        name: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
        url: z.core.$ZodBranded<z.ZodString, "untrusted", "out">;
        mimeType: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>, {
    'ticket.json': "file";
    'brief.md': "file";
}, import("./steps").StepList>;
export {};
