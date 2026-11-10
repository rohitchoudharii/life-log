ALTER TABLE "readings" ADD COLUMN "goal_by" date;--> statement-breakpoint
ALTER TABLE "readings" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "readings" ADD COLUMN "finished_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "readings" ADD CONSTRAINT "readings_finished_entry_id_entries_id_fk" FOREIGN KEY ("finished_entry_id") REFERENCES "public"."entries"("id") ON DELETE set null ON UPDATE no action;