CREATE TABLE "idea_reviews" (
	"idea_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"schedule" jsonb NOT NULL,
	"mastered" boolean DEFAULT false NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"last_reviewed_at" timestamp with time zone NOT NULL,
	"last_question_id" uuid
);
--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "practice" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "idea_reviews" ADD CONSTRAINT "idea_reviews_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_reviews" ADD CONSTRAINT "idea_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_reviews" ADD CONSTRAINT "idea_reviews_last_question_id_questions_id_fk" FOREIGN KEY ("last_question_id") REFERENCES "public"."questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idea_reviews_due_idx" ON "idea_reviews" USING btree ("user_id","due_at");--> statement-breakpoint
-- Each idea takes the schedule of its most recently reviewed question. Questions with no idea leave reviews.
INSERT INTO "idea_reviews" ("idea_id", "user_id", "schedule", "mastered", "due_at", "last_reviewed_at", "last_question_id")
SELECT DISTINCT ON (q."idea_id")
	q."idea_id",
	r."user_id",
	jsonb_build_object(
		'state', r."state",
		'level', coalesce(array_position(ARRAY['recall', 'explain', 'apply', 'analyze', 'transfer'], q."level") - 1, 0),
		'firstDay', to_char(r."last_reviewed_at", 'YYYY-MM-DD'),
		'correctDays', '[]'::jsonb,
		'mastered', false
	),
	false,
	r."due_at",
	r."last_reviewed_at",
	r."question_id"
FROM "reviews" r
JOIN "questions" q ON q."id" = r."question_id"
WHERE q."idea_id" IS NOT NULL
ORDER BY q."idea_id", r."last_reviewed_at" DESC;--> statement-breakpoint
DROP TABLE "reviews" CASCADE;