CREATE TABLE "book_chapters" (
	"reading_id" uuid PRIMARY KEY NOT NULL,
	"book_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "book_chapters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "books" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "books" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "readings" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "book_chapters" ADD CONSTRAINT "book_chapters_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_chapters" ADD CONSTRAINT "book_chapters_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_chapters" ADD CONSTRAINT "book_chapters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_chapters_book_id_position_index" ON "book_chapters" USING btree ("book_id","position");--> statement-breakpoint
CREATE INDEX "books_user_id_created_at_index" ON "books" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "own_rows" ON "book_chapters" AS PERMISSIVE FOR ALL TO public USING ("book_chapters"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("book_chapters"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "own_rows" ON "books" AS PERMISSIVE FOR ALL TO public USING ("books"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("books"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);