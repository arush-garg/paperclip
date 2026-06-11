import crypto from "node:crypto";
import net from "node:net";
import http from "node:http";
import { eq } from "drizzle-orm";
import { google } from "googleapis";
import type { drive_v3 } from "googleapis";
import type { Db } from "@paperclipai/db";
import { companyDriveConnections } from "@paperclipai/db";
import type { CompanyDriveConnection, CompanyDriveConnectionStatus, DriveFolder, DriveConnectStartResponse } from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import { sealCloudUpstreamCredential, unsealCloudUpstreamCredential } from "./cloud-upstreams.js";

// drive.file is the only non-restricted Drive scope — it doesn't require Google app
// verification and avoids the "This app is blocked" error for Google Workspace accounts.
// Broader scopes (drive, drive.readonly) are restricted and require Google review to
// avoid access blocks. With drive.file the server can create/update files it creates,
// but cannot list arbitrary existing folders (use paste-URL flow for folder selection).
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.file"];

// ── Serialized client JSON (installed/desktop app type) ─────────────────────

interface InstalledClientJson {
  installed: {
    client_id: string;
    client_secret: string;
    project_id?: string;
    auth_uri: string;
    token_uri: string;
    redirect_uris: string[];
  };
}

function parseClientJson(json: unknown): InstalledClientJson["installed"] {
  if (typeof json !== "object" || json === null) throw badRequest("Invalid client JSON");
  const obj = json as Record<string, unknown>;
  if (typeof obj.installed !== "object" || obj.installed === null) {
    throw badRequest("Not a Desktop application client JSON. Expected an 'installed' key. Download from Google Cloud Console → Credentials → OAuth 2.0 Client ID → Desktop app.");
  }
  const inst = obj.installed as Record<string, unknown>;
  if (typeof inst.client_id !== "string" || !inst.client_id) throw badRequest("Missing client_id");
  if (typeof inst.client_secret !== "string" || !inst.client_secret) throw badRequest("Missing client_secret");
  if (typeof inst.token_uri !== "string" || !inst.token_uri) throw badRequest("Missing token_uri");
  if (typeof inst.auth_uri !== "string" || !inst.auth_uri) throw badRequest("Missing auth_uri");
  const redirectUris = Array.isArray(inst.redirect_uris) ? inst.redirect_uris as string[] : [];
  if (!redirectUris.some((u) => u === "http://localhost" || u.startsWith("http://localhost:"))) {
    throw badRequest("Client JSON must include http://localhost in redirect_uris (Desktop app type)");
  }
  return {
    client_id: inst.client_id,
    client_secret: inst.client_secret,
    project_id: typeof inst.project_id === "string" ? inst.project_id : undefined,
    auth_uri: inst.auth_uri,
    token_uri: inst.token_uri,
    redirect_uris: redirectUris,
  };
}

// ── Row → public type ────────────────────────────────────────────────────────

function connectionFromRow(row: typeof companyDriveConnections.$inferSelect): CompanyDriveConnection {
  return {
    id: row.id,
    companyId: row.companyId,
    clientId: row.clientId,
    projectId: row.projectId,
    authUri: row.authUri,
    tokenUri: row.tokenUri,
    tokenStatus: row.tokenStatus as CompanyDriveConnectionStatus,
    googleAccountEmail: row.googleAccountEmail,
    folderId: row.folderId,
    folderName: row.folderName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Find or create the single connection row per company ─────────────────────

async function getOrCreateConnectionRow(db: Db, companyId: string) {
  const [existing] = await db
    .select()
    .from(companyDriveConnections)
    .where(eq(companyDriveConnections.companyId, companyId))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(companyDriveConnections)
    .values({ companyId })
    .returning();
  if (!created) throw new Error("Failed to create drive connection row");
  return created;
}

async function getConnectionRow(db: Db, companyId: string) {
  const [row] = await db
    .select()
    .from(companyDriveConnections)
    .where(eq(companyDriveConnections.companyId, companyId))
    .limit(1);
  return row ?? null;
}

// ── Build an authenticated Drive client ──────────────────────────────────────

export async function getAuthedDriveClient(db: Db, companyId: string): Promise<{ drive: drive_v3.Drive; oauth2: ReturnType<typeof google.auth.OAuth2.prototype.on> extends unknown ? InstanceType<typeof google.auth.OAuth2> : never; row: typeof companyDriveConnections.$inferSelect }> {
  const row = await getConnectionRow(db, companyId);
  if (!row || !row.clientId || !row.clientSecretKey || row.tokenStatus !== "connected") {
    throw notFound("Google Drive is not connected for this company");
  }

  const clientSecret = await unsealCloudUpstreamCredential(row.clientSecretKey);
  const oauth2 = new google.auth.OAuth2(row.clientId, clientSecret, row.pendingRedirectUri ?? "http://localhost");

  const accessToken = row.accessToken ? await unsealCloudUpstreamCredential(row.accessToken) : null;
  const refreshToken = row.refreshToken ? await unsealCloudUpstreamCredential(row.refreshToken) : null;

  oauth2.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: row.tokenExpiresAt ? row.tokenExpiresAt.getTime() : undefined,
  });

  // Auto-refresh and re-seal if expired
  oauth2.on("tokens", async (tokens) => {
    const updates: Partial<typeof companyDriveConnections.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (tokens.access_token) {
      updates.accessToken = await sealCloudUpstreamCredential(tokens.access_token);
    }
    if (tokens.expiry_date) {
      updates.tokenExpiresAt = new Date(tokens.expiry_date);
    }
    await db
      .update(companyDriveConnections)
      .set(updates)
      .where(eq(companyDriveConnections.companyId, companyId));
  });

  return { drive: google.drive({ version: "v3", auth: oauth2 }), oauth2, row };
}

