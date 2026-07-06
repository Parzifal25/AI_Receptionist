"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { FormError, FormSuccess } from "@/components/ui/form-feedback";
import { createDocument, updateDocument } from "./actions";
import type { ActionState } from "@/features/business/actions";

interface EditableDocument {
  id: string;
  title: string;
  content: string;
}

export function DocumentEditor(
  props: { mode: "create" } | { mode: "edit"; document: EditableDocument },
) {
  const isEdit = props.mode === "edit";
  const [expanded, setExpanded] = useState(!isEdit);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    isEdit ? updateDocument : createDocument,
    { error: null },
  );

  const form = (
    <form action={formAction} className="space-y-4">
      {isEdit && <input type="hidden" name="id" value={props.document.id} />}
      <div className="space-y-1.5">
        <Label htmlFor={`title-${isEdit ? props.document.id : "new"}`}>Title</Label>
        <Input
          id={`title-${isEdit ? props.document.id : "new"}`}
          name="title"
          defaultValue={isEdit ? props.document.title : ""}
          placeholder="Services & pricing"
          required
          maxLength={200}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`content-${isEdit ? props.document.id : "new"}`}>Content</Label>
        <Textarea
          id={`content-${isEdit ? props.document.id : "new"}`}
          name="content"
          defaultValue={isEdit ? props.document.content : ""}
          placeholder="Paste the text your receptionist should learn…"
          required
          maxLength={100_000}
          className="min-h-40"
        />
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.message} />
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : isEdit ? "Save & re-index" : "Add document"}
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
        <CardHeader title="Add a document" />
        <CardBody>{form}</CardBody>
      </Card>
    );
  }

  return (
    <CardBody className="border-t border-slate-100 dark:border-slate-800">
      {expanded ? (
        form
      ) : (
        <Button variant="secondary" size="sm" onClick={() => setExpanded(true)}>
          Edit content
        </Button>
      )}
    </CardBody>
  );
}
