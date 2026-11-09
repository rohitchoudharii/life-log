CREATE TABLE "recall_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"reading_id" uuid NOT NULL,
	"section_ids" uuid[] NOT NULL,
	"text_ct" text,
	"source" text DEFAULT 'typed' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"results" jsonb,
	"feedback" text,
	"graded_by" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recall_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sections" ADD COLUMN "recalled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recall_attempts" ADD CONSTRAINT "recall_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_attempts" ADD CONSTRAINT "recall_attempts_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recall_attempts_user_id_created_at_index" ON "recall_attempts" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "own_rows" ON "recall_attempts" AS PERMISSIVE FOR ALL TO public USING ("recall_attempts"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("recall_attempts"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);