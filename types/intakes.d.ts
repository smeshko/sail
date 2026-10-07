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
