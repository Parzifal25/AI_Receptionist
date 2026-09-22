import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CALL_DISPOSITIONS, CALL_END_REASONS, CALL_EVENT_TYPES, CALL_STATES } from "@halo/core/domain/voice";
import { callTransitionTable } from "@halo/voice/call-state";

const migrationsDir = path.resolve(__dirname, "../../../supabase/migrations");
const sql = readFileSync(path.join(migrationsDir, "0020_voice_calls.sql"), "utf8");

function quotedList(fragment: string): string[] {
  return [...fragment.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/**
 * The call-event type set is the one CHECK a later migration is expected to
 * widen (a new latency mark is additive). Parity must therefore be asserted
 * against the EFFECTIVE constraint — 0020's inline list, replaced by the
 * last migration that redefines it — or a widening would silently let the
 * TypeScript set and the database disagree.
 */
function effectiveCallEventTypes(): string[] {
  const inlineStart = sql.indexOf("type        text not null check");
  let effective = quotedList(sql.slice(inlineStart, sql.indexOf("))", inlineStart)));
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(path.join(migrationsDir, file), "utf8");
    const matches = [...text.matchAll(/add constraint call_events_type_check check \(type in([\s\S]*?)\)\)/g)];
    const last = matches[matches.length - 1];
    if (last) effective = quotedList(last[1]);
  }
  return effective;
}

describe("0020 migration ↔ TypeScript voice domain parity", () => {
  it("the trigger's transition graph equals call-state.ts", () => {
    const table = callTransitionTable();
    for (const state of CALL_STATES) {
      const line = sql.split("\n").find((l) => new RegExp(`when '${state}'\\s+then`).test(l));
      const expected = [...table[state]].sort();
      if (expected.length === 0) {
        expect(line, `terminal ${state} must fall through to the empty array`).toBeUndefined();
        continue;
      }
      expect(line, state).toBeDefined();
      expect(quotedList(line!.split("then")[1]).sort(), state).toEqual(expected);
    }
  });

  it("CHECK constraints list exactly the domain values", () => {
    const check = (column: string) => {
      const re = new RegExp(`check \\((?:${column} is null or )?${column} in([\\s\\S]*?)\\)\\)`);
      const match = sql.match(re);
      expect(match, column).not.toBeNull();
      return quotedList(match![1]);
    };
    expect(check("state").sort()).toEqual([...CALL_STATES].sort());
    expect(check("hangup_cause").sort()).toEqual([...CALL_END_REASONS].sort());
    expect(check("disposition").sort()).toEqual([...CALL_DISPOSITIONS].sort());
    expect(effectiveCallEventTypes().sort()).toEqual([...CALL_EVENT_TYPES].sort());
  });
});
