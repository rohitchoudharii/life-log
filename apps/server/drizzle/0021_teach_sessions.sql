CREATE TABLE "teach_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" jsonb,
	"due_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teach_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "teach_sessions" ADD CONSTRAINT "teach_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teach_sessions" ADD CONSTRAINT "teach_sessions_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "teach_sessions_card_id_index" ON "teach_sessions" USING btree ("card_id");--> statement-breakpoint
CREATE POLICY "own_rows" ON "teach_sessions" AS PERMISSIVE FOR ALL TO public USING ("teach_sessions"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("teach_sessions"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);