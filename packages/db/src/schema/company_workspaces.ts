import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyWorkspaces = pgTable(
  "company_workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Company default"),
    // Mirrors ProjectWorkspaceSourceType; extended with "google_drive"
    sourceType: text("source_type").notNull().default("local_path"),
    cwd: text("cwd"),
    repoUrl: text("repo_url"),
    repoRef: text("repo_ref"),
    setupCommand: text("setup_command"),
    cleanupCommand: text("cleanup_command"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    // Set when sourceType = "google_drive"
    googleDriveConnectionId: uuid("google_drive_connection_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("company_workspaces_company_uq").on(table.companyId),
    index("company_workspaces_company_idx").on(table.companyId),
  ],
);
