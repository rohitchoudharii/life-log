CREATE TABLE "scheduler_fits" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "scheduler_fits_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"reviews" integer NOT NULL,
	"held_out" integer NOT NULL,
	"weights" double precision[] NOT NULL,
	"current_log_loss" double precision NOT NULL,
	"new_log_loss" double precision NOT NULL,
	"kept" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduler_fits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "fsrs_weights" double precision[];--> statement-breakpoint
ALTER TABLE "scheduler_fits" ADD CONSTRAINT "scheduler_fits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduler_fits_user_id_at_index" ON "scheduler_fits" USING btree ("user_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "own_rows" ON "scheduler_fits" AS PERMISSIVE FOR ALL TO public USING ("scheduler_fits"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("scheduler_fits"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);