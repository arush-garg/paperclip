import type { ProjectWorkspaceSourceType } from "./project.js";

export type CompanyDriveConnectionStatus =
  | "no_credentials"
  | "pending"
  | "connected"
  | "expired"
  | "revoked";

export interface CompanyDriveConnection {
  id: string;
  companyId: string;
  clientId: string | null;
  projectId: string | null;
  authUri: string | null;
  tokenUri: string | null;
  tokenStatus: CompanyDriveConnectionStatus;
  googleAccountEmail: string | null;
  folderId: string | null;
  folderName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyWorkspace {
  id: string;
  companyId: string;
  name: string;
  sourceType: ProjectWorkspaceSourceType;
  cwd: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  setupCommand: string | null;
  cleanupCommand: string | null;
  metadata: Record<string, unknown> | null;
  googleDriveConnectionId: string | null;
  driveConnection: CompanyDriveConnection | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DriveFolder {
  id: string;
  name: string;
  parentId: string | null;
  parentName?: string | null;
}

export interface DriveConnectStartResponse {
  authorizationUrl: string;
}
