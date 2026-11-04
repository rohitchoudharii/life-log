CREATE TABLE "ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recall_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"section_ids" uuid[] NOT NULL,
	"text" text NOT NULL,
	"results" jsonb,
	"feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "idea_id" uuid;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_attempts" ADD CONSTRAINT "recall_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_attempts" ADD CONSTRAINT "recall_attempts_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ideas_section_idx" ON "ideas" USING btree ("section_id","position");--> statement-breakpoint
CREATE INDEX "recall_attempts_user_idx" ON "recall_attempts" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Keep the key ideas already written, one row each, in order.
INSERT INTO "ideas" ("item_id", "section_id", "position", "text")
SELECT s."item_id", s."id", e.ord - 1, e.val FROM "sections" s, jsonb_array_elements_text(s."key_ideas") WITH ORDINALITY AS e(val, ord);--> statement-breakpoint
ALTER TABLE "sections" DROP COLUMN "key_ideas";