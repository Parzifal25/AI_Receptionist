"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { FormError, FormSuccess } from "@/components/ui/form-feedback";
import type { BusinessHours, Weekday } from "@halo/core/domain/types";
import { updateBusinessProfile, type ActionState } from "./actions";

const WEEKDAYS: Array<{ key: Weekday; label: string }> = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
];

interface ProfileFormBusiness {
  name: string;
  description: string;
  industry: string;
  website: string;
  phone: string;
  email: string;
  address: string;
  businessHours: BusinessHours;
}

export function ProfileForm({ business }: { business: ProfileFormBusiness }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    updateBusinessProfile,
    { error: null },
  );

  return (
    <form action={formAction} className="space-y-6">
      <Card>
        <CardHeader title="Details" />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="name">Business name</Label>
            <Input id="name" name="name" defaultValue={business.name} required maxLength={120} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              name="description"
              defaultValue={business.description}
              maxLength={2000}
              placeholder="What does your business do? Your receptionist uses this to describe you."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="industry">Industry</Label>
            <Input id="industry" name="industry" defaultValue={business.industry} maxLength={100} placeholder="Dentistry" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="website">Website</Label>
            <Input id="website" name="website" type="url" defaultValue={business.website} placeholder="https://example.com" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="phone">Phone</Label>
            <Input id="phone" name="phone" defaultValue={business.phone} maxLength={30} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">Contact email</Label>
            <Input id="email" name="email" type="email" defaultValue={business.email} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="address">Address</Label>
            <Input id="address" name="address" defaultValue={business.address} maxLength={500} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Business hours"
          description="The receptionist quotes these when visitors ask when you're open."
        />
        <CardBody className="space-y-3">
          {WEEKDAYS.map(({ key, label }) => {
            const entry = business.businessHours[key];
            return (
              <div key={key} className="flex flex-wrap items-center gap-3">
                <span className="w-24 text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
                <Input
                  type="time"
                  name={`hours_${key}_open`}
                  defaultValue={entry?.open ?? "09:00"}
                  className="w-32"
                  aria-label={`${label} opening time`}
                />
                <span className="text-sm text-slate-400">to</span>
                <Input
                  type="time"
                  name={`hours_${key}_close`}
                  defaultValue={entry?.close ?? "17:00"}
                  className="w-32"
                  aria-label={`${label} closing time`}
                />
                <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
                  <input
                    type="checkbox"
                    name={`hours_${key}_closed`}
                    defaultChecked={entry?.closed ?? false}
                    className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600"
                  />
                  Closed
                </label>
              </div>
            );
          })}
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
