"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BUSINESS_EVENT_TYPES,
  WORKFLOW_ACTION_TYPES,
  type WorkflowActionType,
  type WorkflowDefinition,
  type WorkflowStep,
} from "@/core/domain/workflow";
import type { WorkflowTemplate } from "@/core/services/workflows/templates";

/**
 * The visual workflow builder: a vertical flow — trigger at the top, then
 * action cards connected by arrows — backed by the /api/workflows CRUD.
 */

const TRIGGER_LABELS: Record<string, string> = {
  "appointment.created": "Appointment booked",
  "appointment.rescheduled": "Appointment rescheduled",
  "appointment.cancelled": "Appointment cancelled",
  "appointment.checked_in": "Visitor checked in",
  "appointment.completed": "Appointment completed",
  "appointment.no_show": "Visitor no-show",
  "feedback.received": "Feedback received",
  "lead.created": "Lead captured",
  "lead.updated": "Lead updated",
  "conversation.started": "Conversation started",
  "conversation.archived": "Conversation archived",
  "customer.created": "Customer created",
  "customer.updated": "Customer updated",
  "followup.due": "Scheduled follow-up due",
  "webhook.received": "Inbound webhook",
  manual: "Manual trigger only",
};

const ACTION_LABELS: Record<WorkflowActionType, string> = {
  send_email: "Send email",
  send_sms: "Send SMS",
  send_whatsapp: "Send WhatsApp",
  call_webhook: "Call webhook (Slack, Zapier, …)",
  crm_upsert_customer: "Create/update customer",
  crm_record_timeline: "Add timeline note",
  crm_record_revenue: "Record revenue",
  schedule_followup: "Wait, then continue (timer)",
  track_analytics: "Track analytics event",
  request_review: "Request a review",
  ops_create: "Create ops record (ticket, quote, invoice…)",
};

/** Placeholder params shown when a step's action changes. */
const ACTION_PARAM_HINTS: Record<WorkflowActionType, Record<string, string>> = {
  send_email: { to: "{{event.payload.visitorEmail}}", subject: "", body: "" },
  send_sms: { to: "{{event.payload.visitorPhone}}", body: "" },
  send_whatsapp: { to: "{{event.payload.visitorPhone}}", body: "" },
  call_webhook: { url: "https://…", format: "json", text: "" },
  crm_upsert_customer: { email: "{{event.payload.visitorEmail}}", name: "{{event.payload.visitorName}}", stage: "" },
  crm_record_timeline: { email: "{{event.payload.visitorEmail}}", title: "" },
  crm_record_revenue: { email: "{{event.payload.visitorEmail}}", amount: "" },
  schedule_followup: { delayMinutes: "1440", reason: "follow-up" },
  track_analytics: { name: "" },
  request_review: { to: "{{event.payload.visitorEmail}}", channel: "email", reviewUrl: "https://…" },
  ops_create: { kind: "fsm_ticket", email: "{{event.payload.visitorEmail}}" },
};

interface EditorState {
  id: string | null;
  name: string;
  description: string;
  trigger: string;
  enabled: boolean;
  steps: Array<{ id: string; action: WorkflowActionType; params: Array<[string, string]> }>;
}

function toEditor(workflow: WorkflowDefinition | null): EditorState {
  if (!workflow) {
    return {
      id: null,
      name: "",
      description: "",
      trigger: "appointment.created",
      enabled: true,
      steps: [
        {
          id: "step-1",
          action: "send_email",
          params: Object.entries(ACTION_PARAM_HINTS.send_email),
        },
      ],
    };
  }
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    trigger: workflow.trigger,
    enabled: workflow.enabled,
    steps: workflow.steps.map((step: WorkflowStep) => ({
      id: step.id,
      action: step.action,
      params: Object.entries(step.params).map(([k, v]) => [k, String(v ?? "")] as [string, string]),
    })),
  };
}

async function api(path: string, method: string, body?: unknown): Promise<{ ok: boolean; message: string }> {
  const response = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (response.ok) return { ok: true, message: "" };
  const payload = await response.json().catch(() => null);
  return { ok: false, message: payload?.error?.message ?? `Request failed (${response.status})` };
}

const card =
  "rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const inputCls =
  "w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100";
const btnPrimary =
  "rounded-md bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60";
const btnSecondary =
  "rounded-md bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:opacity-60 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700";

