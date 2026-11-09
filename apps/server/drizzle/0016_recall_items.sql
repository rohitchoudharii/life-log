ALTER TABLE "recall_attempts" ADD COLUMN "items" jsonb;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "reveal" jsonb;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "review_log" ADD CONSTRAINT "review_log_attempt_id_recall_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."recall_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_log_attempt_id_index" ON "review_log" USING btree ("attempt_id");