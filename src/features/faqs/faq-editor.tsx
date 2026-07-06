"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { FormError, FormSuccess } from "@/components/ui/form-feedback";
import { createFaq, updateFaq } from "./actions";
import type { ActionState } from "@/features/business/actions";

interface EditableFaq {
  id: string;
  question: string;
  answer: string;
  category: string;
}

export function FaqEditor(props: { mode: "create" } | { mode: "edit"; faq: EditableFaq }) {
  const isEdit = props.mode === "edit";
  const [expanded, setExpanded] = useState(!isEdit);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    isEdit ? updateFaq : createFaq,
    { error: null },
  );

  const suffix = isEdit ? props.faq.id : "new";

  const form = (
    <form action={formAction} className="space-y-4">
      {isEdit && <input type="hidden" name="id" value={props.faq.id} />}
      <div className="space-y-1.5">
        <Label htmlFor={`question-${suffix}`}>Question</Label>
        <Input
          id={`question-${suffix}`}
          name="question"
          defaultValue={isEdit ? props.faq.question : ""}
          placeholder="What are your opening hours?"
          required
          maxLength={500}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`answer-${suffix}`}>Answer</Label>
        <Textarea
          id={`answer-${suffix}`}
          name="answer"
          defaultValue={isEdit ? props.faq.answer : ""}
          placeholder="We're open Monday to Friday, 9am to 5pm."
          required
          maxLength={4000}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`category-${suffix}`}>Category (optional)</Label>
        <Input
          id={`category-${suffix}`}
          name="category"
          defaultValue={isEdit ? props.faq.category : ""}
          placeholder="General"
          maxLength={100}
        />
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.message} />
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : isEdit ? "Save changes" : "Add FAQ"}
        </Button>
        {isEdit && (
          <Button type="button" variant="ghost" onClick={() => setExpanded(false)}>
            Close
          </Button>
        )}
      </div>
    </form>
  );

  if (!isEdit) {
    return (
      <Card>
        <CardHeader title="Add an FAQ" />
        <CardBody>{form}</CardBody>
      </Card>
    );
  }

  return (
    <CardBody className="border-t border-slate-100 dark:border-slate-800">
      {expanded ? (
        form
      ) : (
        <div className="space-y-3">
          <p className="whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">
            {props.faq.answer}
          </p>
          <Button variant="secondary" size="sm" onClick={() => setExpanded(true)}>
            Edit
          </Button>
        </div>
      )}
    </CardBody>
  );
}
