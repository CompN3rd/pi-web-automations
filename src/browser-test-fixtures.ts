import type { WorkspacePanelContextV5 } from "@jmfederico/pi-web/plugin-api";

/** Captured machine catalog with an empty workspace in another registered project. */
export function catalogFixture(machineId = "local"): WorkspacePanelContextV5["catalog"] {
  const projects = [{ id: "project-1", name: "Current project", path: "/repo" }, { id: "project-empty", name: "Empty project", path: "/empty" }];
  const workspaces = [
    { id: "workspace-1", projectId: "project-1", path: "/repo", label: "main", isMain: true },
    { id: "workspace-empty", projectId: "project-empty", path: "/empty", label: "Empty workspace", isMain: true },
  ];
  return {
    version: 1, machineId,
    projects: { list: () => Promise.resolve(projects), get: (id) => Promise.resolve(required(projects.find((project) => project.id === id))) },
    workspaces: { list: (id) => Promise.resolve(workspaces.filter((workspace) => workspace.projectId === id)), get: (selection) => Promise.resolve(required(workspaces.find((workspace) => workspace.id === selection.workspaceId))) },
    sessions: { list: () => Promise.resolve([]), get: () => Promise.reject(new Error("unused")) },
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Unknown fixture ID");
  return value;
}

export const managementSuccess = { machine: { id: "local", name: "Backend", scope: "backend machine" }, project: { id: "project-1" }, workspace: { id: "workspace-1" }, message: "Saved" };
