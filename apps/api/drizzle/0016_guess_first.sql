ALTER TABLE "review_log" ADD COLUMN "confidence" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "guess_first" boolean DEFAULT false NOT NULL;