// ── Find a free localhost port ───────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("Could not determine port"));
      });
    });
    srv.on("error", reject);
  });
}

// ── Service ──────────────────────────────────────────────────────────────────

export function companyDriveService(db: Db) {
  return {
    getConnection: async (companyId: string): Promise<CompanyDriveConnection | null> => {
      const row = await getConnectionRow(db, companyId);
      return row ? connectionFromRow(row) : null;
    },

    uploadClientCredentials: async (companyId: string, rawJson: unknown): Promise<CompanyDriveConnection> => {
      const inst = parseClientJson(rawJson);
      // Store the raw client_secret encrypted; we use clientSecretKey column as the sealed envelope directly
      const sealedSecret = await sealCloudUpstreamCredential(inst.client_secret);
      const row = await getOrCreateConnectionRow(db, companyId);
      const [updated] = await db
        .update(companyDriveConnections)
        .set({
          clientId: inst.client_id,
          projectId: inst.project_id ?? null,
          authUri: inst.auth_uri,
          tokenUri: inst.token_uri,
          clientSecretKey: sealedSecret,
          tokenStatus: "no_credentials",
          // Clear any stale tokens when creds change
          accessToken: null,
          refreshToken: null,
          tokenExpiresAt: null,
          googleAccountEmail: null,
          pendingState: null,
          pendingCodeVerifier: null,
          pendingRedirectUri: null,
          pendingPort: null,
          updatedAt: new Date(),
        })
        .where(eq(companyDriveConnections.id, row.id))
        .returning();
      if (!updated) throw new Error("Failed to update drive connection");
      return connectionFromRow(updated);
    },

    startConnect: async (companyId: string): Promise<DriveConnectStartResponse & { connectionId: string; port: number }> => {
      const row = await getConnectionRow(db, companyId);
      if (!row || !row.clientId || !row.clientSecretKey) {
        throw badRequest("Upload Google OAuth client JSON before connecting");
      }

      const port = await findFreePort();
      const redirectUri = `http://localhost:${port}`;
      const state = crypto.randomBytes(24).toString("base64url");
      const codeVerifier = crypto.randomBytes(32).toString("base64url");
      const codeChallenge = crypto.createHash("sha256").update(codeVerifier, "utf8").digest("base64url");

      await db
        .update(companyDriveConnections)
        .set({
          tokenStatus: "pending",
          pendingState: state,
          pendingCodeVerifier: await sealCloudUpstreamCredential(codeVerifier),
          pendingRedirectUri: redirectUri,
          pendingPort: String(port),
          updatedAt: new Date(),
        })
        .where(eq(companyDriveConnections.id, row.id));

      const authUrl = new URL(row.authUri ?? "https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", row.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", DRIVE_SCOPES.join(" "));
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");

      return { authorizationUrl: authUrl.toString(), connectionId: row.id, port };
    },

    // Called after the user manually redirects (or for the loopback approach via the server-side listener)
    finishConnect: async (companyId: string, input: { code: string; state: string }): Promise<CompanyDriveConnection> => {
      const row = await getConnectionRow(db, companyId);
      if (!row || !row.pendingState || !row.pendingCodeVerifier || !row.clientId || !row.clientSecretKey) {
        throw notFound("No pending Drive connection for this company");
      }
      if (input.state !== row.pendingState) throw badRequest("Drive OAuth state mismatch");

      const clientSecret = await unsealCloudUpstreamCredential(row.clientSecretKey);
      const codeVerifier = await unsealCloudUpstreamCredential(row.pendingCodeVerifier);
      const redirectUri = row.pendingRedirectUri ?? "http://localhost";

      const oauth2 = new google.auth.OAuth2(row.clientId, clientSecret, redirectUri);
      const { tokens } = await oauth2.getToken({ code: input.code, codeVerifier });
      if (!tokens.access_token) throw badRequest("No access token in token response");

      // Fetch account email
      oauth2.setCredentials(tokens);
      let email: string | null = null;
      try {
        const people = google.oauth2({ version: "v2", auth: oauth2 });
        const info = await people.userinfo.get();
        email = info.data.email ?? null;
      } catch {
        // Non-fatal
      }

      const [updated] = await db
        .update(companyDriveConnections)
        .set({
          tokenStatus: "connected",
          accessToken: await sealCloudUpstreamCredential(tokens.access_token),
          refreshToken: tokens.refresh_token ? await sealCloudUpstreamCredential(tokens.refresh_token) : row.refreshToken,
          tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          scope: tokens.scope ?? null,
          googleAccountEmail: email,
          pendingState: null,
          pendingCodeVerifier: null,
          updatedAt: new Date(),
        })
        .where(eq(companyDriveConnections.id, row.id))
        .returning();
      if (!updated) throw new Error("Failed to update drive connection");
      return connectionFromRow(updated);
    },

    // Start a loopback HTTP listener that waits for the OAuth redirect and calls finishConnect
    listenForCallback: async (companyId: string, port: number): Promise<CompanyDriveConnection> => {
      return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
          try {
            const url = new URL(req.url ?? "/", `http://localhost:${port}`);
            const code = url.searchParams.get("code");
            const state = url.searchParams.get("state");
            const error = url.searchParams.get("error");
            if (error) {
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end("<html><body><h2>Authorization failed. You may close this tab.</h2></body></html>");
              server.close();
              reject(badRequest(`Drive OAuth error: ${error}`));
              return;
            }
            if (!code || !state) return;
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<html><body><h2>Authorization successful! You may close this tab and return to Paperclip.</h2></body></html>");
            server.close();
            const connection = await companyDriveService(db).finishConnect(companyId, { code, state });
            resolve(connection);
          } catch (err) {
            server.close();
            reject(err);
          }
        });
        server.listen(port, "127.0.0.1", () => {
          // Listener is running; the caller will open the auth URL in the browser
        });
        server.on("error", reject);
        // Timeout after 5 minutes
        setTimeout(() => {
          server.close();
          reject(new Error("Drive OAuth loopback timed out after 5 minutes"));
        }, 5 * 60 * 1000);
      });
    },

    disconnect: async (companyId: string): Promise<void> => {
      const row = await getConnectionRow(db, companyId);
      if (!row) return;
      // Best-effort token revocation
      if (row.accessToken && row.clientId && row.clientSecretKey) {
        try {
          const clientSecret = await unsealCloudUpstreamCredential(row.clientSecretKey);
          const accessToken = await unsealCloudUpstreamCredential(row.accessToken);
          const oauth2 = new google.auth.OAuth2(row.clientId, clientSecret);
          oauth2.setCredentials({ access_token: accessToken });
          await oauth2.revokeCredentials();
        } catch {
          // Non-fatal
        }
      }
      await db
        .update(companyDriveConnections)
        .set({
          tokenStatus: "revoked",
          accessToken: null,
          refreshToken: null,
          tokenExpiresAt: null,
          googleAccountEmail: null,
          folderId: null,
          folderName: null,
          pendingState: null,
          pendingCodeVerifier: null,
          pendingRedirectUri: null,
          pendingPort: null,
          updatedAt: new Date(),
        })
        .where(eq(companyDriveConnections.id, row.id));
    },

    listFolders: async (companyId: string, parentId?: string, search?: string): Promise<DriveFolder[]> => {
      const { drive } = await getAuthedDriveClient(db, companyId);
      const conditions = ["mimeType='application/vnd.google-apps.folder'", "trashed=false"];
      if (parentId && !search) {
        conditions.push(`'${parentId}' in parents`);
      }
      if (search) {
        conditions.push(`name contains '${search.replace(/'/g, "\\'")}'`);
      }
      const res = await drive.files.list({
        q: conditions.join(" and "),
        fields: "files(id,name,parents)",
        pageSize: 100,
        orderBy: "name",
      });
      const files = res.data.files ?? [];

      // In search mode, batch-fetch parent names so the UI can disambiguate same-named folders
      let parentNames: Map<string, string> = new Map();
      if (search && files.length > 0) {
        const uniqueParentIds = [...new Set(files.flatMap((f) => f.parents ?? []))];
        await Promise.all(
          uniqueParentIds.map(async (pid) => {
            try {
              const p = await drive.files.get({ fileId: pid, fields: "id,name" });
              if (p.data.id && p.data.name) parentNames.set(p.data.id, p.data.name);
            } catch {
              // Non-fatal — parent may be inaccessible (shared drive root, etc.)
            }
          }),
        );
      }

      return files.map((f) => ({
        id: f.id ?? "",
        name: f.name ?? "",
        parentId: f.parents?.[0] ?? null,
        parentName: search && f.parents?.[0] ? (parentNames.get(f.parents[0]) ?? null) : undefined,
      }));
    },

    selectFolder: async (companyId: string, folderId: string, folderName: string): Promise<CompanyDriveConnection> => {
      const row = await getConnectionRow(db, companyId);
      if (!row) throw notFound("No Drive connection for this company");
      const [updated] = await db
        .update(companyDriveConnections)
        .set({ folderId, folderName, updatedAt: new Date() })
        .where(eq(companyDriveConnections.id, row.id))
        .returning();
      if (!updated) throw new Error("Failed to update drive folder selection");
      return connectionFromRow(updated);
    },
  };
}
