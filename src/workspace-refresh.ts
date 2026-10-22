import { syncWorkspaceMetadata } from "./sidebar.ts";

const workspaceId = process.env.HERDR_WORKSPACE_ID;
if (workspaceId) {
  try {
    await syncWorkspaceMetadata(workspaceId);
  } catch {
    // Workspace cleanup is best effort and must not affect Herdr event delivery.
  }
}
