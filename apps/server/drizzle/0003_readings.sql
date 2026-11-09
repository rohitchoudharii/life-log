CREATE TABLE "readings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"source" text NOT NULL,
	"requested_url" text,
	"source_url" text,
	"published_at" timestamp with time zone,
	"status" text DEFAULT 'importing' NOT NULL,
	"error" text,
	"word_count" integer DEFAULT 0 NOT NULL,
	"merged_into" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "readings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reading_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"level" smallint NOT NULL,
	"title" text NOT NULL,
	"blocks" jsonb NOT NULL,
	"word_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "readings" ADD CONSTRAINT "readings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readings" ADD CONSTRAINT "readings_merged_into_readings_id_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "readings_user_id_created_at_index" ON "readings" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "readings_user_id_requested_url_index" ON "readings" USING btree ("user_id","requested_url") WHERE "readings"."requested_url" is not null;--> statement-breakpoint
CREATE INDEX "readings_user_id_source_url_index" ON "readings" USING btree ("user_id","source_url");--> statement-breakpoint
CREATE UNIQUE INDEX "sections_reading_id_position_index" ON "sections" USING btree ("reading_id","position");--> statement-breakpoint
CREATE POLICY "own_rows" ON "readings" AS PERMISSIVE FOR ALL TO public USING ("readings"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("readings"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "own_rows" ON "sections" AS PERMISSIVE FOR ALL TO public USING ("sections"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("sections"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);