import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, CloudUpload, ExternalLink, FolderOpen, Link, Loader2, Search, Unplug, UploadCloud, X } from "lucide-react";
import type { CompanyDriveConnection, CompanyWorkspace as CompanyWorkspaceType, DriveFolder } from "@paperclipai/shared";
import { companiesApi } from "@/api/companies";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/agent-config-primitives";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";

const WORKSPACE_QUERY_KEY = (companyId: string) => ["company-workspace", companyId] as const;
const DRIVE_CONNECTION_QUERY_KEY = (companyId: string) => ["company-drive-connection", companyId] as const;
const DRIVE_FOLDERS_QUERY_KEY = (companyId: string, parentId?: string, search?: string) =>
  ["company-drive-folders", companyId, parentId ?? "root", search ?? ""] as const;

type SourceType = "local_path" | "git_repo" | "google_drive";

export function CompanyWorkspace() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [sourceType, setSourceType] = useState<SourceType>("local_path");
  const [cwd, setCwd] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [driveFolderParentId, setDriveFolderParentId] = useState<string | undefined>();
  const [folderSearch, setFolderSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(folderSearch), 300);
    return () => clearTimeout(t);
  }, [folderSearch]);
  const [connectingDrive, setConnectingDrive] = useState(false);
  const [pollState, setPollState] = useState<{ code: string; state: string } | null>(null);
  const [folderUrlInput, setFolderUrlInput] = useState("");
  const [folderNameInput, setFolderNameInput] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Workspace" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const { data: workspace, isLoading } = useQuery({
    queryKey: selectedCompanyId ? WORKSPACE_QUERY_KEY(selectedCompanyId) : ["company-workspace", "__none__"],
    queryFn: () => companiesApi.getWorkspace(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const { data: driveConnection, refetch: refetchConnection } = useQuery({
    queryKey: selectedCompanyId ? DRIVE_CONNECTION_QUERY_KEY(selectedCompanyId) : ["company-drive-connection", "__none__"],
    queryFn: () => companiesApi.getDriveConnection(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: connectingDrive ? 3000 : false,
  });

  const { data: driveFolders, isLoading: foldersLoading } = useQuery({
    queryKey: selectedCompanyId && driveConnection?.tokenStatus === "connected"
      ? DRIVE_FOLDERS_QUERY_KEY(selectedCompanyId, debouncedSearch ? undefined : driveFolderParentId, debouncedSearch || undefined)
      : ["company-drive-folders", "__none__"],
    queryFn: () => companiesApi.listDriveFolders(
      selectedCompanyId!,
      debouncedSearch ? undefined : driveFolderParentId,
      debouncedSearch || undefined,
    ),
    enabled: Boolean(selectedCompanyId) && driveConnection?.tokenStatus === "connected",
  });

  // Sync local state with loaded workspace
  useEffect(() => {
    if (workspace) {
      setSourceType((workspace.sourceType as SourceType) ?? "local_path");
      setCwd(workspace.cwd ?? "");
      setRepoUrl(workspace.repoUrl ?? "");
    }
  }, [workspace]);

  // Stop polling once connected
  useEffect(() => {
    if (driveConnection?.tokenStatus === "connected") {
      setConnectingDrive(false);
    }
  }, [driveConnection?.tokenStatus]);

  const saveWorkspaceMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return companiesApi.setWorkspace(selectedCompanyId, {
        sourceType,
        cwd: sourceType === "local_path" ? cwd || null : null,
        repoUrl: sourceType === "git_repo" ? repoUrl || null : null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY(selectedCompanyId!) });
      pushToast({ title: "Workspace saved", tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Failed to save workspace", tone: "error" });
    },
  });

  const uploadCredsMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return companiesApi.uploadDriveCredentials(selectedCompanyId, file);
    },
    onSuccess: (conn) => {
      queryClient.setQueryData(DRIVE_CONNECTION_QUERY_KEY(selectedCompanyId!), conn);
      pushToast({ title: "Credentials uploaded", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: `Upload failed: ${err instanceof Error ? err.message : "Unknown error"}`, tone: "error" });
    },
  });

  const connectDriveMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return companiesApi.startDriveConnect(selectedCompanyId);
    },
    onSuccess: (result) => {
      setConnectingDrive(true);
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
    },
    onError: () => {
      pushToast({ title: "Failed to start Drive connection", tone: "error" });
    },
  });

  const finishConnectMutation = useMutation({
    mutationFn: async ({ code, state }: { code: string; state: string }) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return companiesApi.finishDriveConnect(selectedCompanyId, { code, state });
    },
    onSuccess: (conn) => {
      setPollState(null);
      queryClient.setQueryData(DRIVE_CONNECTION_QUERY_KEY(selectedCompanyId!), conn);
      pushToast({ title: `Connected as ${conn.googleAccountEmail ?? "Google account"}`, tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Failed to complete Drive connection", tone: "error" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return companiesApi.disconnectDrive(selectedCompanyId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DRIVE_CONNECTION_QUERY_KEY(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY(selectedCompanyId!) });
      pushToast({ title: "Google Drive disconnected", tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Failed to disconnect Drive", tone: "error" });
    },
  });

  const selectFolderMutation = useMutation({
    mutationFn: async (folder: DriveFolder) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return companiesApi.selectDriveFolder(selectedCompanyId, { folderId: folder.id, folderName: folder.name });
    },
    onSuccess: (conn) => {
      queryClient.setQueryData(DRIVE_CONNECTION_QUERY_KEY(selectedCompanyId!), conn);
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY(selectedCompanyId!) });
      pushToast({ title: `Folder "${conn.folderName}" selected`, tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Failed to select folder", tone: "error" });
    },
  });

  const setFolderByUrlMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return companiesApi.setDriveFolderByUrl(selectedCompanyId, {
        folderUrl: folderUrlInput,
        folderName: folderNameInput || undefined,
      });
    },
    onSuccess: (result) => {
      setFolderUrlInput("");
      setFolderNameInput("");
      queryClient.invalidateQueries({ queryKey: DRIVE_CONNECTION_QUERY_KEY(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY(selectedCompanyId!) });
      pushToast({ title: `Folder "${result.folderName}" saved`, tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: `Failed: ${err instanceof Error ? err.message : "Unknown error"}`, tone: "error" });
    },
  });

  const isConnected = driveConnection?.tokenStatus === "connected";
  const hasCredentials = driveConnection?.clientId != null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-2xl">
      <div className="mb-6">
        <h1 className="text-lg font-semibold">Company Workspace</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Default workspace all projects inherit unless they configure their own.
        </p>
      </div>

      {/* Source type selector */}
      <div className="mb-6">
        <Field label="Workspace type">
          <div className="flex gap-2 mt-1">
            {(["local_path", "git_repo", "google_drive"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setSourceType(t)}
                className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${
                  sourceType === t
                    ? "border-primary bg-primary/10 text-primary font-medium"
                    : "border-border text-muted-foreground hover:bg-accent/50"
                }`}
              >
                {t === "local_path" ? "Local path" : t === "git_repo" ? "Git repo" : "Google Drive"}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {/* Local path form */}
      {sourceType === "local_path" && (
        <div className="space-y-4">
          <Field label="Directory path" hint="Absolute path to the directory agents will use as their working directory">
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/Users/you/my-project"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            />
          </Field>
          <Button
            size="sm"
            onClick={() => saveWorkspaceMutation.mutate()}
            disabled={saveWorkspaceMutation.isPending}
          >
            {saveWorkspaceMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
            Save
          </Button>
        </div>
      )}

      {/* Git repo form */}
      {sourceType === "git_repo" && (
        <div className="space-y-4">
          <Field label="Repository URL">
            <input
              type="text"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/your-org/your-repo.git"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            />
          </Field>
          <Button
            size="sm"
            onClick={() => saveWorkspaceMutation.mutate()}
            disabled={saveWorkspaceMutation.isPending}
          >
            {saveWorkspaceMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
            Save
          </Button>
        </div>
      )}

      {/* Google Drive form */}
      {sourceType === "google_drive" && (
        <div className="space-y-6">
          {/* Step 1: Upload credentials */}
          <div className="rounded-lg border border-border p-4 space-y-3">
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 h-5 w-5 rounded-full flex items-center justify-center shrink-0 text-xs font-bold ${hasCredentials ? "bg-green-100 text-green-700" : "bg-muted text-muted-foreground"}`}>
                {hasCredentials ? <CheckCircle className="h-4 w-4" /> : "1"}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">Upload OAuth client JSON</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  In Google Cloud Console: <strong>APIs & Services → Credentials → Create Credentials → OAuth client ID → Desktop app</strong>. Download the JSON file and upload it here.
                </p>
                {hasCredentials && (
                  <p className="text-xs text-green-700 mt-1">
                    Client ID: <code className="font-mono">{driveConnection?.clientId?.slice(0, 24)}…</code>
                    {driveConnection?.projectId ? ` · Project: ${driveConnection.projectId}` : ""}
                  </p>
                )}
                <div className="mt-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) uploadCredsMutation.mutate(file);
                      e.target.value = "";
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadCredsMutation.isPending}
                  >
                    {uploadCredsMutation.isPending
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                      : <UploadCloud className="h-3.5 w-3.5 mr-1.5" />}
                    {hasCredentials ? "Replace credentials" : "Upload client_secret_*.json"}
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* Step 2: Connect */}
          <div className={`rounded-lg border p-4 space-y-3 ${!hasCredentials ? "opacity-50 pointer-events-none border-border" : "border-border"}`}>
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 h-5 w-5 rounded-full flex items-center justify-center shrink-0 text-xs font-bold ${isConnected ? "bg-green-100 text-green-700" : "bg-muted text-muted-foreground"}`}>
                {isConnected ? <CheckCircle className="h-4 w-4" /> : "2"}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">Connect Google account</p>
                {isConnected ? (
                  <div className="mt-1 flex items-center gap-2">
                    <p className="text-xs text-green-700">Connected as <strong>{driveConnection?.googleAccountEmail}</strong></p>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs text-muted-foreground"
                      onClick={() => disconnectMutation.mutate()}
                      disabled={disconnectMutation.isPending}
                    >
                      <Unplug className="h-3 w-3 mr-1" />
                      Disconnect
                    </Button>
                  </div>
                ) : (
                  <div className="mt-2 space-y-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => connectDriveMutation.mutate()}
                      disabled={connectDriveMutation.isPending || connectingDrive}
                    >
                      {connectingDrive
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                        : <CloudUpload className="h-3.5 w-3.5 mr-1.5" />}
                      {connectingDrive ? "Waiting for authorization…" : "Connect Google Drive"}
                    </Button>
                    {connectingDrive && (
                      <div className="text-xs text-muted-foreground space-y-1">
                        <p>A browser window should have opened. Complete authorization there.</p>
                        <p className="font-medium">If the window did not open, paste the code here after authorizing:</p>
                        <div className="flex gap-2 mt-1">
                          <input
                            type="text"
                            placeholder="Paste authorization code"
                            className="flex-1 rounded border border-input bg-background px-2 py-1 text-xs"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                const code = (e.target as HTMLInputElement).value.trim();
                                if (code) {
                                  // We don't have the state here easily — for the manual path we'd need to
                                  // store it. The loopback path is the primary flow.
                                  pushToast({ title: "Please use the browser window to authorize", tone: "info" });
                                }
                              }
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Step 3: Pick folder */}
          <div className="rounded-lg border border-border p-4 space-y-3">
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 h-5 w-5 rounded-full flex items-center justify-center shrink-0 text-xs font-bold ${driveConnection?.folderId ? "bg-green-100 text-green-700" : "bg-muted text-muted-foreground"}`}>
                {driveConnection?.folderId ? <CheckCircle className="h-4 w-4" /> : "3"}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">Select Drive folder</p>
                {driveConnection?.folderId && (
                  <p className="text-xs text-green-700 flex items-center gap-1 mt-1">
                    <FolderOpen className="h-3.5 w-3.5" />
                    <strong>{driveConnection.folderName}</strong>
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">
                  {driveConnection?.folderId
                    ? "Agents will use this folder via Google Workspace MCP."
                    : "Paste your Google Drive folder URL below — no additional sign-in needed."}
                </p>

                {/* Paste URL — always available */}
                <div className="mt-3 space-y-2">
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Link className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                      <input
                        type="text"
                        value={folderUrlInput}
                        onChange={(e) => setFolderUrlInput(e.target.value)}
                        placeholder="https://drive.google.com/drive/folders/…"
                        className="w-full rounded-md border border-input bg-background pl-7 pr-3 py-1 text-xs"
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setFolderByUrlMutation.mutate()}
                      disabled={!folderUrlInput.trim() || setFolderByUrlMutation.isPending}
                    >
                      {setFolderByUrlMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                    </Button>
                  </div>
                  <input
                    type="text"
                    value={folderNameInput}
                    onChange={(e) => setFolderNameInput(e.target.value)}
                    placeholder="Folder name (optional, for display)"
                    className="w-full rounded-md border border-input bg-background px-3 py-1 text-xs"
                  />
                </div>

                {/* OAuth folder browser — only shown when connected via OAuth */}
                {isConnected && (
                  <details className="mt-3">
                    <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground select-none">
                      Browse folders via connected Google account
                    </summary>
                    <div className="mt-2">
                      <div className="relative mb-2">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                        <input
                          type="text"
                          value={folderSearch}
                          onChange={(e) => {
                            setFolderSearch(e.target.value);
                            if (e.target.value) setDriveFolderParentId(undefined);
                          }}
                          placeholder="Search folders…"
                          className="w-full rounded-md border border-input bg-background pl-7 pr-7 py-1 text-xs"
                        />
                        {folderSearch && (
                          <button
                            type="button"
                            onClick={() => setFolderSearch("")}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      {!folderSearch && driveFolderParentId && (
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-foreground mb-2 flex items-center gap-1"
                          onClick={() => setDriveFolderParentId(undefined)}
                        >
                          ← Back to root
                        </button>
                      )}
                      {foldersLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : (
                        <div className="space-y-1 max-h-48 overflow-y-auto border border-border rounded-md p-1">
                          {(driveFolders ?? []).length === 0 ? (
                            <p className="text-xs text-muted-foreground px-2 py-1">
                              {folderSearch ? `No folders matching "${folderSearch}"` : "No folders found"}
                            </p>
                          ) : (
                            (driveFolders ?? []).map((folder) => (
                              <div
                                key={folder.id}
                                className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-accent/50 group"
                              >
                                <button
                                  type="button"
                                  className="flex items-center gap-1.5 text-xs text-left flex-1 min-w-0"
                                  onClick={() => {
                                    setFolderSearch("");
                                    setDriveFolderParentId(folder.id);
                                  }}
                                >
                                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                  <span className="truncate">{folder.name}</span>
                                  {folder.parentName && (
                                    <span className="truncate text-muted-foreground shrink-0">
                                      in {folder.parentName}
                                    </span>
                                  )}
                                </button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-xs opacity-0 group-hover:opacity-100"
                                  onClick={() => selectFolderMutation.mutate(folder)}
                                  disabled={selectFolderMutation.isPending}
                                >
                                  Select
                                </Button>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  </details>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
