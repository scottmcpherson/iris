import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/dialog";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "../../shared/ui/field";
import { Input } from "../../shared/ui/input";
import { Button } from "../../shared/ui/button";
import { ToggleGroup, ToggleGroupItem } from "../../shared/ui/toggle-group";
import { defaultSshPort } from "../../app/runtimeConfig";
import type { SshDraft } from "./sshConnectionDraft";

export function SshConnectionDialog({
  open,
  draft,
  busy,
  onOpenChange,
  onDraftChange,
  onSave,
}: {
  open: boolean;
  draft: SshDraft;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onDraftChange: (draft: SshDraft) => void;
  onSave: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ssh-connection-dialog">
        <DialogHeader>
          <DialogTitle>Add SSH connection</DialogTitle>
          <DialogDescription>Connect to a remote host using an SSH endpoint and optional identity file.</DialogDescription>
        </DialogHeader>
        <FieldSet className="min-h-0 pt-4 px-5 pb-0 border-0">
          <FieldGroup className="ssh-dialog-fields">
            <Field className="col-start-1 col-end-[-1] justify-self-center w-max max-w-full">
              <ToggleGroup
                type="single"
                className="ssh-auth-toggle"
                value={draft.authMode}
                onValueChange={(value) => {
                  if (value === "none" || value === "identity") onDraftChange({ ...draft, authMode: value });
                }}
              >
                <ToggleGroupItem value="none">No Auth</ToggleGroupItem>
                <ToggleGroupItem value="identity">Identity</ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <TextField id="ssh-name" label="Display name" value={draft.name} onChange={(name) => onDraftChange({ ...draft, name })} />
            <TextField
              id="ssh-hostname"
              label="SSH endpoint"
              value={draft.hostname}
              placeholder="host.com or user@host.com"
              onChange={(hostname) => onDraftChange({ ...draft, hostname })}
            />
            <TextField
              id="ssh-port"
              label="SSH port"
              optional
              value={draft.port}
              placeholder={String(defaultSshPort)}
              onChange={(port) => onDraftChange({ ...draft, port })}
            />
            {draft.authMode === "identity" ? (
              <TextField
                id="ssh-identity"
                label="Identity file path"
                value={draft.identityFile}
                placeholder="~/.ssh/id_ed25519"
                onChange={(identityFile) => onDraftChange({ ...draft, identityFile })}
              />
            ) : null}
          </FieldGroup>
        </FieldSet>
        <DialogFooter className="ssh-dialog-actions">
          <DialogClose asChild>
            <Button variant="appLink">Cancel</Button>
          </DialogClose>
          <Button disabled={busy} onClick={onSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TextField({
  id,
  label,
  value,
  placeholder = "",
  type = "text",
  optional = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  type?: "text" | "password";
  optional?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>
        {label}
        {optional ? <span className="field-label-muted"> optional</span> : null}
      </FieldLabel>
      <Input id={id} type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}
