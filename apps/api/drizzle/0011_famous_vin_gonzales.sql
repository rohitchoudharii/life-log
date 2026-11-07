ALTER TABLE "content_items" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "requested_url" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "links_import" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_parent_id_content_items_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_parent_idx" ON "content_items" USING btree ("parent_id");