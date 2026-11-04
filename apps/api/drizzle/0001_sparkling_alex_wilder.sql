CREATE TABLE "study_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"from_position" integer NOT NULL,
	"through_position" integer,
	"planned_minutes" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "response" jsonb;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "feedback" text;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "study_sessions_user_idx" ON "study_sessions" USING btree ("user_id","started_at");--> statement-breakpoint
ALTER TABLE "content_items" DROP COLUMN "checkpoint_through";--> statement-breakpoint
-- Self-graded flashcards become short-answer questions graded by the LLM judge.
UPDATE "questions" SET "type" = 'short_answer', "content" = jsonb_build_object('prompt', "content"->'front', 'reference', "content"->'back') WHERE "type" = 'flashcard';
