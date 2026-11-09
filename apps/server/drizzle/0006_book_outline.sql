ALTER TABLE "sections" ADD COLUMN "kind" text DEFAULT 'body' NOT NULL;--> statement-breakpoint
ALTER TABLE "sections" ADD COLUMN "chapter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sections" ADD COLUMN "headings_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "sections_reading_id_chapter_index" ON "sections" USING btree ("reading_id","chapter");