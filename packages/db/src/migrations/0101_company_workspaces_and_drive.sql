CREATE TABLE IF NOT EXISTS "company_workspaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "name" text DEFAULT 'Company default' NOT NULL,
  "source_type" text DEFAULT 'local_path' NOT NULL,
  "cwd" text,
  "repo_url" text,
  "repo_ref" text,
  "setup_command" text,
  "cleanup_command" text,
  "metadata" jsonb,
  "google_drive_connection_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_drive_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "client_id" text,
  "project_id" text,
  "auth_uri" text,
  "token_uri" text,
  "client_secret_key" text,
  "token_status" text DEFAULT 'no_credentials' NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "token_expires_at" timestamp with time zone,
  "scope" text,
  "google_account_email" text,
  "folder_id" text,
  "folder_name" text,
  "pending_state" text,
  "pending_code_verifier" text,
  "pending_redirect_uri" text,
  "pending_port" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_workspaces_company_id_companies_id_fk') THEN
    ALTER TABLE "company_workspaces" ADD CONSTRAINT "company_workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_drive_connections_company_id_companies_id_fk') THEN
    ALTER TABLE "company_drive_connections" ADD CONSTRAINT "company_drive_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_workspaces_company_uq" ON "company_workspaces" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_workspaces_company_idx" ON "company_workspaces" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_drive_connections_company_idx" ON "company_drive_connections" USING btree ("company_id");
