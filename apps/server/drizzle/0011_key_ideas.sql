CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"reading_id" uuid,
	"section_id" uuid,
	"type" text NOT NULL,
	"level" text NOT NULL,
	"content" jsonb NOT NULL,
	"prompt_version" text,
	"retired_at" timestamp with time zone,
	"report" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "reading_id" uuid;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "section_id" uuid;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "position" integer;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "origin" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "quote" text;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "level" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "answer_id" uuid;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "question_id" uuid;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "ask" text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "mode" text DEFAULT 'review' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "correct" boolean;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "response" jsonb;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "confidence" text;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "feedback" text;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "graded_by" text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "overridden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "predicted_recall" real;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "scheduler" text DEFAULT 'steps-ease-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "questions_card_id_index" ON "questions" USING btree ("card_id");--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_log" ADD CONSTRAINT "review_log_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cards_section_id_position_index" ON "cards" USING btree ("section_id","position");--> statement-breakpoint
ALTER TABLE "review_log" ADD CONSTRAINT "review_log_answerId_unique" UNIQUE("answer_id");--> statement-breakpoint
CREATE POLICY "own_rows" ON "questions" AS PERMISSIVE FOR ALL TO public USING ("questions"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("questions"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
-- Cards from before were all added by hand and reviewed at once, so they count as started.
UPDATE "cards" SET "started_at" = "created_at" WHERE "started_at" IS NULL;