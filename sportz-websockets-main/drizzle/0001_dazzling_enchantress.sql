UPDATE "commentary" SET "sequence" = 0 WHERE "sequence" IS NULL;--> statement-breakpoint
ALTER TABLE "commentary" ALTER COLUMN "sequence" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "commentary" ALTER COLUMN "sequence" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "commentary" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "commentary" ADD COLUMN "provider_event_id" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "last_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "provider_match_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "commentary_provider_event_idx" ON "commentary" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "commentary_match_seq_idx" ON "commentary" USING btree ("match_id","sequence");