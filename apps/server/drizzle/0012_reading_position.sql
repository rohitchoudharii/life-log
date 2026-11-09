CREATE TABLE "reading_time" (
	"user_id" uuid NOT NULL,
	"reading_id" uuid NOT NULL,
	"day" date NOT NULL,
	"seconds" integer NOT NULL,
	CONSTRAINT "reading_time_user_id_reading_id_day_pk" PRIMARY KEY("user_id","reading_id","day")
);
--> statement-breakpoint
ALTER TABLE "reading_time" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "readings" ADD COLUMN "position" jsonb;--> statement-breakpoint
ALTER TABLE "readings" ADD COLUMN "last_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sections" ADD COLUMN "first_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sections" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reading_time" ADD CONSTRAINT "reading_time_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_time" ADD CONSTRAINT "reading_time_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "readings_user_id_last_opened_at_index" ON "readings" USING btree ("user_id","last_opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "own_rows" ON "reading_time" AS PERMISSIVE FOR ALL TO public USING ("reading_time"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("reading_time"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);