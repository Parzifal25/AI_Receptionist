"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { IntakeField, TimeSlot } from "@/core/domain/scheduling";
import { formatInTz } from "@/core/services/scheduling/timezone";

interface Props {
  token: string;
  status: string;
  isLive: boolean;
  startsAt: string;
  timezone: string;
  slots: TimeSlot[];
  intakeForm: IntakeField[];
  intakeSubmitted: boolean;
  feedbackSubmitted: boolean;
  businessPhone: string;
}

async function callApi(path: string, body: unknown): Promise<{ ok: boolean; message: string }> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return { ok: true, message: "" };
  const payload = await response.json().catch(() => null);
  return { ok: false, message: payload?.error?.message ?? "Something went wrong" };
}

const box =
  "rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900";
const heading = "text-sm font-semibold text-slate-900 dark:text-slate-100";
const primaryBtn =
  "rounded-md bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60";
const secondaryBtn =
  "rounded-md bg-white px-3.5 py-2 text-sm font-semibold text-slate-900 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:opacity-60 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700";

export function ManageActions(props: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Sampled once per mount: "has the appointment started yet" only needs to
  // be roughly right, and render purity forbids Date.now() inline.
  const [nowMs] = useState(() => Date.now());

  const act = async (body: unknown, path = `/api/v1/appointments/${props.token}`) => {
    setBusy(true);
    setError("");
    const result = await callApi(path, body);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    router.refresh();
    return true;
  };

  const canFeedback =
    !props.feedbackSubmitted &&
    props.status !== "cancelled" &&
    (props.status === "completed" || Date.parse(props.startsAt) <= nowMs);

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
          {notice}
        </p>
      )}

      {props.isLive && props.status !== "pending" && (
        <section className={box}>
          <h2 className={heading}>On your way?</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className={primaryBtn}
              disabled={busy}
              onClick={() => act({ action: "check_in" })}
            >
              I&apos;m here — check in
            </button>
            {props.status !== "running_late" && (
              <button
                className={secondaryBtn}
                disabled={busy}
                onClick={() => act({ action: "running_late" })}
              >
                Running late
              </button>
            )}
          </div>
        </section>
      )}

      {props.isLive && props.intakeForm.length > 0 && !props.intakeSubmitted && (
        <IntakeForm
          fields={props.intakeForm}
          busy={busy}
          onSubmit={async (answers) => {
            const ok = await act({ answers }, `/api/v1/appointments/${props.token}/intake`);
            if (ok) setNotice("Intake form received — thank you!");
          }}
        />
      )}
      {props.intakeSubmitted && (
        <p className="text-sm text-slate-500 dark:text-slate-400">✓ Intake form received.</p>
      )}

      {props.isLive && (
        <Reschedule
          slots={props.slots}
          timezone={props.timezone}
          busy={busy}
          onPick={(slot) =>
            act({ action: "reschedule", startsAt: slot.startsAt, staffId: slot.staffId })
          }
          onCancel={() => {
            if (window.confirm("Cancel this appointment?")) void act({ action: "cancel" });
          }}
        />
      )}

      {canFeedback && (
        <FeedbackForm
          busy={busy}
          onSubmit={async (rating, comment) => {
            const ok = await act(
              { rating, comment },
              `/api/v1/appointments/${props.token}/feedback`,
            );
            if (ok) setNotice("Thanks for your feedback!");
          }}
        />
      )}
      {props.feedbackSubmitted && (
        <p className="text-sm text-slate-500 dark:text-slate-400">✓ Feedback received — thank you!</p>
      )}

      {props.businessPhone && (
        <p className="text-center text-xs text-slate-400 dark:text-slate-500">
          Questions? Call {props.businessPhone}.
        </p>
      )}
    </div>
  );
}

function Reschedule({
  slots,
  timezone,
  busy,
  onPick,
  onCancel,
}: {
  slots: TimeSlot[];
  timezone: string;
  busy: boolean;
  onPick: (slot: TimeSlot) => void;
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className={box}>
      <h2 className={heading}>Need to change it?</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={secondaryBtn} disabled={busy || slots.length === 0} onClick={() => setOpen(!open)}>
          {slots.length === 0 ? "No other times available" : open ? "Hide times" : "Reschedule"}
        </button>
        <button
          className="rounded-md px-3.5 py-2 text-sm font-semibold text-red-600 ring-1 ring-inset ring-red-200 hover:bg-red-50 disabled:opacity-60 dark:ring-red-900 dark:hover:bg-red-950"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel appointment
        </button>
      </div>
      {open && (
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {slots.map((slot) => (
            <li key={`${slot.staffId}-${slot.startsAt}`}>
              <button
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-left text-sm text-slate-700 hover:border-indigo-400 hover:bg-indigo-50 disabled:opacity-60 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                disabled={busy}
                onClick={() => onPick(slot)}
              >
                {formatInTz(slot.startsAt, timezone)}
                <span className="block text-xs text-slate-400">with {slot.staffName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function IntakeForm({
  fields,
  busy,
  onSubmit,
}: {
  fields: IntakeField[];
  busy: boolean;
  onSubmit: (answers: Record<string, string | boolean>) => void;
}) {
  return (
    <section className={box}>
      <h2 className={heading}>Before your visit</h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Please fill this in so we can prepare for you.
      </p>
      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const answers: Record<string, string | boolean> = {};
          for (const field of fields) {
            answers[field.id] =
              field.type === "checkbox" ? form.get(field.id) === "on" : String(form.get(field.id) ?? "");
          }
          onSubmit(answers);
        }}
      >
        {fields.map((field) => (
          <label key={field.id} className="block text-sm">
            <span className="font-medium text-slate-700 dark:text-slate-200">
              {field.label}
              {field.required && <span className="text-red-500"> *</span>}
            </span>
            {field.type === "textarea" ? (
              <textarea
                name={field.id}
                required={field.required}
                rows={3}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            ) : field.type === "checkbox" ? (
              <input name={field.id} type="checkbox" className="mt-2 block h-4 w-4" />
            ) : (
              <input
                name={field.id}
                type="text"
                required={field.required}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            )}
          </label>
        ))}
        <button className={primaryBtn} disabled={busy} type="submit">
          Submit
        </button>
      </form>
    </section>
  );
}

function FeedbackForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (rating: number, comment: string) => void;
}) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  return (
    <section className={box} id="feedback">
      <h2 className={heading}>How did we do?</h2>
      <div className="mt-3 flex gap-1" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            aria-label={`${star} star${star > 1 ? "s" : ""}`}
            aria-checked={rating === star}
            role="radio"
            className={`text-2xl transition-transform hover:scale-110 ${star <= rating ? "text-amber-400" : "text-slate-300 dark:text-slate-600"}`}
            onClick={() => setRating(star)}
          >
            ★
          </button>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        rows={3}
        placeholder="Anything you'd like us to know? (optional)"
        className="mt-3 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
      />
      <button
        className={`${primaryBtn} mt-3`}
        disabled={busy || rating === 0}
        onClick={() => onSubmit(rating, comment)}
      >
        Send feedback
      </button>
    </section>
  );
}
