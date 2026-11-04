ALTER TABLE "questions" ADD COLUMN "level" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "also_section_ids" uuid[];--> statement-breakpoint
ALTER TABLE "sections" ADD COLUMN "key_ideas" jsonb DEFAULT '[]'::jsonb NOT NULL;