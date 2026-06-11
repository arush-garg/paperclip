import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyDriveConnections = pgTable(
  "company_drive_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),

    // Non-secret fields from the uploaded client JSON (installed/desktop type)
    clientId: text("client_id"),
    projectId: text("project_id"),
    authUri: text("auth_uri"),
    tokenUri: text("token_uri"),
    // Key into company_secrets where the full client JSON is stored encrypted
    clientSecretKey: text("client_secret_key"),

    // OAuth tokens — stored as encrypted credential envelopes (same pattern as cloud_upstream_connections)
    tokenStatus: text("token_status").notNull().default("no_credentials"),
    // Stored as encrypted credential envelope via sealCloudUpstreamCredential
    accessToken: text("access_token"),
    // Stored as encrypted credential envelope via sealCloudUpstreamCredential
    refreshToken: text("refresh_token"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    googleAccountEmail: text("google_account_email"),

    // Selected Drive folder
    folderId: text("folder_id"),
    folderName: text("folder_name"),

    // PKCE / loopback pending state
    pendingState: text("pending_state"),
    // Stored as encrypted credential envelope
    pendingCodeVerifier: text("pending_code_verifier"),
    pendingRedirectUri: text("pending_redirect_uri"),
    pendingPort: text("pending_port"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("company_drive_connections_company_idx").on(table.companyId),
  ],
);
