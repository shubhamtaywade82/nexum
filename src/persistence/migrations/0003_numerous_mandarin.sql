ALTER TABLE "sessions" ADD COLUMN "external_key" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_external_key_unique" UNIQUE("external_key");