import { Controller, Get, Inject, Req, Res } from "@nestjs/common";
import { ApiExcludeEndpoint } from "@nestjs/swagger";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { Request, Response } from "express";
import { PREVIEW } from "./demo-edit.config";
import { DemoPreviewService } from "./demo-preview.service";

@Controller("api/leadgen/demo-preview")
export class DemoPreviewController {
	constructor(
		@Inject(DemoPreviewService) private readonly previews: DemoPreviewService,
	) {}

	@Get("*path")
	@AllowAnonymous()
	@ApiExcludeEndpoint()
	async read(@Req() req: Request, @Res() res: Response) {
		const url = req.originalUrl.split("?")[0] ?? "";
		const start = url.indexOf(PREVIEW.routePrefix);
		const suffix =
			start < 0 ? "" : url.slice(start + PREVIEW.routePrefix.length + 1);
		const served = await this.previews.serve(suffix);
		res.status(served.status).set(served.headers).send(served.body);
	}
}
