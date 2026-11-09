CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reading_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reading_files" (
	"reading_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reading_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "readings" ADD COLUMN "file_hash" text;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_files" ADD CONSTRAINT "reading_files_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_files" ADD CONSTRAINT "reading_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_reading_id_index" ON "media" USING btree ("reading_id");--> statement-breakpoint
CREATE UNIQUE INDEX "readings_user_id_file_hash_index" ON "readings" USING btree ("user_id","file_hash") WHERE "readings"."file_hash" is not null;--> statement-breakpoint
CREATE POLICY "own_rows" ON "media" AS PERMISSIVE FOR ALL TO public USING ("media"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("media"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "own_rows" ON "reading_files" AS PERMISSIVE FOR ALL TO public USING ("reading_files"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("reading_files"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);