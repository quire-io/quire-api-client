import { describe, it, expect, vi } from "vitest";
import { evaluateFormula, evaluateTaskFormulaFields, flattenTaskTree, parseExportJson } from "../formula.js";
import { loadProjectTasksForFormula } from "../formula-loader.js";
import type { FormulaContext } from "../formula.js";
import type { QuireTask, QuireTaskNode, QuireFieldDefinition } from "../types.js";
import type { QuireClient } from "../client.js";

// ---------------------------------------------------------------------------
// Minimal task factory
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<QuireTask> & { id: number; oid: string }): QuireTask {
  return {
    name: "Task " + overrides.id,
    status: { value: 0, name: "To-do" },
    priority: { value: 0, name: "Medium" },
    tags: [],
    assignees: [],
    timelogs: [],
    attachments: [],
    comments: [],
    ...overrides,
  };
}

const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);

// ---------------------------------------------------------------------------
// Lexer / parser basics
// ---------------------------------------------------------------------------

describe("literals", () => {
  const ctx: FormulaContext = {
    task: makeTask({ id: 1, oid: "a" }),
    projectTasks: [],
  };

  it("numbers", () => {
    expect(evaluateFormula("42", ctx)).toBe(42);
    expect(evaluateFormula("3.14", ctx)).toBe(3.14);
  });

  it("strings", () => {
    expect(evaluateFormula('"hello"', ctx)).toBe("hello");
    expect(evaluateFormula("'world'", ctx)).toBe("world");
  });

  it("booleans and null", () => {
    expect(evaluateFormula("true", ctx)).toBe(true);
    expect(evaluateFormula("false", ctx)).toBe(false);
    expect(evaluateFormula("null", ctx)).toBe(null);
  });

  it("date <today>", () => {
    const v = evaluateFormula("<today>", ctx);
    expect(v).toBeInstanceOf(Date);
    expect((v as Date).getTime()).toBe(TODAY.getTime());
  });
});

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

