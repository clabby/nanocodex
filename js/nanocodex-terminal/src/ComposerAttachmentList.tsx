"use client";

import { FileText, X } from "lucide-react";
import { formatBytes, type ComposerAttachment } from "./composerAttachments.js";

/** Thumbnail chips for prepared attachments, each with its own remove control. */
export function ComposerAttachmentList({ attachments, preparing, onRemove }: {
  attachments: readonly ComposerAttachment[];
  preparing: number;
  onRemove(id: string): void;
}) {
  if (!attachments.length && !preparing) return null;
  return <ul className="agent-composer-attachments" aria-label="Attachments">
    {attachments.map((attachment) => <li key={attachment.id} className={`agent-composer-chip is-${attachment.kind}`}>
      {attachment.previewUrl
        ? <img src={attachment.previewUrl} alt="" />
        : <span className="agent-composer-chip-icon" aria-hidden="true"><FileText /></span>}
      <span className="agent-composer-chip-text">
        <span className="agent-composer-chip-name" title={attachment.name}>{attachment.name}</span>
        <span className="agent-composer-chip-meta">{attachment.kind === "image" ? "Image" : attachment.kind === "document" ? "PDF" : "Text"} · {formatBytes(attachment.size)}</span>
      </span>
      <button type="button" aria-label={`Remove ${attachment.name}`} title="Remove" onClick={() => onRemove(attachment.id)}>
        <X aria-hidden="true" />
      </button>
    </li>)}
    {preparing ? <li className="agent-composer-chip is-preparing" role="status">
      <span className="agent-composer-chip-icon" aria-hidden="true" />
      <span className="agent-composer-chip-text"><span className="agent-composer-chip-name">Preparing {preparing === 1 ? "file" : `${preparing} files`}…</span></span>
    </li> : null}
  </ul>;
}
