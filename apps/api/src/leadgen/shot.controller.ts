import {
	Controller,
	Get,
	Inject,
	NotFoundException,
	Param,
	Res,
} from "@nestjs/common";
import { ApiExcludeEndpoint } from "@nestjs/swagger";
import type { Response } from "express";
import { LeadgenShotService } from "./shot.service";
import { isLeadId } from "./shot-cache";

@Controller("api/leadgen/shot")
export class ShotController {
	constructor(
		@Inject(LeadgenShotService) private readonly shots: LeadgenShotService,
	) {}

	@Get(":leadId")
	@ApiExcludeEndpoint()
	async read(@Param("leadId") leadId: string, @Res() res: Response) {
		if (!isLeadId(leadId)) throw new NotFoundException();
		const shot = await this.shots.image(leadId);
		if (!shot) throw new NotFoundException();
		res
			.status(200)
			.set({
				"Content-Type": "image/png",
				"Cache-Control": "private, max-age=300",
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "sandbox",
			})
			.send(shot.png);
	}
}
