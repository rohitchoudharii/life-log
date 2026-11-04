-- Cancelled sessions (ended without a stop point) were never focus time; from now on cancelling deletes the row.
DELETE FROM "study_sessions" WHERE "through_position" IS NULL AND "ended_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "question_intensity" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "question_style" text DEFAULT 'mixed' NOT NULL;--> statement-breakpoint
ALTER TABLE "sections" ADD COLUMN "level" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_items" DROP COLUMN "read_through";--> statement-breakpoint
ALTER TABLE "study_sessions" DROP COLUMN "from_position";--> statement-breakpoint
ALTER TABLE "study_sessions" DROP COLUMN "through_position";