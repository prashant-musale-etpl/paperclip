CREATE TABLE "lifecycle_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"phases" jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_lifecycle_phases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"instructions" text,
	"exit_gate" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rework_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_lifecycle_phases_kind_check" CHECK ("project_lifecycle_phases"."kind" in ('work', 'terminal'))
);
--> statement-breakpoint
CREATE TABLE "project_lifecycles" (
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"template_id" uuid,
	"mode" text DEFAULT 'off' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_lifecycles_company_id_project_id_pk" PRIMARY KEY("company_id","project_id"),
	CONSTRAINT "project_lifecycles_mode_check" CHECK ("project_lifecycles"."mode" in ('off', 'advisory', 'enforced'))
);
--> statement-breakpoint
ALTER TABLE "lifecycle_templates" ADD CONSTRAINT "lifecycle_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_templates" ADD CONSTRAINT "lifecycle_templates_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_lifecycle_phases" ADD CONSTRAINT "project_lifecycle_phases_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_lifecycle_phases" ADD CONSTRAINT "project_lifecycle_phases_company_id_project_id_project_lifecycles_company_id_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."project_lifecycles"("company_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_lifecycles" ADD CONSTRAINT "project_lifecycles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_lifecycles" ADD CONSTRAINT "project_lifecycles_template_id_lifecycle_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."lifecycle_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_lifecycles" ADD CONSTRAINT "project_lifecycles_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_lifecycles" ADD CONSTRAINT "project_lifecycles_company_id_project_id_projects_company_id_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lifecycle_templates_company_key_uq" ON "lifecycle_templates" USING btree ("company_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "project_lifecycle_phases_project_key_uq" ON "project_lifecycle_phases" USING btree ("project_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "project_lifecycle_phases_project_position_uq" ON "project_lifecycle_phases" USING btree ("project_id","position");--> statement-breakpoint
CREATE INDEX "project_lifecycle_phases_company_idx" ON "project_lifecycle_phases" USING btree ("company_id");