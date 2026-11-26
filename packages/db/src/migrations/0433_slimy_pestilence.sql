CREATE TABLE "company_role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"assigned_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "via_role_id" uuid;--> statement-breakpoint
ALTER TABLE "company_role_assignments" ADD CONSTRAINT "company_role_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_role_assignments" ADD CONSTRAINT "company_role_assignments_role_id_company_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."company_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_roles" ADD CONSTRAINT "company_roles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_role_assignments_role_user_uq" ON "company_role_assignments" USING btree ("role_id","user_id");--> statement-breakpoint
CREATE INDEX "company_role_assignments_company_user_idx" ON "company_role_assignments" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_roles_company_key_uq" ON "company_roles" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "company_roles_company_idx" ON "company_roles" USING btree ("company_id");