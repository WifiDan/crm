import { z } from "zod";

export const auditInput = z.object({ id: z.string().min(1).max(64) });

export const auditOutput = z.object({
	score: z.number(),
	priority: z.enum(["Low", "Medium", "High", "Error"]),
	signals: z.array(z.string()),
	url: z.string(),
});
