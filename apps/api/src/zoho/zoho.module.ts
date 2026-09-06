import { Module } from "@nestjs/common";
import { MailboxModule } from "../mailbox/mailbox.module";
import { TrpcModule } from "../trpc/trpc.module";
import { ZohoRouter } from "./zoho.router";
import { ZohoConnectionService } from "./zoho-connection.service";
import { ZohoMailClient } from "./zoho-mail.client";
import { ZohoMailSyncService } from "./zoho-mail-sync.service";
import { ZohoSyncService } from "./zoho-sync.service";

@Module({
	imports: [TrpcModule, MailboxModule],
	providers: [
		ZohoMailClient,
		ZohoMailSyncService,
		ZohoSyncService,
		ZohoConnectionService,
		ZohoRouter,
	],
	exports: [ZohoSyncService, ZohoConnectionService],
})
export class ZohoModule {}
