CREATE TABLE "issue_phase_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"from_phase_key" text,
	"to_phase_key" text NOT NULL,
	"kind" text NOT NULL,
	"lifecycle_mode" text NOT NULL,
	"reason" text,
	"gate_gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_phase_transitions_kind_check" CHECK ("issue_phase_transitions"."kind" in ('initial', 'advance', 'complete', 'rework', 'override'))
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "phase_key" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "phase_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "phase_entered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_phase_transitions" ADD CONSTRAINT "issue_phase_transitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_phase_transitions" ADD CONSTRAINT "issue_phase_transitions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_phase_transitions" ADD CONSTRAINT "issue_phase_transitions_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_phase_transitions_issue_created_idx" ON "issue_phase_transitions" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "issues_company_project_phase_idx" ON "issues" USING btree ("company_id","project_id","phase_key") WHERE "issues"."phase_key" is not null;