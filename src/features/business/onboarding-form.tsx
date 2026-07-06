"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormError } from "@/components/ui/form-feedback";
import { createBusiness, type ActionState } from "./actions";

export function OnboardingForm() {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    createBusiness,
    { error: null },
  );

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">Business name</Label>
        <Input id="name" name="name" placeholder="Acme Dental Clinic" required maxLength={120} />
      </div>
      <FormError message={state.error} />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Creating…" : "Create my receptionist"}
      </Button>
    </form>
  );
}