describe("arithmetic", () => {
  const ctx: FormulaContext = {
    task: makeTask({ id: 1, oid: "a" }),
    projectTasks: [],
  };

  it("basic ops", () => {
    expect(evaluateFormula("2 + 3", ctx)).toBe(5);
    expect(evaluateFormula("10 - 4", ctx)).toBe(6);
    expect(evaluateFormula("3 * 4", ctx)).toBe(12);
    expect(evaluateFormula("10 / 4", ctx)).toBe(2.5);
    expect(evaluateFormula("10 % 3", ctx)).toBe(1);
    expect(evaluateFormula("2 ^ 10", ctx)).toBe(1024);
  });

  it("precedence: * before +", () => {
    expect(evaluateFormula("2 + 3 * 4", ctx)).toBe(14);
  });

  it("unary minus", () => {
    expect(evaluateFormula("-5", ctx)).toBe(-5);
    expect(evaluateFormula("10 + -3", ctx)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------

describe("comparisons", () => {
  const ctx: FormulaContext = {
    task: makeTask({ id: 1, oid: "a" }),
    projectTasks: [],
  };

  it("numeric", () => {
    expect(evaluateFormula("3 < 5", ctx)).toBe(true);
    expect(evaluateFormula("5 < 3", ctx)).toBe(false);
    expect(evaluateFormula("3 = 3", ctx)).toBe(true);
    expect(evaluateFormula("3 != 4", ctx)).toBe(true);
    expect(evaluateFormula("5 >= 5", ctx)).toBe(true);
    expect(evaluateFormula("5 > 5", ctx)).toBe(false);
  });

  it("null = null", () => {
    expect(evaluateFormula("null = null", ctx)).toBe(true);
  });

  it("null comparisons return null", () => {
    expect(evaluateFormula("null >= 5", ctx)).toBe(null);
    expect(evaluateFormula("null < 5", ctx)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Ternary and null-coalescing
// ---------------------------------------------------------------------------

describe("ternary and ??", () => {
  const ctx: FormulaContext = {
    task: makeTask({ id: 1, oid: "a" }),
    projectTasks: [],
  };

  it("ternary true branch", () => {
    expect(evaluateFormula("true ? 1 : 2", ctx)).toBe(1);
  });

  it("ternary false branch", () => {
    expect(evaluateFormula("false ? 1 : 2", ctx)).toBe(2);
  });

  it("ternary chain — right-associative", () => {
    // 0 < 1 ? 10 : 0 < 2 ? 20 : 30  =>  10
    expect(evaluateFormula("0 < 1 ? 10 : 0 < 2 ? 20 : 30", ctx)).toBe(10);
    // false ? 10 : true ? 20 : 30  =>  20
    expect(evaluateFormula("false ? 10 : true ? 20 : 30", ctx)).toBe(20);
  });

  it("null coalescing ?? — returns left when not null", () => {
    expect(evaluateFormula("5 ?? 99", ctx)).toBe(5);
  });

  it("null coalescing ?? — returns right when left is null", () => {
    expect(evaluateFormula("null ?? 99", ctx)).toBe(99);
  });

  it("false ?? fallback returns false (not null)", () => {
    expect(evaluateFormula("false ?? 99", ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Member access and array indexing
// ---------------------------------------------------------------------------

describe("member access and indexing", () => {
  const task = makeTask({
    id: 1, oid: "t1",
    status:   { value: 100, name: "Completed" },
    priority: { value: 1, name: "High" },
    tags: [
      { oid: "tag1", id: "tag1", name: "Venue check", color: "20" },
      { oid: "tag2", id: "tag2", name: "Operations",  color: "44" },
    ],
    assignees: [
      { oid: "u1", id: "brent", name: "Brent" },
      { oid: "u2", id: "zoey",  name: "Zoey"  },
    ],
  });
  const ctx: FormulaContext = { task, projectTasks: [] };

  it("status.name", () => {
    expect(evaluateFormula("status.name", ctx)).toBe("Completed");
  });

  it("status.value", () => {
    expect(evaluateFormula("status.value", ctx)).toBe(100);
  });

  it("priority.name", () => {
    expect(evaluateFormula("priority.name", ctx)).toBe("High");
  });

  it("tags[0].name", () => {
    expect(evaluateFormula("tags[0].name", ctx)).toBe("Venue check");
  });

  it("tags[1].name", () => {
    expect(evaluateFormula("tags[1].name", ctx)).toBe("Operations");
  });

  it("tags[5] out of bounds returns null", () => {
    expect(evaluateFormula("tags[5]", ctx)).toBe(null);
  });

  it("assignees.name — member on array returns list", () => {
    expect(evaluateFormula("assignees.name", ctx)).toEqual(["Brent", "Zoey"]);
  });
});

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

describe("functions", () => {
  const task = makeTask({
    id: 1, oid: "t1",
    assignees: [{ oid: "u1", id: "a", name: "A" }, { oid: "u2", id: "b", name: "B" }],
    tags: [],
  });
  const ctx: FormulaContext = { task, projectTasks: [] };

  it("COUNT(assignees)", () => {
    expect(evaluateFormula("COUNT(assignees)", ctx)).toBe(2);
  });

  it("ISEMPTY(tags) when empty", () => {
    expect(evaluateFormula("ISEMPTY(tags)", ctx)).toBe(true);
  });

  it("ISEMPTY(assignees) when not empty", () => {
    expect(evaluateFormula("ISEMPTY(assignees)", ctx)).toBe(false);
  });

  it("ISNOTEMPTY(assignees)", () => {
    expect(evaluateFormula("ISNOTEMPTY(assignees)", ctx)).toBe(true);
  });

  it("SUM with list literal", () => {
    expect(evaluateFormula("SUM(1, 2, 3)", ctx)).toBe(6);
  });

  it("SUM of empty = null", () => {
    expect(evaluateFormula("SUM(tags)", ctx)).toBe(null);
  });

  it("MAX", () => {
    expect(evaluateFormula("MAX(3, 1, 4, 1, 5)", ctx)).toBe(5);
  });

  it("MIN", () => {
    expect(evaluateFormula("MIN(3, 1, 4)", ctx)).toBe(1);
  });

  it("AVG", () => {
    expect(evaluateFormula("AVG(2, 4, 6)", ctx)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// where operator
// ---------------------------------------------------------------------------

describe("where operator", () => {
  const ctx: FormulaContext = {
    task: makeTask({ id: 1, oid: "t1" }),
    projectTasks: [],
  };

  it("filters a list literal", () => {
    expect(evaluateFormula("[1, 5, 9] where any > 3", ctx)).toEqual([5, 9]);
  });

  it("returns empty for no matches", () => {
    expect(evaluateFormula("[1, 2, 3] where any > 10", ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// in operator
// ---------------------------------------------------------------------------

describe("in operator", () => {
  const ctx: FormulaContext = {
    task: makeTask({ id: 1, oid: "t1" }),
    projectTasks: [],
  };

  it("scalar in list — true", () => {
    expect(evaluateFormula("3 in [1, 3, 5]", ctx)).toBe(true);
  });

  it("scalar in list — false", () => {
    expect(evaluateFormula("7 in [1, 3, 5]", ctx)).toBe(false);
  });

  it("[3, 7] in [1, 5, 3] — false, 7 not found", () => {
    expect(evaluateFormula("[3, 7] in [1, 5, 3]", ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// project.tasks + where cross-task filter
// ---------------------------------------------------------------------------

describe("project.tasks where", () => {
  const tagVenue = { oid: "tVenue", id: "tv", name: "Venue check", color: "20" };
  const tagCater = { oid: "tCater", id: "tc", name: "Catering",    color: "24" };

  const t1 = makeTask({ id: 1, oid: "p1", tags: [tagVenue] });
  const t2 = makeTask({ id: 2, oid: "p2", tags: [tagCater] });
  const t3 = makeTask({ id: 3, oid: "p3", tags: [tagVenue] });
  const t4 = makeTask({ id: 4, oid: "p4", tags: [tagCater] });

  const ctx: FormulaContext = {
    task: t1,
    projectTasks: [t1, t2, t3, t4],
  };

  it("counts tasks with same first tag as current task", () => {
    const result = evaluateFormula(
      "COUNT(project.tasks where tags[0] in any.tags)",
      ctx,
    );
    // t1 and t3 both have Venue check
    expect(result).toBe(2);
  });

  it("counts Catering tasks from t2's perspective", () => {
    const result = evaluateFormula(
      "COUNT(project.tasks where tags[0] in any.tags)",
      { ...ctx, task: t2 },
    );
    expect(result).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Custom field references {Field Name}
// ---------------------------------------------------------------------------

describe("custom field references", () => {
  const fields: Record<string, QuireFieldDefinition> = {
    Score: {
      name: "Score",
      type: "formula",
      formula: 'tags[0].name = "Venue check" ? 40 : 10',
    },
    Ratio: {
      name: "Ratio",
      type: "formula",
      formula: "{Score} / 2",
    },
  };

  const tagVenue = { oid: "tv", id: "tv", name: "Venue check", color: "20" };
  const task = makeTask({ id: 1, oid: "t1", tags: [tagVenue] });
  const ctx: FormulaContext = { task, projectTasks: [], fields };

  it("resolves {Score} formula field", () => {
    expect(evaluateFormula("{Score}", ctx)).toBe(40);
  });

  it("resolves nested {Score} via {Ratio}", () => {
    expect(evaluateFormula("{Ratio}", ctx)).toBe(20);
  });

  it("circular reference returns null, not infinite loop", () => {
    const circular: Record<string, QuireFieldDefinition> = {
      A: { name: "A", type: "formula", formula: "{B}" },
      B: { name: "B", type: "formula", formula: "{A}" },
    };
    const result = evaluateFormula("{A}", { ...ctx, fields: circular });
    expect(result).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Real Quire formulas from the Event Planning project
// ---------------------------------------------------------------------------

describe("Event Planning formulas", () => {
  const tagVenue = { oid: "tVe", id: "tVe", name: "Venue check",       color: "20" };
  const tagCater = { oid: "tCa", id: "tCa", name: "Catering",           color: "24" };
  const tagGuest = { oid: "tGu", id: "tGu", name: "Guests & Invitation", color: "14" };
  const tagProg  = { oid: "tPr", id: "tPr", name: "Program",             color: "32" };
  const tagClient= { oid: "tCl", id: "tCl", name: "Clients & Agenda",    color: "36" };
  const tagOps   = { oid: "tOp", id: "tOp", name: "Operations",          color: "44" };
  const tagMkt   = { oid: "tMk", id: "tMk", name: "Marketing",           color: "10" };

  const assignee = { oid: "u1", id: "brent", name: "Brent" };

  const tagScoreFormula =
    'tags[0].name = "Catering" ? 10: tags[0].name = "Clients & Agenda" ? 20: ' +
    'tags[0].name = "Guests & Invitation" ? 30: tags[0].name = "Marketing" ? 15: ' +
    'tags[0].name = "Operations" ? 20: tags[0].name = "Program" ? 20: ' +
    'tags[0].name = "Venue check" ? 40: 0';

  const benchmarkFormula =
    "ISEMPTY(tags) ? 0: {Tag Score Field}/COUNT(project.tasks where tags[0] in any.tags)";

  const kpiPointFormula =
    "COUNT(assignees) * ((due = null) ?? false ? null: " +
    "status < 100 ? (due < <today>) ? -2: 0: (completedAt < due) ? 1: -1)";

  const fields: Record<string, QuireFieldDefinition> = {
    "Tag Score Field": { name: "Tag Score Field", type: "formula", formula: tagScoreFormula },
    "Benchmark":       { name: "Benchmark",       type: "formula", formula: benchmarkFormula },
    "KPI Point":       { name: "KPI Point",        type: "formula", formula: kpiPointFormula },
    "Task Status":     { name: "Task Status",      type: "formula", formula: "status.name" },
  };

  // Build a minimal project: 7 Venue check, 3 Catering tasks
  const projectTasks: QuireTask[] = [
    makeTask({ id: 1, oid: "t1", tags: [tagVenue], assignees: [assignee],
               status: { value: 100, name: "Completed" }, due: "2025-12-29",
               toggledAt: "2025-09-23T00:00:00Z" } as QuireTask),
    makeTask({ id: 5, oid: "t5", tags: [tagVenue], assignees: [assignee],
               status: { value: 69, name: "Review" },    due: "2025-12-28" } as QuireTask),
    makeTask({ id: 14, oid: "t14", tags: [tagVenue], assignees: [assignee],
               status: { value: 100, name: "Completed" }, due: "2025-09-22",
               toggledAt: "2025-09-23T00:00:00Z" } as QuireTask),
    makeTask({ id: 18, oid: "t18", tags: [tagVenue], assignees: [assignee],
               status: { value: 100, name: "Completed" }, due: "2025-10-01",
               toggledAt: "2025-09-23T00:00:00Z" } as QuireTask),
    makeTask({ id: 19, oid: "t19", tags: [tagVenue], assignees: [assignee],
               status: { value: 0, name: "To-do" }, due: "2025-10-07" } as QuireTask),
    makeTask({ id: 27, oid: "t27", tags: [tagVenue], assignees: [assignee, assignee],
               status: { value: 69, name: "69%" }, due: "2025-11-26" } as QuireTask),
    makeTask({ id: 28, oid: "t28", tags: [tagVenue], assignees: [assignee, assignee],
               status: { value: 100, name: "Completed" }, due: "2025-09-20",
               toggledAt: "2025-09-23T00:00:00Z" } as QuireTask),
    makeTask({ id: 2, oid: "t2", tags: [tagCater], assignees: [assignee],
               status: { value: 100, name: "Completed" }, due: "2025-12-28",
               toggledAt: "2025-09-24T00:00:00Z" } as QuireTask),
    makeTask({ id: 23, oid: "t23", tags: [tagCater], assignees: [assignee],
               status: { value: 101, name: "100%" }, due: "2025-11-06",
               toggledAt: "2025-09-23T00:00:00Z" } as QuireTask),
    makeTask({ id: 31, oid: "t31", tags: [tagCater], assignees: [],
               status: { value: 0, name: "To-do" } } as QuireTask),
  ];

  describe("Tag Score Field", () => {
    it.each([
      [tagVenue, 40], [tagCater, 10], [tagGuest, 30],
      [tagProg, 20],  [tagClient, 20], [tagOps, 20], [tagMkt, 15],
    ])("tag '%s' → %i", (tag, expected) => {
      const task = makeTask({ id: 99, oid: "tx", tags: [tag] });
      const ctx: FormulaContext = { task, projectTasks, fields };
      expect(evaluateFormula(tagScoreFormula, ctx)).toBe(expected);
    });

    it("no tag → 0", () => {
      const task = makeTask({ id: 99, oid: "tx", tags: [] });
      const ctx: FormulaContext = { task, projectTasks, fields };
      expect(evaluateFormula(tagScoreFormula, ctx)).toBe(0);
    });
  });

  describe("Benchmark", () => {
    it("task with Venue check tag (7 tasks) → 40/7 ≈ 5.714", () => {
      const task = projectTasks[0]; // t1, Venue check
      const ctx: FormulaContext = { task, projectTasks, fields };
      const v = evaluateFormula(benchmarkFormula, ctx) as number;
      expect(v).toBeCloseTo(40 / 7, 5);
    });

    it("task with Catering tag (3 tasks) → 10/3 ≈ 3.333", () => {
      const task = projectTasks[7]; // t2, Catering
      const ctx: FormulaContext = { task, projectTasks, fields };
      const v = evaluateFormula(benchmarkFormula, ctx) as number;
      expect(v).toBeCloseTo(10 / 3, 5);
    });

    it("task with no tags → 0", () => {
      const task = makeTask({ id: 99, oid: "tx", tags: [] });
      const ctx: FormulaContext = { task, projectTasks, fields };
      expect(evaluateFormula(benchmarkFormula, ctx)).toBe(0);
    });
  });

  describe("KPI Point", () => {
    it("completed on time: 1 assignee, due future, completedAt before due → 1", () => {
      // t1: status=100, due=2025-12-29, toggledAt=2025-09-23
      const task = projectTasks[0];
      const ctx: FormulaContext = { task, projectTasks, fields };
      expect(evaluateFormula(kpiPointFormula, ctx)).toBe(1);
    });

    it("completed late: due=2025-09-22, toggledAt=2025-09-23 → -1", () => {
      // t14: status=100, due=2025-09-22, toggledAt=2025-09-23 (after due)
      const task = projectTasks[2];
      const ctx: FormulaContext = { task, projectTasks, fields };
      expect(evaluateFormula(kpiPointFormula, ctx)).toBe(-1);
    });

    it("active and overdue: status < 100, due in past → -2", () => {
      // t19: status=0, due=2025-10-07 (past)
      const task = projectTasks[4];
      const ctx: FormulaContext = { task, projectTasks, fields };
      expect(evaluateFormula(kpiPointFormula, ctx)).toBe(-2);
    });

    it("no due date → null", () => {
      // t31: no due, status=0
      const task = projectTasks[9];
      const ctx: FormulaContext = { task, projectTasks, fields };
      expect(evaluateFormula(kpiPointFormula, ctx)).toBe(null);
    });
  });

  describe("Task Status", () => {
    it("returns status name", () => {
      const task = projectTasks[0]; // Completed
      const ctx: FormulaContext = { task, projectTasks, fields };
      expect(evaluateFormula("status.name", ctx)).toBe("Completed");
    });
  });

  describe("evaluateTaskFormulaFields (all at once)", () => {
    it("computes all formula fields on a Venue check task", () => {
      const task = projectTasks[0]; // t1: Venue check, Completed, 1 assignee
      const out = evaluateTaskFormulaFields(task, projectTasks, fields);
      expect(out["Task Status"]).toBe("Completed");
      expect(out["Tag Score Field"]).toBe(40);
      expect(out["Benchmark"] as number).toBeCloseTo(40 / 7, 5);
      expect(out["KPI Point"]).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// flattenTaskTree
// ---------------------------------------------------------------------------

describe("flattenTaskTree", () => {
  it("returns empty array for empty input", () => {
    expect(flattenTaskTree([])).toEqual([]);
  });

  it("flattens a single root task with no children", () => {
    const node: QuireTaskNode = makeTask({ id: 1, oid: "a" });
    expect(flattenTaskTree([node])).toHaveLength(1);
    expect(flattenTaskTree([node])[0].oid).toBe("a");
  });

  it("flattens nested tasks depth-first", () => {
    const child: QuireTaskNode = makeTask({ id: 2, oid: "b" });
    const grandchild: QuireTaskNode = makeTask({ id: 3, oid: "c" });
    child.tasks = [grandchild];
    const root: QuireTaskNode = { ...makeTask({ id: 1, oid: "a" }), tasks: [child] };
    const flat = flattenTaskTree([root]);
    expect(flat.map((t) => t.oid)).toEqual(["a", "b", "c"]);
  });

  it("strips the tasks property from the output", () => {
    const child: QuireTaskNode = makeTask({ id: 2, oid: "b" });
    const root: QuireTaskNode = { ...makeTask({ id: 1, oid: "a" }), tasks: [child] };
    const flat = flattenTaskTree([root]);
    expect("tasks" in flat[0]).toBe(false);
  });

  it("handles multiple root tasks", () => {
    const nodes: QuireTaskNode[] = [
      makeTask({ id: 1, oid: "a" }),
      makeTask({ id: 2, oid: "b" }),
    ];
    expect(flattenTaskTree(nodes).map((t) => t.oid)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// parseExportJson
// ---------------------------------------------------------------------------

describe("parseExportJson", () => {
  it("parses an array-at-root export", () => {
    const nodes: QuireTaskNode[] = [makeTask({ id: 1, oid: "x" })];
    const result = parseExportJson(JSON.stringify(nodes));
    expect(result).toHaveLength(1);
    expect(result[0].oid).toBe("x");
  });

  it("parses an object-with-tasks export", () => {
    const payload = {
      name: "My Project",
      tasks: [
        makeTask({ id: 1, oid: "x" }),
        makeTask({ id: 2, oid: "y" }),
      ],
    };
    const result = parseExportJson(JSON.stringify(payload));
    expect(result.map((t) => t.oid)).toEqual(["x", "y"]);
  });

  it("flattens nested subtasks within an export", () => {
    const child: QuireTaskNode = makeTask({ id: 2, oid: "child" });
    const root: QuireTaskNode = { ...makeTask({ id: 1, oid: "root" }), tasks: [child] };
    const result = parseExportJson(JSON.stringify([root]));
    expect(result.map((t) => t.oid)).toEqual(["root", "child"]);
  });

  it("handles empty tasks array in object export", () => {
    expect(parseExportJson(JSON.stringify({ name: "P", tasks: [] }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadProjectTasksForFormula
// ---------------------------------------------------------------------------

describe("loadProjectTasksForFormula", () => {
  function makeClient(overrides: Partial<QuireClient>): QuireClient {
    return overrides as unknown as QuireClient;
  }

  it("returns export data when exportProjectJson succeeds", async () => {
    const tasks: QuireTaskNode[] = [makeTask({ id: 1, oid: "t1" })];
    const client = makeClient({
      exportProjectJson: vi.fn().mockResolvedValue(JSON.stringify(tasks)),
    });
    const result = await loadProjectTasksForFormula(client, "proj-oid");
    expect(result.via).toBe("export");
    expect(result.tasks[0].oid).toBe("t1");
  });

  it("falls back to listTasks when exportProjectJson throws (plan gate)", async () => {
    const fallbackTasks: QuireTask[] = [makeTask({ id: 1, oid: "t1" })];
    const client = makeClient({
      exportProjectJson: vi.fn().mockRejectedValue(new Error("403 ecQuotaExceeded")),
      listTasks: vi.fn().mockResolvedValue(fallbackTasks),
    });
    const result = await loadProjectTasksForFormula(client, "proj-oid");
    expect(result.via).toBe("list");
    expect(result.tasks[0].oid).toBe("t1");
    expect(client.listTasks).toHaveBeenCalledWith("proj-oid", { limit: "no" });
  });

  it("flattens nested subtasks from export JSON", async () => {
    const child: QuireTaskNode = makeTask({ id: 2, oid: "c" });
    const root: QuireTaskNode = { ...makeTask({ id: 1, oid: "r" }), tasks: [child] };
    const client = makeClient({
      exportProjectJson: vi.fn().mockResolvedValue(JSON.stringify([root])),
    });
    const result = await loadProjectTasksForFormula(client, "proj-oid");
    expect(result.via).toBe("export");
    expect(result.tasks.map((t) => t.oid)).toEqual(["r", "c"]);
  });
});

// ---------------------------------------------------------------------------
// Dart-parity: null semantics (ref: formula_eval_test.dart #17707)
// ---------------------------------------------------------------------------

describe("null semantics", () => {
  const ctx: FormulaContext = { task: makeTask({ id: 1, oid: "a" }), projectTasks: [] };
  const ev = (f: string) => evaluateFormula(f, ctx);

  it("null = null → true; null != null → false", () => {
    expect(ev("null = null")).toBe(true);
    expect(ev("null != null")).toBe(false);
  });

  it("null > null → null (not false)", () => {
    expect(ev("null > null")).toBeNull();
  });

  it("null >= null → null (not true)", () => {
    expect(ev("null >= null")).toBeNull();
  });

  it("null > 0 → null; null >= 0 → null", () => {
    expect(ev("null > 0")).toBeNull();
    expect(ev("null >= 0")).toBeNull();
  });

  it("null = 0 → false (#23179)", () => {
    expect(ev("null = 0")).toBe(false);
  });

  it("null ? 1: 2 → null (#17707)", () => {
    expect(ev("null ? 1: 2")).toBeNull();
  });

  it("0 > null ? 1: 2 → null (condition is null)", () => {
    expect(ev("0 > null ? 1: 2")).toBeNull();
  });

  it("array ternary: [true, null, false] ? [1, 2, 3]: 9 → [1, null, 9]", () => {
    expect(ev("[1 = 1, null, 1 = 2] ? [1, 2, 3]: 9")).toEqual([1, null, 9]);
  });

  it("string + null → string; null + string → string", () => {
    expect(ev('"hello" + null')).toBe("hello");
    expect(ev('null + "hello"')).toBe("hello");
  });

  it("string - null → string (keep original)", () => {
    expect(ev('"what is this" - null')).toBe("what is this");
  });

  it("string * null → '' (empty string)", () => {
    expect(ev('"abc" * null')).toBe("");
  });

  it("null - null → null; null * 6 → null", () => {
    expect(ev("null - null")).toBeNull();
    expect(ev("null * 6")).toBeNull();
  });

  it("null+3+'x' chain: null+3 → null, null+'x' → 'x'", () => {
    expect(ev('null + 3 + "x"')).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// Dart-parity: string arithmetic
// ---------------------------------------------------------------------------

describe("string arithmetic", () => {
  const ctx: FormulaContext = { task: makeTask({ id: 1, oid: "a" }), projectTasks: [] };
  const ev = (f: string) => evaluateFormula(f, ctx);

  it("implicit concatenation: 'ab' 'cd' => 'abcd'", () => {
    expect(ev('"this is " "great!"')).toBe("this is great!");
  });

  it("str - str removes prefix", () => {
    expect(ev('"what is this" - "what"')).toBe(" is this");
    expect(ev('"what is this" - "whats"')).toBe("what is this"); // not a prefix → unchanged
  });

  it("str - N removes last N chars", () => {
    expect(ev('"what is this" - 3')).toBe("what is t");
    expect(ev('"abc" - 0')).toBe("abc");
  });

  it("str * N repeats string", () => {
    expect(ev('"abc" * 2')).toBe("abcabc");
    expect(ev('"abc" * 0')).toBe("");
    expect(ev('"abc" * false')).toBe(""); // false == 0
  });

  it("N * str repeats string", () => {
    expect(ev('2 * "ab"')).toBe("abab");
  });

  it("negative * str → ''", () => {
    expect(ev('-1 * "abc"')).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Dart-parity: COUNT / DISTINCT / SORT null semantics
// ---------------------------------------------------------------------------

describe("COUNT null semantics", () => {
  const ctx: FormulaContext = { task: makeTask({ id: 1, oid: "a" }), projectTasks: [] };
  const ev = (f: string) => evaluateFormula(f, ctx);

  it("count() → null", () => { expect(ev("count()")).toBeNull(); });
  it("count(null) → null", () => { expect(ev("count(null)")).toBeNull(); });
  it("count([]) → 0", () => { expect(ev("count([])")).toBe(0); });
  it("count([null]) → 0 (count non-null items)", () => { expect(ev("count([null])")).toBe(0); });
  it("count('abc') → 1", () => { expect(ev('count("abc")')).toBe(1); });
  it("count multi-arg flattens and counts non-null", () => {
    // ["abc", 3, null, 3] null ["def"] "foo" → non-null: abc,3,3,def,foo = 5
    expect(ev('count(["abc", 3, null, 3], null, ["def"], "foo")')).toBe(5);
  });
});

describe("DISTINCT null semantics", () => {
  const ctx: FormulaContext = { task: makeTask({ id: 1, oid: "a" }), projectTasks: [] };
  const ev = (f: string) => evaluateFormula(f, ctx);

  it("distinct() → null", () => { expect(ev("distinct()")).toBeNull(); });
  it("distinct(null) → null", () => { expect(ev("distinct(null)")).toBeNull(); });
  it("distinct([]) → []", () => { expect(ev("distinct([])")).toEqual([]); });
  it("distinct('abc') → ['abc']", () => { expect(ev('distinct("abc")')).toEqual(["abc"]); });
  it("distinct removes nulls and deduplicates", () => {
    expect(ev('distinct(["abc", 3, 3], null, ["abc", null, "foo"], "foo")')).toEqual(["abc", 3, "foo"]);
  });
});

describe("SORT null semantics", () => {
  const ctx: FormulaContext = { task: makeTask({ id: 1, oid: "a" }), projectTasks: [] };
  const ev = (f: string) => evaluateFormula(f, ctx);

  it("sort() → null", () => { expect(ev("sort()")).toBeNull(); });
  it("sort(null) → null", () => { expect(ev("sort(null)")).toBeNull(); });
  it("sort removes nulls from output", () => {
    expect(ev("sort([5, 3, null, 9], 1, 5, [4])")).toEqual([1, 3, 4, 5, 5, 9]);
  });
});

// ---------------------------------------------------------------------------
// Dart-parity: where scalar + array-condition truthiness
// ---------------------------------------------------------------------------

describe("where semantics", () => {
  const ctx: FormulaContext = { task: makeTask({ id: 1, oid: "a" }), projectTasks: [] };
  const ev = (f: string) => evaluateFormula(f, ctx);

  it("scalar where passes → scalar", () => {
    expect(ev("5 where any >= 5")).toBe(5);
  });

  it("scalar where fails → null", () => {
    expect(ev("5 where any > 5")).toBeNull();
  });

  it("[1,2,3] where [false] → [] (array condition: any item truthy)", () => {
    expect(ev("[1, 2, 3] where [false]")).toEqual([]);
  });

  it("[1,2,3] where [true, false] → [1,2,3] (any item is true)", () => {
    expect(ev("[1, 2, 3] where [1 = 1, 1 = 2]")).toEqual([1, 2, 3]);
  });
});
