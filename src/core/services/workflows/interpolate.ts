import type { BusinessEvent, WorkflowCondition } from "@/core/domain/workflow";

/**
 * Pure helpers for the workflow engine: {{path}} template interpolation and
 * condition evaluation against a business event. No IO, fully unit-tested.
 */

/** Resolves a dot path ("payload.visitorName") against an object. */
export function resolvePath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const TEMPLATE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Interpolates {{event.…}} placeholders in a string. A string that is
 * exactly one placeholder resolves to the raw value (so numbers/booleans
 * survive); anything else becomes a string with values stringified.
 */
export function interpolateString(template: string, event: BusinessEvent): unknown {
  const scope = { event };
  const exact = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(template);
  if (exact) {
    const value = resolvePath(scope, exact[1]);
    return value === undefined ? "" : value;
  }
  return template.replace(TEMPLATE_RE, (_match, path: string) => {
    const value = resolvePath(scope, path);
    if (value === undefined || value === null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

/** Deep-interpolates every string value in an action's params. */
export function interpolateParams(
  params: Record<string, unknown>,
  event: BusinessEvent,
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return interpolateString(value, event);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
      );
    }
    return value;
  };
  return walk(params) as Record<string, unknown>;
}

/** All conditions must hold (AND semantics). Paths resolve inside the event. */
export function eventMatches(event: BusinessEvent, conditions: WorkflowCondition[]): boolean {
  return conditions.every((condition) => {
    const actual = resolvePath(event, condition.path);
    switch (condition.op) {
      case "exists":
        return actual !== undefined && actual !== null && actual !== "";
      case "not_exists":
        return actual === undefined || actual === null || actual === "";
      case "eq":
        return actual === condition.value;
      case "neq":
        return actual !== condition.value;
      case "contains":
        return (
          typeof actual === "string" &&
          typeof condition.value === "string" &&
          actual.toLowerCase().includes(condition.value.toLowerCase())
        );
      case "gt":
        return typeof actual === "number" && typeof condition.value === "number"
          ? actual > condition.value
          : false;
      case "lt":
        return typeof actual === "number" && typeof condition.value === "number"
          ? actual < condition.value
          : false;
    }
  });
}
