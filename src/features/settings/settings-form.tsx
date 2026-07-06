"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { FormError, FormSuccess } from "@/components/ui/form-feedback";
import { updateSettings } from "./actions";
import type { ActionState } from "@/features/business/actions";

interface SettingsData {
  allowedDomains: string[];
  notifyOnLead: boolean;
  notificationEmail: string;
}

export function SettingsForm({
  settings,
  readOnly,
}: {
  settings: SettingsData;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    updateSettings,
    { error: null },
  );

  return (
    <form action={formAction} className="space-y-6">
      <Card>
        <CardHeader
          title="Allowed domains"
          description="Only these domains may embed your widget. Leave empty to allow any domain (useful while testing)."
        />
        <CardBody className="space-y-1.5">
          <Label htmlFor="allowedDomains">Domains — one per line</Label>
          <Textarea
            id="allowedDomains"
            name="allowedDomains"
            defaultValue={settings.allowedDomains.join("\n")}
            placeholder={"example.com\napp.example.com"}
            disabled={readOnly}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Notifications" />
        <CardBody className="space-y-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="notifyOnLead"
              defaultChecked={settings.notifyOnLead}
              disabled={readOnly}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600"
            />
            <span>
              <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                Notify me about new leads
              </span>
              <span className="block text-sm text-slate-500 dark:text-slate-400">
                Get an alert whenever the receptionist captures a lead.
              </span>
            </span>
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="notificationEmail">Notification email</Label>
            <Input
              id="notificationEmail"
              name="notificationEmail"
              type="email"
              defaultValue={settings.notificationEmail}
              placeholder="team@example.com"
              disabled={readOnly}
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
            {pending ? "Saving…" : "Save settings"}
          </Button>
        </>
      )}
    </form>
  );
}
