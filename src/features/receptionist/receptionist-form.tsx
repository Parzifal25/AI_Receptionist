"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { FormError, FormSuccess } from "@/components/ui/form-feedback";
import type { ReceptionistTone, WidgetBranding } from "@halo/core/domain/types";
import { updateReceptionist } from "./actions";
import type { ActionState } from "@/features/business/actions";

interface ReceptionistFormData {
  id: string;
  name: string;
  greeting: string;
  tone: ReceptionistTone;
  language: string;
  customInstructions: string;
  isActive: boolean;
  leadCaptureEnabled: boolean;
  voiceEnabled: boolean;
  branding: WidgetBranding;
}

function Toggle({
  name,
  label,
  description,
  defaultChecked,
}: {
  name: string;
  label: string;
  description: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600"
      />
      <span>
        <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">{label}</span>
        <span className="block text-sm text-slate-500 dark:text-slate-400">{description}</span>
      </span>
    </label>
  );
}

export function ReceptionistForm({ receptionist }: { receptionist: ReceptionistFormData }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    updateReceptionist,
    { error: null },
  );

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="id" value={receptionist.id} />

      <Card>
        <CardHeader title="Personality" />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="name">Receptionist name</Label>
            <Input id="name" name="name" defaultValue={receptionist.name} required maxLength={80} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tone">Tone</Label>
            <Select id="tone" name="tone" defaultValue={receptionist.tone}>
              <option value="friendly">Friendly</option>
              <option value="professional">Professional</option>
              <option value="casual">Casual</option>
              <option value="formal">Formal</option>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="greeting">Greeting message</Label>
            <Textarea
              id="greeting"
              name="greeting"
              defaultValue={receptionist.greeting}
              required
              maxLength={500}
              className="min-h-16"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="language">Language</Label>
            <Select id="language" name="language" defaultValue={receptionist.language}>
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="pt">Portuguese</option>
              <option value="hi">Hindi</option>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="customInstructions">Custom instructions (optional)</Label>
            <Textarea
              id="customInstructions"
              name="customInstructions"
              defaultValue={receptionist.customInstructions}
              maxLength={4000}
              placeholder="e.g. Always mention our free consultation. Never quote exact prices."
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Capabilities" />
        <CardBody className="space-y-4">
          <Toggle
            name="isActive"
            label="Active"
            description="When off, the widget won't load on your website."
            defaultChecked={receptionist.isActive}
          />
          <Toggle
            name="leadCaptureEnabled"
            label="Lead capture"
            description="Ask interested visitors for their contact details and save them as leads."
            defaultChecked={receptionist.leadCaptureEnabled}
          />
          <Toggle
            name="voiceEnabled"
            label="Voice conversations"
            description="Let visitors talk to the receptionist using their microphone."
            defaultChecked={receptionist.voiceEnabled}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Widget appearance" />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="theme">Theme</Label>
            <Select id="theme" name="theme" defaultValue={receptionist.branding.theme}>
              <option value="auto">Match visitor&apos;s system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="primaryColor">Accent color</Label>
            <Input
              id="primaryColor"
              name="primaryColor"
              type="color"
              defaultValue={receptionist.branding.primaryColor}
              className="h-10 w-20 cursor-pointer p-1"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="position">Position</Label>
            <Select id="position" name="position" defaultValue={receptionist.branding.position}>
              <option value="bottom-right">Bottom right</option>
              <option value="bottom-left">Bottom left</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="launcherLabel">Launcher label</Label>
            <Input
              id="launcherLabel"
              name="launcherLabel"
              defaultValue={receptionist.branding.launcherLabel}
              maxLength={40}
              required
            />
          </div>
        </CardBody>
      </Card>

      <FormError message={state.error} />
      <FormSuccess message={state.message} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save changes"}
      </Button>
    </form>
  );
}
