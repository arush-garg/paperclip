import { z } from "zod";

export const setCompanyWorkspaceSchema = z.object({
  sourceType: z.enum(["local_path", "git_repo", "non_git_path", "google_drive"]),
  name: z.string().min(1).max(255).optional(),
  cwd: z.string().min(1).nullable().optional(),
  repoUrl: z.string().url().nullable().optional(),
  repoRef: z.string().min(1).nullable().optional(),
  setupCommand: z.string().min(1).nullable().optional(),
  cleanupCommand: z.string().min(1).nullable().optional(),
  googleDriveConnectionId: z.string().uuid().nullable().optional(),
});

export type SetCompanyWorkspace = z.infer<typeof setCompanyWorkspaceSchema>;

export const selectDriveFolderSchema = z.object({
  folderId: z.string().min(1),
  folderName: z.string().min(1),
});

export type SelectDriveFolder = z.infer<typeof selectDriveFolderSchema>;

// Parses a Google Drive folder URL and extracts the folder ID
// Handles: https://drive.google.com/drive/folders/ID
//          https://drive.google.com/drive/u/0/folders/ID
export function parseDriveFolderUrl(input: string): string | null {
  const trimmed = input.trim();
  // If it looks like a bare ID (alphanumeric + _-), use it directly
  if (/^[A-Za-z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/folders\/([A-Za-z0-9_-]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export const setDriveFolderByUrlSchema = z.object({
  folderUrl: z.string().min(1),
  folderName: z.string().min(1).max(255).optional(),
});

export type SetDriveFolderByUrl = z.infer<typeof setDriveFolderByUrlSchema>;
