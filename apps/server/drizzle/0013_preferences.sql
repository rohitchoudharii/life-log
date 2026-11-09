CREATE TABLE "preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"question_amount" text DEFAULT 'standard' NOT NULL,
	"question_style" text DEFAULT 'mixed' NOT NULL,
	"quality_check" boolean DEFAULT true NOT NULL,
	"guess_first" boolean DEFAULT true NOT NULL,
	"desired_retention" real DEFAULT 0.9 NOT NULL,
	"ai_monthly_budget_usd" numeric(8, 2) DEFAULT 5 NOT NULL,
	"review_batch" integer DEFAULT 20 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "own_rows" ON "preferences" AS PERMISSIVE FOR ALL TO public USING ("preferences"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("preferences"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);