export function AutomationsClient({
  workflows,
  templates,
  canEdit,
}: {
  workflows: WorkflowDefinition[];
  templates: WorkflowTemplate[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true);
    setError("");
    const result = await fn();
    setBusy(false);
    if (!result.ok) setError(result.message);
    else {
      setEditing(null);
      router.refresh();
    }
  };

  if (editing) {
    return (
      <WorkflowEditor
        state={editing}
        busy={busy}
        error={error}
        onChange={setEditing}
        onCancel={() => {
          setEditing(null);
          setError("");
        }}
        onSave={() => {
          const payload = {
            name: editing.name.trim() || "Untitled workflow",
            description: editing.description,
            trigger: editing.trigger,
            enabled: editing.enabled,
            conditions: [],
            steps: editing.steps.map((step, index) => ({
              id: step.id || `step-${index + 1}`,
              action: step.action,
              params: Object.fromEntries(step.params.filter(([k]) => k.trim() !== "")),
            })),
          };
          void run(() =>
            editing.id
              ? api(`/api/workflows/${editing.id}`, "PATCH", payload)
              : api("/api/workflows", "POST", payload),
          );
        }}
      />
    );
  }

  return (
    <div className="space-y-8">
      {error && (
        <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {canEdit && (
        <TemplateGallery
          templates={templates}
          busy={busy}
          onInstall={(templateId, variables) =>
            run(() => api("/api/workflows/templates", "POST", { templateId, variables }))
          }
        />
      )}

      <section className={card}>
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Your workflows
            </h2>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              {workflows.length === 0
                ? "Install a journey above or build one from scratch."
                : `${workflows.length} workflow${workflows.length === 1 ? "" : "s"}`}
            </p>
          </div>
          {canEdit && (
            <button className={btnPrimary} disabled={busy} onClick={() => setEditing(toEditor(null))}>
              New workflow
            </button>
          )}
        </div>
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {workflows.map((workflow) => (
            <li key={workflow.id} className="flex flex-wrap items-center gap-3 px-6 py-4">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-900 dark:text-slate-100">{workflow.name}</p>
                <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                  {TRIGGER_LABELS[workflow.trigger] ?? workflow.trigger} →{" "}
                  {workflow.steps.map((s) => ACTION_LABELS[s.action] ?? s.action).join(" → ")}
                </p>
              </div>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                  workflow.enabled
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                }`}
              >
                {workflow.enabled ? "On" : "Off"}
              </span>
              {canEdit && (
                <div className="flex gap-1.5">
                  <button
                    className={btnSecondary}
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        api(`/api/workflows/${workflow.id}`, "PATCH", { enabled: !workflow.enabled }),
                      )
                    }
                  >
                    {workflow.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className={btnSecondary} disabled={busy} onClick={() => setEditing(toEditor(workflow))}>
                    Edit
                  </button>
                  <button
                    className="rounded-md px-3 py-1.5 text-sm font-semibold text-red-600 ring-1 ring-inset ring-red-200 hover:bg-red-50 disabled:opacity-60 dark:ring-red-900 dark:hover:bg-red-950"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Delete "${workflow.name}"?`)) {
                        void run(() => api(`/api/workflows/${workflow.id}`, "DELETE"));
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <RunHistory workflows={workflows} />
    </div>
  );
}

const RUN_STATUS_STYLES: Record<string, string> = {
  succeeded: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  dead_letter: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  running: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  pending: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  skipped: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
};

interface RunRow {
  id: string;
  workflowId: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  currentStep: number;
  correlationId: string;
  error: string;
  createdAt: string;
  finishedAt: string | null;
}

interface RunLogRow {
  stepId: string;
  attempt: number;
  status: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

/**
 * What the journeys actually did. Loaded on demand rather than with the
 * page: most visits to this screen are about building a workflow, not
 * auditing one, and run history is the largest table here.
 */
function RunHistory({ workflows }: { workflows: WorkflowDefinition[] }) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [logs, setLogs] = useState<Record<string, RunLogRow[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState("");

  const names = useMemo(
    () => Object.fromEntries(workflows.map((w) => [w.id, w.name])),
    [workflows],
  );

  const load = async (status: string) => {
    setLoading(true);
    setFailure("");
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const response = await fetch(`/api/workflows/runs${query}`);
    const payload = await response.json().catch(() => null);
    setLoading(false);
    if (!response.ok) {
      setFailure(payload?.error?.message ?? "Could not load run history");
      return;
    }
    setRuns(payload?.data?.runs ?? []);
  };

  const toggle = async (runId: string) => {
    if (expanded === runId) {
      setExpanded(null);
      return;
    }
    setExpanded(runId);
    if (logs[runId]) return;
    const response = await fetch(`/api/workflows/runs/${runId}`);
    const payload = await response.json().catch(() => null);
    if (response.ok) setLogs((current) => ({ ...current, [runId]: payload?.data?.logs ?? [] }));
  };

  return (
    <section className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4 dark:border-slate-800">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Run history
          </h2>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            Every time a journey fired — and what each step did.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className={inputCls}
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              void load(event.target.value);
            }}
          >
            <option value="">All runs</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed (retrying)</option>
            <option value="dead_letter">Dead letter</option>
            <option value="skipped">Skipped (conditions)</option>
            <option value="running">Running</option>
          </select>
          <button className={btnSecondary} disabled={loading} onClick={() => void load(filter)}>
            {loading ? "Loading…" : runs === null ? "Load" : "Refresh"}
          </button>
        </div>
      </div>

      {failure && (
        <p className="px-6 py-4 text-sm text-red-700 dark:text-red-300">{failure}</p>
      )}

      {runs === null ? (
        <p className="px-6 py-6 text-sm text-slate-500 dark:text-slate-400">
          Load the history to see recent journey executions.
        </p>
      ) : runs.length === 0 ? (
        <p className="px-6 py-6 text-sm text-slate-500 dark:text-slate-400">
          No runs yet{filter ? " with that status" : ""}.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {runs.map((run) => (
            <li key={run.id} className="px-6 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-900 dark:text-slate-100">
                    {names[run.workflowId] ?? "Deleted workflow"}
                  </p>
                  <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                    {new Date(run.createdAt).toLocaleString()}
                    {run.attempt > 1 && ` · attempt ${run.attempt}/${run.maxAttempts}`}
                    {run.error && ` · ${run.error}`}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    RUN_STATUS_STYLES[run.status] ?? RUN_STATUS_STYLES.pending
                  }`}
                >
                  {run.status.replace("_", " ")}
                </span>
                <button className={btnSecondary} onClick={() => void toggle(run.id)}>
                  {expanded === run.id ? "Hide steps" : "Steps"}
                </button>
              </div>

              {expanded === run.id && (
                <ol className="mt-3 space-y-1.5 border-l-2 border-slate-200 pl-4 dark:border-slate-700">
                  {(logs[run.id] ?? []).map((entry, index) => (
                    <li key={index} className="text-sm">
                      <span className="font-medium text-slate-900 dark:text-slate-100">
                        {entry.stepId}
                      </span>{" "}
                      <span className="text-slate-500 dark:text-slate-400">
                        {entry.status}
                        {entry.attempt > 1 && ` (attempt ${entry.attempt})`}
                      </span>
                      {Object.keys(entry.detail).length > 0 && (
                        <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          {JSON.stringify(entry.detail, null, 2)}
                        </pre>
                      )}
                    </li>
                  ))}
                  {(logs[run.id] ?? []).length === 0 && (
                    <li className="text-sm text-slate-500 dark:text-slate-400">
                      No steps logged — the run never got past its conditions.
                    </li>
                  )}
                </ol>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TemplateGallery({
  templates,
  busy,
  onInstall,
}: {
  templates: WorkflowTemplate[];
  busy: boolean;
  onInstall: (templateId: string, variables: Record<string, string>) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [variables, setVariables] = useState<Record<string, string>>({});

  return (
    <section>
      <h2 className="mb-3 text-base font-semibold text-slate-900 dark:text-slate-100">
        Journey templates
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {templates.map((template) => (
          <div key={template.id} className={`${card} p-5`}>
            <h3 className="font-semibold text-slate-900 dark:text-slate-100">{template.name}</h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{template.description}</p>
            {open === template.id && template.variables.length > 0 && (
              <div className="mt-3 space-y-2">
                {template.variables.map((variable) => (
                  <label key={variable.key} className="block text-sm">
                    <span className="font-medium text-slate-700 dark:text-slate-200">
                      {variable.label}
                      {variable.required && <span className="text-red-500"> *</span>}
                    </span>
                    <input
                      className={inputCls}
                      placeholder={variable.example}
                      value={variables[variable.key] ?? ""}
                      onChange={(event) =>
                        setVariables({ ...variables, [variable.key]: event.target.value })
                      }
                    />
                  </label>
                ))}
              </div>
            )}
            <button
              className={`${btnPrimary} mt-4`}
              disabled={busy}
              onClick={() => {
                if (template.variables.length > 0 && open !== template.id) {
                  setOpen(template.id);
                  return;
                }
                onInstall(template.id, variables);
              }}
            >
              {open === template.id || template.variables.length === 0 ? "Install" : "Set up"}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function WorkflowEditor({
  state,
  busy,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  state: EditorState;
  busy: boolean;
  error: string;
  onChange: (next: EditorState) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const stepIds = useMemo(() => state.steps.map((s) => s.id), [state.steps]);

  const updateStep = (index: number, patch: Partial<EditorState["steps"][number]>) => {
    const steps = state.steps.map((step, i) => (i === index ? { ...step, ...patch } : step));
    onChange({ ...state, steps });
  };
  const moveStep = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= state.steps.length) return;
    const steps = [...state.steps];
    [steps[index], steps[target]] = [steps[target], steps[index]];
    onChange({ ...state, steps });
  };

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <div className={`${card} space-y-4 p-6`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium text-slate-700 dark:text-slate-200">Name</span>
            <input
              className={inputCls}
              value={state.name}
              placeholder="e.g. Post-visit review ask"
              onChange={(event) => onChange({ ...state, name: event.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700 dark:text-slate-200">Description</span>
            <input
              className={inputCls}
              value={state.description}
              onChange={(event) => onChange({ ...state, description: event.target.value })}
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={(event) => onChange({ ...state, enabled: event.target.checked })}
          />
          Enabled
        </label>
      </div>

      {/* The visual flow: trigger → step → step, joined by arrows. */}
      <div className="space-y-0">
        <div className={`${card} border-indigo-300 p-5 dark:border-indigo-800`}>
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">
            When this happens
          </p>
          <select
            className={`${inputCls} mt-2`}
            value={state.trigger}
            onChange={(event) => onChange({ ...state, trigger: event.target.value })}
          >
            {BUSINESS_EVENT_TYPES.map((trigger) => (
              <option key={trigger} value={trigger}>
                {TRIGGER_LABELS[trigger] ?? trigger}
              </option>
            ))}
          </select>
        </div>

        {state.steps.map((step, index) => (
          <div key={index}>
            <FlowArrow />
            <div className={`${card} p-5`}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Step {index + 1}
                </p>
                <div className="flex gap-1">
                  <button className={btnSecondary} disabled={busy || index === 0} onClick={() => moveStep(index, -1)}>
                    ↑
                  </button>
                  <button
                    className={btnSecondary}
                    disabled={busy || index === state.steps.length - 1}
                    onClick={() => moveStep(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    className={btnSecondary}
                    disabled={busy || state.steps.length === 1}
                    onClick={() =>
                      onChange({ ...state, steps: state.steps.filter((_, i) => i !== index) })
                    }
                  >
                    ✕
                  </button>
                </div>
              </div>
              <select
                className={`${inputCls} mt-2`}
                value={step.action}
                onChange={(event) => {
                  const action = event.target.value as WorkflowActionType;
                  updateStep(index, {
                    action,
                    params: Object.entries(ACTION_PARAM_HINTS[action] ?? {}),
                  });
                }}
              >
                {WORKFLOW_ACTION_TYPES.map((action) => (
                  <option key={action} value={action}>
                    {ACTION_LABELS[action]}
                  </option>
                ))}
              </select>
              <div className="mt-3 space-y-2">
                {step.params.map(([key, value], paramIndex) => (
                  <div key={paramIndex} className="flex gap-2">
                    <input
                      className={`${inputCls} max-w-40`}
                      value={key}
                      placeholder="param"
                      onChange={(event) => {
                        const params = step.params.map((pair, i) =>
                          i === paramIndex ? ([event.target.value, pair[1]] as [string, string]) : pair,
                        );
                        updateStep(index, { params });
                      }}
                    />
                    <input
                      className={inputCls}
                      value={value}
                      placeholder="value ({{event.payload.…}} works)"
                      onChange={(event) => {
                        const params = step.params.map((pair, i) =>
                          i === paramIndex ? ([pair[0], event.target.value] as [string, string]) : pair,
                        );
                        updateStep(index, { params });
                      }}
                    />
                    <button
                      className={btnSecondary}
                      disabled={busy}
                      onClick={() =>
                        updateStep(index, { params: step.params.filter((_, i) => i !== paramIndex) })
                      }
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  className={btnSecondary}
                  disabled={busy}
                  onClick={() => updateStep(index, { params: [...step.params, ["", ""]] })}
                >
                  + Add parameter
                </button>
              </div>
            </div>
          </div>
        ))}

        <FlowArrow />
        <button
          className="w-full rounded-xl border-2 border-dashed border-slate-300 px-4 py-3 text-sm font-medium text-slate-500 hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-700 dark:text-slate-400"
          disabled={busy}
          onClick={() => {
            let n = state.steps.length + 1;
            while (stepIds.includes(`step-${n}`)) n += 1;
            onChange({
              ...state,
              steps: [
                ...state.steps,
                { id: `step-${n}`, action: "send_email", params: Object.entries(ACTION_PARAM_HINTS.send_email) },
              ],
            });
          }}
        >
          + Add step
        </button>
      </div>

      <div className="flex gap-2">
        <button className={btnPrimary} disabled={busy} onClick={onSave}>
          {state.id ? "Save changes" : "Create workflow"}
        </button>
        <button className={btnSecondary} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function FlowArrow() {
  return (
    <div className="flex justify-center py-1 text-slate-300 dark:text-slate-600" aria-hidden>
      ↓
    </div>
  );
}
