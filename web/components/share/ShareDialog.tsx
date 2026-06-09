"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Share-to-X dialog with a live preview of the exact card that will be posted.
 *
 * Adapted from Noosphere's share modal: rendered OG-image preview + editable
 * tweet text + character counter + copy-link, instead of a blind "Post on X"
 * jump. The preview image is the page's own og:image (the `/og` card) — read
 * from the document <meta> when not passed explicitly, so every surface shows
 * the right card with zero prop threading.
 */
const MAX = 280;

export default function ShareDialog({
  url,
  subject,
  title,
  previewImage,
  defaultText,
  onClose,
}: {
  url: string;
  /** Short "what am I sharing" label shown under the header (e.g. "Great mind"). */
  subject?: string;
  /** Entity/answer title — seeds the default tweet text. */
  title?: string;
  /** og:image URL; falls back to the page's <meta property="og:image">. */
  previewImage?: string;
  defaultText?: string;
  onClose: () => void;
}) {
  const [text, setText] = useState(
    defaultText ?? (title ? `${title} — on Feynman` : "On Feynman"),
  );
  const [copied, setCopied] = useState(false);
  const [img, setImg] = useState(previewImage || "");
  const [imgLoaded, setImgLoaded] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Derive the preview from the live og:image when not passed in.
  useEffect(() => {
    if (img) return;
    const m = document.querySelector('meta[property="og:image"]') as HTMLMetaElement | null;
    if (m?.content) setImg(m.content);
  }, [img]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    taRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const over = text.length > MAX;

  function tweet() {
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
      text.trim(),
    )}&url=${encodeURIComponent(url)}`;
    window.open(intent, "_blank", "noopener,noreferrer");
    onClose();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div
      className="fy-share-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="fy-share-panel" role="dialog" aria-modal="true" aria-label="Share to X">
        <div className="fy-share-hd">
          <div className="fy-share-hd-text">
            <div className="fy-share-title">Share to X</div>
            {subject ? <div className="fy-share-sub">{subject}</div> : null}
          </div>
          <button className="fy-share-x" onClick={onClose} type="button" aria-label="Close">
            ×
          </button>
        </div>

        <div className="fy-share-body">
          <div className="fy-share-preview">
            {img ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="fy-share-preview-img"
                src={img}
                alt="Card preview"
                onLoad={() => setImgLoaded(true)}
                style={{ opacity: imgLoaded ? 1 : 0 }}
              />
            ) : null}
            {!imgLoaded ? <div className="fy-share-skel">Rendering preview…</div> : null}
          </div>

          <textarea
            ref={taRef}
            className="fy-share-text"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Say something about this…"
          />

          <div className="fy-share-foot">
            <div className="fy-share-url" title={url}>
              {url}
            </div>
            <button className="fy-share-copy" onClick={copy} type="button">
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          <div className={`fy-share-count${over ? " over" : ""}`}>
            {text.length} / {MAX}
          </div>
        </div>

        <div className="fy-share-actions">
          <button className="fy-share-cancel" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="fy-share-go" onClick={tweet} type="button">
            Post on X
          </button>
        </div>
      </div>
    </div>
  );
}
