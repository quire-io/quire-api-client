import type { QuireClient } from "./client.js";
import type { QuireTask } from "./types.js";
import { parseExportJson } from "./formula.js";

export interface FormulaTasksResult {
  tasks: QuireTask[];
  /**
   * "export" — full project export, all tasks and subtasks present (paid plan only).
   * "list"   — flat task list endpoint, all tasks present but returned without
   *            subtree nesting; suitable for formulas but subtask hierarchy
   *            information is absent (used when export is unavailable).
   */
  via: "export" | "list";
}

/**
 * Load all tasks in a project for client-side formula evaluation.
 *
 * Strategy:
 *   1. Try GET /project/export-json/{projectOid} (paid plan only, full data).
 *   2. On any failure (plan gate 402/403, network error, etc.) fall back to
 *      GET /task/list/{projectOid}?limit=no which works on all plan tiers and
 *      returns every task flat.
 *
 * Callers can inspect `via` to decide whether to surface a warning when
 * the export endpoint was unavailable (typically a free-plan user).
 */
export async function loadProjectTasksForFormula(
  client: QuireClient,
  projectOid: string,
): Promise<FormulaTasksResult> {
  try {
    const raw = await client.exportProjectJson(projectOid);
    return { tasks: parseExportJson(raw), via: "export" };
  } catch {
    // Plan gate (402/403) or any other error — fall back to flat list.
    const tasks = await client.listTasks(projectOid, { limit: "no" });
    return { tasks, via: "list" };
  }
}
