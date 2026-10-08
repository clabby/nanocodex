"use client";

import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AgentStatus } from "./types.js";
import { COARSE_POINTER_QUERY, TOUCH_KEYBOARD_QUERY, terminalComposerAction } from "./policy.js";
import { ComposerAttachmentList } from "./ComposerAttachmentList.js";
import {
  AttachmentRejection, MAX_ATTACHMENTS, attachmentAccept, prepareAttachment,
  type ComposerAttachment, type ComposerAttachmentPolicy,
} from "./composerAttachments.js";

export type { ComposerAttachment, ComposerAttachmentPolicy } from "./composerAttachments.js";

const MAX_DESKTOP_HEIGHT = 288;
const MAX_TOUCH_HEIGHT = 168;

/**
 * One composer for desktop and touch: auto-growing input, Enter to send,
 * Shift+Enter for a newline, IME-safe, with optional file attachments.
 */
export function TerminalComposer({
  attachments: attachmentPolicy,
  controls,
  formLabel = "Nanocodex message composer",
  inputLabel = "Message Nanocodex",
  sendLabel = "Send message",
  draft,
  pending,
  placeholder,
  running,
  status,
  onCancel,
  onChange,
  onSubmit,
}: {
  /** Enables drag-and-drop, paste and picker attachments. Omit to accept text only. */
  attachments?: ComposerAttachmentPolicy | undefined;
  controls?: ReactNode;
  formLabel?: string;
  inputLabel?: string;
  sendLabel?: string;
  draft: string;
  pending: boolean;
  placeholder?: string;
  running: boolean;
  status: AgentStatus;
  onCancel(): void;
  onChange(value: string): void;
  onSubmit(value: string, attachments: readonly ComposerAttachment[]): void;
}) {
  const composing = useRef(false);
  const compositionEndedAt = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [items, setItems] = useState<readonly ComposerAttachment[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const accepting = attachmentPolicy !== undefined;

  useEffect(() => {
    const element = textarea.current;
    if (
      !element
      || status !== "ready"
      || window.matchMedia(COARSE_POINTER_QUERY).matches
      || (document.activeElement !== document.body && document.activeElement !== null)
    ) return;
    const frame = window.requestAnimationFrame(() => element.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [status]);

  // Grow with the content up to a bounded height, then scroll inside the field.
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element?.style || typeof window === "undefined") return;
    const max = window.matchMedia?.(COARSE_POINTER_QUERY).matches ? MAX_TOUCH_HEIGHT : MAX_DESKTOP_HEIGHT;
    element.style.height = "auto";
    const next = Math.min(element.scrollHeight, max);
    element.style.height = `${next}px`;
    element.style.overflowY = element.scrollHeight > max ? "auto" : "hidden";
  }, [draft]);

  const addFiles = useCallback((files: readonly File[]) => {
    if (!accepting || files.length === 0) return;
    const limit = attachmentPolicy?.maxAttachments ?? MAX_ATTACHMENTS;
    const room = Math.max(0, limit - items.length - preparing);
    const accepted = files.slice(0, room);
    setNotice(files.length > room ? `You can attach up to ${limit} files.` : undefined);
    if (!accepted.length) return;
    setPreparing((count) => count + accepted.length);
    for (const file of accepted) {
      void prepareAttachment(file, attachmentPolicy).then(
        (attachment) => setItems((current) => [...current, attachment]),
        (error: unknown) => setNotice(error instanceof AttachmentRejection
          ? error.message : `${file.name || "The file"} could not be attached.`),
      ).finally(() => setPreparing((count) => count - 1));
    }
  }, [accepting, attachmentPolicy, items.length, preparing]);

  // Files dropped anywhere on this conversation attach here; elsewhere they are
  // ignored instead of navigating the page away to the file.
  const form = useRef<HTMLFormElement>(null);
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  useEffect(() => {
    if (!accepting || typeof window === "undefined" || !window.addEventListener) return;
    const over = (event: DragEvent) => { if (hasFiles(event.dataTransfer)) event.preventDefault(); };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer) || event.defaultPrevented) return;
      event.preventDefault();
      const scope = form.current?.closest(".agent-terminal-shell") ?? form.current;
      if (event.target instanceof Node && scope?.contains(event.target)) {
        addFilesRef.current(Array.from(event.dataTransfer?.files ?? []));
      }
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [accepting]);

  const hasContent = draft.trim().length > 0 || items.length > 0;
  const submit = () => {
    const value = textarea.current?.value ?? draft;
    if (pending || status !== "ready" || preparing > 0 || (!value.trim() && items.length === 0)) return;
    onSubmit(value, items);
    setItems([]);
    setNotice(undefined);
  };
  const action = terminalComposerAction(running, draft);
  const showSend = action === "send" || hasContent;
  const coarse = typeof window !== "undefined" && window.matchMedia?.(TOUCH_KEYBOARD_QUERY).matches === true;

  return (
    <form
      ref={form}
      className={`agent-touch-composer agent-composer${running ? " is-running" : ""}${dragging ? " is-dragging" : ""}`}
      aria-label={formLabel}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onDragEnter={accepting ? (event) => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      } : undefined}
      onDragOver={accepting ? (event) => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      } : undefined}
      onDragLeave={accepting ? () => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      } : undefined}
      onDrop={accepting ? (event) => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        addFiles(Array.from(event.dataTransfer.files));
      } : undefined}
    >
      {notice ? <div className="agent-composer-notice" role="alert">
        <span>{notice}</span>
        <button type="button" aria-label="Dismiss" onClick={() => setNotice(undefined)}><X aria-hidden="true" /></button>
      </div> : null}
      <div className="agent-touch-field agent-composer-field">
        {accepting ? <ComposerAttachmentList attachments={items} preparing={preparing}
          onRemove={(id) => setItems((current) => current.filter((item) => item.id !== id))} /> : null}
        <textarea
          ref={textarea}
          aria-label={inputLabel}
          enterKeyHint={coarse ? "enter" : "send"}
          rows={1}
          placeholder={placeholder}
          value={draft}
          onChange={(event) => onChange(event.currentTarget.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(event) => {
            composing.current = false;
            compositionEndedAt.current = Date.now();
            onChange(event.currentTarget.value);
          }}
          onPaste={accepting ? (event) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (!files.length) return;
            // Pasted text still inserts normally; only clipboard files become attachments.
            if (!event.clipboardData.getData("text/plain")) event.preventDefault();
            addFiles(files);
          } : undefined}
          onKeyDown={(event) => {
            if (event.key === "Escape" && running && status === "ready" && !draft) {
              event.preventDefault();
              onCancel();
              return;
            }
            if (!isSubmitKeyEvent(event.nativeEvent, composing.current, compositionEndedAt.current)) return;
            // Touch keyboards have no Shift: Enter adds a line and the button sends.
            if (coarse) return;
            event.preventDefault();
            submit();
          }}
        />
        <div className="agent-touch-actions agent-composer-toolbar">
          {accepting ? <>
            <button className="agent-composer-attach" type="button" aria-label="Attach files" title="Attach images or files"
              disabled={status !== "ready"} onClick={() => picker.current?.click()}>
              <Paperclip aria-hidden="true" />
            </button>
            <input ref={picker} className="agent-terminal-sr-only" type="file" multiple tabIndex={-1} aria-hidden="true"
              accept={attachmentAccept(attachmentPolicy)}
              onChange={(event) => {
                addFiles(Array.from(event.currentTarget.files ?? []));
                event.currentTarget.value = "";
              }} />
          </> : null}
          {controls}
          <span className="agent-composer-spacer" aria-hidden="true" />
          {running ? (
            <button className={`agent-composer-stop${showSend ? "" : " is-primary"}`} type="button" aria-label="Stop response" title="Stop response (Esc)" disabled={status !== "ready"} onClick={onCancel}>
              <Square aria-hidden="true" />
            </button>
          ) : null}
          {showSend ? <button className="agent-composer-send" type="submit" aria-label={sendLabel} title={coarse ? sendLabel : `${sendLabel} (Enter)`}
            disabled={pending || status !== "ready" || preparing > 0 || !hasContent}>
            <ArrowUp aria-hidden="true" />
          </button> : null}
        </div>
      </div>
      {dragging ? <div className="agent-composer-drop" aria-hidden="true">Drop to attach</div> : null}
    </form>
  );
}

function hasFiles(transfer: DataTransfer | null): boolean {
  return Boolean(transfer && Array.from(transfer.types ?? []).includes("Files"));
}

function isSubmitKeyEvent(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing">,
  composing: boolean,
  compositionEndedAt: number,
): boolean {
  return event.key === "Enter"
    && !event.shiftKey
    && !event.isComposing
    && !composing
    // Safari dispatches the IME-confirming Enter after compositionend.
    && Date.now() - compositionEndedAt > 40;
}
