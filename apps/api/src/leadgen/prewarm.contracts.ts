import { z } from "zod";

export const prewarmInput = z.object({ id: z.string().min(1).max(64) });

export const prewarmOutput = z.object({
	shot: z.boolean(),
	audit: z.boolean(),
});
