"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { FormError, FormSuccess } from "@/components/ui/form-feedback";
import { updateLifecycleSettings } from "./actions";
import type { IntakeField } from "@/core/domain/scheduling";
import type { LifecycleSettingsPatch } from "@/core/services/lifecycle/lifecycle-settings";
import type { ActionState } from "@/features/business/actions";

const MAX_INTAKE_FIELDS = 25;

/** Renders a stored schedule back as the shorthand the field accepts. */
function formatLeadTimes(minutes: number[]): string {
  return minutes
    .map((value) =>
      value % 1440 === 0 ? `${value / 1440}d` : value % 60 === 0 ? `${value / 60}h` : `${value}m`,
    )
    .join(", ");
}

/**
 * Everything the lifecycle layer says to a customer, in one place: where to
 * go, how to prepare, what to fill in beforehand, where to leave a review,
 * when reminders fire, and whether missed appointments close themselves out.
 *
 * The intake builder keeps rows in local state but submits plain form
 * fields, so the whole page still works as one server-action form post.
 */
export function LifecycleSettingsForm({
  settings,
  readOnly,
}: {
  settings: LifecycleSettingsPatch;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    updateLifecycleSettings,
    { error: null },
  );
  const [fields, setFields] = useState<IntakeField[]>(settings.intakeForm);

  const addField = () =>
    setFields((current) =>
      current.length >= MAX_INTAKE_FIELDS
        ? current
        : [...current, { id: "", label: "", type: "text", required: false }],
    );
  const removeField = (index: number) =>
    setFields((current) => current.filter((_, i) => i !== index));

  return (
    <form action={formAction} className="space-y-6">
      <Card>
        <CardHeader
          title="Directions & preparation"
          description="Included in confirmation emails, reminders, and the visitor's manage page."
        />
        <CardBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="locationAddress">Location address</Label>
            <Input
              id="locationAddress"
              name="locationAddress"
              defaultValue={settings.locationAddress}
              placeholder="12 Bridge St, Boston MA 02110"
              disabled={readOnly}
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Turns into a one-tap Google Maps link. Leave empty to omit directions.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prepInstructions">How to prepare</Label>
            <Textarea
              id="prepInstructions"
              name="prepInstructions"
              defaultValue={settings.prepInstructions}
              placeholder="Please clear access to the outdoor unit and keep pets inside."
              disabled={readOnly}
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Reminders"
          description="How long before each appointment the visitor is reminded."
        />
        <CardBody className="space-y-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="remindersEnabled"
              defaultChecked={settings.remindersEnabled}
              disabled={readOnly}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600"
            />
            <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
              Send appointment reminders
            </span>
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="reminderLeadMinutes">Reminder schedule</Label>
            <Input
              id="reminderLeadMinutes"
              name="reminderLeadMinutes"
              defaultValue={formatLeadTimes(settings.reminderLeadMinutes)}
              placeholder="24h, 1h"
              disabled={readOnly}
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Comma-separated times before the appointment — <code>2d</code>, <code>24h</code>,{" "}
              <code>90m</code>. Up to 10, between 5 minutes and 30 days.
            </p>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Intake form"
          description="Asked on the visitor's manage page before the appointment."
        />
        <CardBody className="space-y-4">
          {fields.length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              No intake questions yet — visitors go straight to their appointment details.
            </p>
          )}
          {fields.map((field, index) => (
            <div
              key={index}
              className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end dark:border-slate-800"
            >
              {/* Preserves the saved id so existing answers keep their key. */}
              <input type="hidden" name="intakeId" value={field.id} />
              <div className="space-y-1.5">
                <Label htmlFor={`intakeLabel-${index}`}>Question</Label>
                <Input
                  id={`intakeLabel-${index}`}
                  name="intakeLabel"
                  defaultValue={field.label}
                  placeholder="How old is your unit?"
                  disabled={readOnly}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`intakeType-${index}`}>Type</Label>
                <Select
                  id={`intakeType-${index}`}
                  name="intakeType"
                  defaultValue={field.type}
                  disabled={readOnly}
                >
                  <option value="text">Short text</option>
                  <option value="textarea">Long text</option>
                  <option value="checkbox">Checkbox</option>
                </Select>
              </div>
              <div className="flex items-center gap-4 pb-2">
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    name={`intakeRequired-${index}`}
                    defaultChecked={field.required}
                    disabled={readOnly}
                    className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600"
                  />
                  Required
                </label>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => removeField(index)}
                    className="text-sm font-medium text-rose-600 hover:text-rose-700"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
          {!readOnly && fields.length < MAX_INTAKE_FIELDS && (
            <Button type="button" variant="secondary" onClick={addField}>
              Add question
            </Button>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="After the appointment"
          description="Where review requests point, and how missed appointments are closed out."
        />
        <CardBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="reviewUrl">Review link</Label>
            <Input
              id="reviewUrl"
              name="reviewUrl"
              type="url"
              defaultValue={settings.reviewUrl}
              placeholder="https://g.page/r/your-business/review"
              disabled={readOnly}
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Used by the review-request journey. Must be an https link.
            </p>
          </div>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="autoNoShowEnabled"
              defaultChecked={settings.autoNoShowEnabled}
              disabled={readOnly}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600"
            />
            <span>
              <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                Mark missed appointments as no-shows automatically
              </span>
              <span className="block text-sm text-slate-500 dark:text-slate-400">
                Only affects appointments nobody checked in. Turn this on if you work the
                appointments board — otherwise past visits you never closed out will be counted
                as no-shows.
              </span>
            </span>
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="noShowGraceMinutes">Grace period (minutes after the end time)</Label>
            <Input
              id="noShowGraceMinutes"
              name="noShowGraceMinutes"
              type="number"
              min={0}
              max={1440}
              defaultValue={settings.noShowGraceMinutes}
              disabled={readOnly}
              className="max-w-32"
            />
          </div>
        </CardBody>
      </Card>

      {readOnly ? (
        <p className="text-sm text-slate-500">Only workspace admins can change settings.</p>
      ) : (
        <>
          <FormError message={state.error} />
          <FormSuccess message={state.message} />
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save lifecycle settings"}
          </Button>
        </>
      )}
    </form>
  );
}
