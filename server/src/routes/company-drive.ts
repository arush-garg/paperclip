import { Router } from "express";
import multer from "multer";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyDriveConnections, companyWorkspaces } from "@paperclipai/db";
import { selectDriveFolderSchema, setCompanyWorkspaceSchema, setDriveFolderByUrlSchema, parseDriveFolderUrl } from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { companyDriveService } from "../services/company-drive.js";

const JSON_UPLOAD_SIZE_LIMIT = 1024 * 64; // 64 KB — plenty for an OAuth client JSON

const credentialUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: JSON_UPLOAD_SIZE_LIMIT, files: 1 },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runSingleFileUpload(upload: ReturnType<typeof multer>, req: any, res: any): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function companyDriveRoutes(db: Db) {
  const router = Router();

  // ── GET /companies/:companyId/workspace ─────────────────────────────────────
  // Returns the company-level default workspace (and drive connection summary if google_drive)
  router.get("/companies/:companyId/workspace", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);

    const [ws] = await db
      .select()
      .from(companyWorkspaces)
      .where(eq(companyWorkspaces.companyId, companyId))
      .limit(1);

    let driveConnection = null;
    if (ws?.sourceType === "google_drive") {
      driveConnection = await companyDriveService(db).getConnection(companyId);
    }

    res.json(ws ? { ...ws, driveConnection } : null);
  });

  // ── PUT /companies/:companyId/workspace ─────────────────────────────────────
  router.put("/companies/:companyId/workspace", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);

    const parsed = setCompanyWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid workspace config", details: parsed.error.issues });
      return;
    }
    const data = parsed.data;

    const [existing] = await db
      .select()
      .from(companyWorkspaces)
      .where(eq(companyWorkspaces.companyId, companyId))
      .limit(1);

    const values = {
      companyId,
      sourceType: data.sourceType,
      name: data.name ?? "Company default",
      cwd: data.cwd ?? null,
      repoUrl: data.repoUrl ?? null,
      repoRef: data.repoRef ?? null,
      setupCommand: data.setupCommand ?? null,
      cleanupCommand: data.cleanupCommand ?? null,
      googleDriveConnectionId: data.googleDriveConnectionId ?? null,
      updatedAt: new Date(),
    };

    let ws;
    if (existing) {
      [ws] = await db
        .update(companyWorkspaces)
        .set(values)
        .where(eq(companyWorkspaces.id, existing.id))
        .returning();
    } else {
      [ws] = await db.insert(companyWorkspaces).values(values).returning();
    }

    res.json(ws);
  });

  // ── POST /companies/:companyId/drive/credentials ────────────────────────────
  // Upload a Google OAuth Desktop-app client JSON file
  router.post("/companies/:companyId/drive/credentials", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);

    try {
      await runSingleFileUpload(credentialUpload, req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    type ReqWithFile = typeof req & { file?: { buffer: Buffer; mimetype: string } };
    const file = (req as ReqWithFile).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(file.buffer.toString("utf8"));
    } catch {
      res.status(400).json({ error: "Uploaded file is not valid JSON" });
      return;
    }

    const svc = companyDriveService(db);
    const connection = await svc.uploadClientCredentials(companyId, json);
    res.json(connection);
  });

  // ── POST /companies/:companyId/drive/connect ─────────────────────────────────
  // Start the OAuth loopback flow; returns the authorization URL
  router.post("/companies/:companyId/drive/connect", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);

    const svc = companyDriveService(db);
    const result = await svc.startConnect(companyId);

    // Start the loopback listener in the background (non-blocking from HTTP response perspective)
    svc.listenForCallback(companyId, result.port).catch((err) => {
      // Log but don't crash — client can fall back to manual code entry
      console.error("Drive loopback listener error", err);
    });

    res.json({ authorizationUrl: result.authorizationUrl, connectionId: result.connectionId });
  });

  // ── POST /companies/:companyId/drive/connect/finish ──────────────────────────
  // Manual finish for environments where loopback doesn't work
  router.post("/companies/:companyId/drive/connect/finish", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);

    const { code, state } = req.body as { code?: string; state?: string };
    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    const svc = companyDriveService(db);
    const connection = await svc.finishConnect(companyId, { code, state });
    res.json(connection);
  });

  // ── POST /companies/:companyId/drive/disconnect ──────────────────────────────
  router.post("/companies/:companyId/drive/disconnect", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);

    await companyDriveService(db).disconnect(companyId);
    res.json({ ok: true });
  });

  // ── GET /companies/:companyId/drive/connection ───────────────────────────────
  router.get("/companies/:companyId/drive/connection", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);

    const connection = await companyDriveService(db).getConnection(companyId);
    res.json(connection);
  });

  // ── GET /companies/:companyId/drive/folders ──────────────────────────────────
  router.get("/companies/:companyId/drive/folders", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);

    const parentId = typeof req.query.parentId === "string" ? req.query.parentId : undefined;
    const search = typeof req.query.search === "string" && req.query.search ? req.query.search : undefined;
    const folders = await companyDriveService(db).listFolders(companyId, parentId, search);
    res.json(folders);
  });

  // ── POST /companies/:companyId/drive/folder-by-url ───────────────────────────
  // Select a folder by pasting a Google Drive URL or bare folder ID — no OAuth required
  router.post("/companies/:companyId/drive/folder-by-url", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);

    const parsed = setDriveFolderByUrlSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }

    const folderId = parseDriveFolderUrl(parsed.data.folderUrl);
    if (!folderId) {
      res.status(400).json({ error: "Could not extract a folder ID from the provided URL. Paste the full Google Drive folder URL, e.g. https://drive.google.com/drive/folders/ABC123." });
      return;
    }

    const folderName = parsed.data.folderName?.trim() || folderId;

    // Ensure a connection row exists (may not have OAuth tokens — that's fine)
    const [existingConn] = await db
      .select()
      .from(companyDriveConnections)
      .where(eq(companyDriveConnections.companyId, companyId))
      .limit(1);

    let connection;
    if (existingConn) {
      [connection] = await db
        .update(companyDriveConnections)
        .set({ folderId, folderName, updatedAt: new Date() })
        .where(eq(companyDriveConnections.id, existingConn.id))
        .returning();
    } else {
      [connection] = await db
        .insert(companyDriveConnections)
        .values({ companyId, folderId, folderName })
        .returning();
    }

    if (!connection) throw new Error("Failed to save drive folder");

    // Also update/create the company workspace row
    const [existingWs] = await db
      .select()
      .from(companyWorkspaces)
      .where(eq(companyWorkspaces.companyId, companyId))
      .limit(1);

    if (existingWs) {
      await db
        .update(companyWorkspaces)
        .set({ sourceType: "google_drive", googleDriveConnectionId: connection.id, updatedAt: new Date() })
        .where(eq(companyWorkspaces.id, existingWs.id));
    } else {
      await db.insert(companyWorkspaces).values({
        companyId,
        sourceType: "google_drive",
        googleDriveConnectionId: connection.id,
      });
    }

    res.json({ folderId: connection.folderId, folderName: connection.folderName });
  });

  // ── POST /companies/:companyId/drive/folder ──────────────────────────────────
  router.post("/companies/:companyId/drive/folder", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);

    const parsed = selectDriveFolderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid folder selection", details: parsed.error.issues });
      return;
    }

    const connection = await companyDriveService(db).selectFolder(
      companyId,
      parsed.data.folderId,
      parsed.data.folderName,
    );

    // Also update/create the workspace row to google_drive source type
    const [existing] = await db
      .select()
      .from(companyWorkspaces)
      .where(eq(companyWorkspaces.companyId, companyId))
      .limit(1);

    if (existing) {
      await db
        .update(companyWorkspaces)
        .set({
          sourceType: "google_drive",
          googleDriveConnectionId: connection.id,
          updatedAt: new Date(),
        })
        .where(eq(companyWorkspaces.id, existing.id));
    } else {
      await db.insert(companyWorkspaces).values({
        companyId,
        sourceType: "google_drive",
        googleDriveConnectionId: connection.id,
      });
    }

    res.json(connection);
  });

  return router;
}
