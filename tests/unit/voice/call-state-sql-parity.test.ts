import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CALL_DISPOSITIONS, CALL_END_REASONS, CALL_EVENT_TYPES, CALL_STATES } from "@halo/core/domain/voice";
import { callTransitionTable } from "@halo/voice/call-state";

const sql = readFileSync(path.resolve(__dirname, "../../../supabase/migrations/0020_voice_calls.sql"), "utf8");

function quotedList(fragment: string): string[] {
  return [...fragment.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
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
    const typeStart = sql.indexOf("type        text not null check");
    expect(quotedList(sql.slice(typeStart, sql.indexOf("))", typeStart))).sort()).toEqual([...CALL_EVENT_TYPES].sort());
  });
});
