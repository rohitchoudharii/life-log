ALTER TABLE "sections" ADD COLUMN "write_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "sections" ADD COLUMN "write_error" text;--> statement-breakpoint
ALTER TABLE "sections" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "sections" ADD COLUMN "spare_ideas" jsonb DEFAULT '[]'::jsonb NOT NULL;