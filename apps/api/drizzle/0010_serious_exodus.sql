CREATE TABLE "words" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid,
	"word" text NOT NULL,
	"form" text NOT NULL,
	"sentence" text NOT NULL,
	"meaning" text NOT NULL,
	"schedule" jsonb,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mastered" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "words" ADD CONSTRAINT "words_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "words" ADD CONSTRAINT "words_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "words_user_word_idx" ON "words" USING btree ("user_id",lower("word"));--> statement-breakpoint
CREATE INDEX "words_due_idx" ON "words" USING btree ("user_id","due_at");