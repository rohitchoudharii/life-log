CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"pillar" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"text" text,
	"text_ct" text,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entries_user_id_occurred_at_index" ON "entries" USING btree ("user_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "own_entries" ON "entries" AS PERMISSIVE FOR ALL TO public USING ("entries"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("entries"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);