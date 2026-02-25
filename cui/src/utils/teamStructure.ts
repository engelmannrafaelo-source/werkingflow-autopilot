export interface TeamNode {
  id: string;
  name: string;
  role: string;
  children: TeamNode[];
}

export interface RACIEntry {
  task: string;
  owner: string;
  responsible: string[];
  approver: string[];
  consulted: string[];
}

export interface TeamStructure {
  orgChart: TeamNode[];
  raciMatrix: RACIEntry[];
  personas: Array<{
    id: string;
    name: string;
    role: string;
    reportsTo?: string;
    team?: string;
    department?: string;
  }>;
}

/**
 * Build hierarchical org chart from personas
 */
export function buildOrgChart(personas: Array<{ id: string; name: string; role: string; reportsTo?: string }>): TeamNode[] {
  const nodeMap = new Map<string, TeamNode>();

  // Create nodes
  personas.forEach(p => {
    nodeMap.set(p.id, {
      id: p.id,
      name: p.name,
      role: p.role,
      children: []
    });
  });

  // Build tree
  const roots: TeamNode[] = [];
  personas.forEach(p => {
    const node = nodeMap.get(p.id)!;
    if (p.reportsTo) {
      const parent = nodeMap.get(p.reportsTo.toLowerCase().replace(/\s+/g, '-'));
      if (parent) {
        parent.children.push(node);
      } else {
        // Parent not found, treat as root
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  });

  return roots;
}

/**
 * Build RACI matrix from persona responsibilities and collaboration
 */
export function buildRACIMatrix(personas: Array<{
  id: string;
  name: string;
  responsibilities: string[];
  collaboration: Array<{ person: string; reason: string }>;
}>): RACIEntry[] {
  const matrix: RACIEntry[] = [];
  const taskMap = new Map<string, RACIEntry>();

  // Extract tasks from responsibilities
  personas.forEach(p => {
    p.responsibilities.forEach(resp => {
      // Parse "Task: Description" format
      const [task] = resp.split(':');
      const taskKey = task.trim().toLowerCase();

      if (!taskMap.has(taskKey)) {
        taskMap.set(taskKey, {
          task: task.trim(),
          owner: p.name,
          responsible: [],
          approver: [],
          consulted: []
        });
      }

      const entry = taskMap.get(taskKey)!;
      if (!entry.responsible.includes(p.name)) {
        entry.responsible.push(p.name);
      }
    });

    // Parse collaboration for consulted/approver roles
    p.collaboration.forEach(collab => {
      const reason = collab.reason.toLowerCase();

      // Try to find matching task
      taskMap.forEach((entry, taskKey) => {
        if (reason.includes(taskKey) || taskKey.includes(reason.split(' ')[0])) {
          if (reason.includes('approval') || reason.includes('approve')) {
            if (!entry.approver.includes(collab.person)) {
              entry.approver.push(collab.person);
            }
          } else {
            if (!entry.consulted.includes(collab.person)) {
              entry.consulted.push(collab.person);
            }
          }
        }
      });
    });
  });

  return Array.from(taskMap.values());
}
