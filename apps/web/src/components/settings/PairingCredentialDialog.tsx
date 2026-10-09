import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/** Creation form shared by environment pairing, hub pairing, and daemon invitations. */
export function PairingCredentialDialog({
  open,
  onOpenChange,
  title = "Create pairing link",
  description,
  label,
  onLabelChange,
  labelTitle = "Client label (optional)",
  labelPlaceholder = "e.g. Living room iPad",
  pending,
  disabled = false,
  submitLabel = "Create link",
  onCreate,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  label: string;
  onLabelChange: (label: string) => void;
  labelTitle?: string;
  labelPlaceholder?: string;
  pending: boolean;
  disabled?: boolean;
  submitLabel?: string;
  onCreate: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogPopup
        className="max-w-md"
        {...(!description ? { "aria-describedby": undefined } : {})}
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onCreate();
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogPanel>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">{labelTitle}</span>
            <Input
              value={label}
              onChange={(event) => onLabelChange(event.target.value)}
              placeholder={labelPlaceholder}
              disabled={pending}
              autoFocus
            />
          </label>
          {children}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={pending || disabled}>
            {pending ? "Creating…" : submitLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
