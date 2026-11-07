ALTER TABLE "users" ADD COLUMN "question_intensity" text DEFAULT 'thorough' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "question_style" text DEFAULT 'mixed' NOT NULL;--> statement-breakpoint
UPDATE "users" SET "question_intensity" = latest."question_intensity", "question_style" = latest."question_style"
FROM (SELECT DISTINCT ON ("user_id") "user_id", "question_intensity", "question_style" FROM "content_items" ORDER BY "user_id", "created_at" DESC) latest
WHERE latest."user_id" = "users"."id";--> statement-breakpoint
ALTER TABLE "content_items" DROP COLUMN "question_intensity";--> statement-breakpoint
ALTER TABLE "content_items" DROP COLUMN "question_style";