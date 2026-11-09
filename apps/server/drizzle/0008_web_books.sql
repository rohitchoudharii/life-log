CREATE TABLE "web_book_pages" (
	"reading_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"level" smallint NOT NULL,
	"kind" text NOT NULL,
	"blocks" jsonb,
	"error" text,
	CONSTRAINT "web_book_pages_reading_id_position_pk" PRIMARY KEY("reading_id","position")
);
--> statement-breakpoint
ALTER TABLE "web_book_pages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sections" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "web_book_pages" ADD CONSTRAINT "web_book_pages_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_book_pages" ADD CONSTRAINT "web_book_pages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "own_rows" ON "web_book_pages" AS PERMISSIVE FOR ALL TO public USING ("web_book_pages"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("web_book_pages"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);