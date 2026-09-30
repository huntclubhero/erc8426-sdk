"use client";

import { useId, useState } from "react";
import type { PassContent, PassField } from "@erc8426/core";

/// A pass as the issuer rendered it, drawn in HTML. This is the same
/// PassContent the Apple and Google providers turn into a .pkpass and a
/// Google Wallet object, so what you see here is what a wallet would show.
export function PassPreview({ content, onLink }: { content: PassContent; onLink?: (key: string, url: string) => void }) {
  const [side, setSide] = useState<"front" | "back">("front");
  const headingId = useId();
  const bg = content.colors?.background ?? "#1f2933";
  const fg = content.colors?.foreground ?? "#ffffff";
  const label = content.colors?.label ?? fg;
  const voided = content.voided || (content.expiresAt ? new Date(content.expiresAt).getTime() < Date.now() : false);

  return (
    <section className="pass-wrap" aria-labelledby={headingId}>
      <div className="pass-toolbar">
        <h3 id={headingId} className="h-small">
          Pass preview
        </h3>
        <div role="group" aria-label="Pass side" className="segmented">
          <button type="button" aria-pressed={side === "front"} onClick={() => setSide("front")}>
            Front
          </button>
          <button type="button" aria-pressed={side === "back"} onClick={() => setSide("back")}>
            Back
          </button>
        </div>
      </div>

      <div className={`pass ${voided ? "pass-voided" : ""}`} style={{ background: bg, color: fg }} data-side={side}>
        {side === "front" ? (
          <>
            <div className="pass-top">
              <span className="pass-org">{content.organizationName}</span>
              <Fields fields={content.header} label={label} align="end" />
            </div>
            <div className="pass-title">{content.title}</div>
            {content.headline ? <div className="pass-headline">{content.headline}</div> : null}
            <Fields fields={content.primary} label={label} size="lg" />
            <Fields fields={content.secondary} label={label} />
            <Fields fields={content.auxiliary} label={label} />
            {content.barcode ? (
              <div className="pass-barcode">
                <span className="pass-barcode-kind">{content.barcode.format.toUpperCase()}</span>
                <code>{content.barcode.message}</code>
                {content.barcode.altText ? <span className="pass-barcode-alt">{content.barcode.altText}</span> : null}
              </div>
            ) : null}
            {voided ? <div className="pass-voided-banner">Superseded or expired</div> : null}
          </>
        ) : (
          <div className="pass-back">
            {(content.back ?? []).map((f) => (
              <div key={f.key} className="pass-back-field">
                <div className="pass-label" style={{ color: label }}>
                  {f.label}
                </div>
                <div className="pass-value-sm">{String(f.value)}</div>
              </div>
            ))}
            {content.links && content.links.length > 0 ? (
              <div className="pass-back-field">
                <div className="pass-label" style={{ color: label }}>
                  Links on this pass
                </div>
                <ul className="pass-links">
                  {content.links.map((l) => (
                    <li key={l.key}>
                      {onLink ? (
                        <button type="button" className="pass-link" onClick={() => onLink(l.key, l.url)}>
                          {l.label}
                        </button>
                      ) : (
                        <span>{l.label}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </div>
      <p className="muted small">
        Serial <code>{content.serial}</code>. The serial is random and carries no holder information.
      </p>
    </section>
  );
}

function Fields({ fields, label, size, align }: { fields?: PassField[]; label: string; size?: "lg"; align?: "end" }) {
  if (!fields || fields.length === 0) return null;
  return (
    <dl className={`pass-fields ${align === "end" ? "pass-fields-end" : ""}`}>
      {fields.map((f) => (
        <div key={f.key} className="pass-field">
          <dt className="pass-label" style={{ color: label }}>
            {f.label}
          </dt>
          <dd className={size === "lg" ? "pass-value-lg" : "pass-value"}>{String(f.value)}</dd>
        </div>
      ))}
    </dl>
  );
}
