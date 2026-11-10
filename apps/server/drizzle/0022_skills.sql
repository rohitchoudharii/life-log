CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"goal" text,
	"weekly_minutes" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "own_rows" ON "skills" AS PERMISSIVE FOR ALL TO public USING ("skills"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("skills"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);