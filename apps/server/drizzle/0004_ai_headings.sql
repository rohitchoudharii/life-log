CREATE TABLE "ai_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"ok" boolean NOT NULL,
	"error" text,
	"ms" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sections" ADD COLUMN "ai_title" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_user_id_at_index" ON "ai_calls" USING btree ("user_id","at");--> statement-breakpoint
CREATE POLICY "own_rows" ON "ai_calls" AS PERMISSIVE FOR ALL TO public USING ("ai_calls"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("ai_calls"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);