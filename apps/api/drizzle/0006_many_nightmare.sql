CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "collection_id" uuid;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "collection_position" integer;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collections_user_idx" ON "collections" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "media_user_idx" ON "media" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_collection_idx" ON "content_items" USING btree ("collection_id","collection_position");