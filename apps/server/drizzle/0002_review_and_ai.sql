CREATE TABLE "ai_keys" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"key_ct" text NOT NULL,
	"last4" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"prompt" text NOT NULL,
	"answer" text NOT NULL,
	"entry_id" uuid,
	"state" jsonb NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "review_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "review_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"rating" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_keys" ADD CONSTRAINT "ai_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_log" ADD CONSTRAINT "review_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_log" ADD CONSTRAINT "review_log_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cards_user_id_due_at_index" ON "cards" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE INDEX "review_log_card_id_index" ON "review_log" USING btree ("card_id");--> statement-breakpoint
CREATE POLICY "own_rows" ON "ai_keys" AS PERMISSIVE FOR ALL TO public USING ("ai_keys"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("ai_keys"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "own_rows" ON "cards" AS PERMISSIVE FOR ALL TO public USING ("cards"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("cards"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "own_rows" ON "review_log" AS PERMISSIVE FOR ALL TO public USING ("review_log"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("review_log"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);