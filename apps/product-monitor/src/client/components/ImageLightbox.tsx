import { useCallback, useEffect, useRef } from "react";

export type LightboxImage = { id: string; label: string };

type ImageLightboxProps = {
    images: LightboxImage[];
    index: number;
    onIndexChange(index: number): void;
    onClose(): void;
};

/** Full-screen viewer for one product's images, navigable by arrow keys or buttons. */
export function ImageLightbox({ images, index, onIndexChange, onClose }: ImageLightboxProps) {
    const closeButton = useRef<HTMLButtonElement>(null);
    const total = images.length;
    const current = images[index];

    // Wrapping keeps the arrows usable at either end of a short gallery.
    const step = useCallback((offset: number) => {
        if (total > 1) onIndexChange((index + offset + total) % total);
    }, [index, onIndexChange, total]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
            else if (event.key === "ArrowRight") step(1);
            else if (event.key === "ArrowLeft") step(-1);
            else return;
            event.preventDefault();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [onClose, step]);

    useEffect(() => {
        closeButton.current?.focus();
        const { overflow } = document.body.style;
        document.body.style.overflow = "hidden";
        return () => { document.body.style.overflow = overflow; };
    }, []);

    if (!current) return null;

    return (
        <div
            className="lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={`Ảnh ${index + 1} trên ${total}`}
            onClick={onClose}
        >
            <button
                ref={closeButton}
                className="lightbox__close"
                aria-label="Đóng ảnh"
                onClick={onClose}
            >
                ×
            </button>

            {total > 1 && (
                <button
                    className="lightbox__nav lightbox__nav--previous"
                    aria-label="Ảnh trước"
                    onClick={(event) => { event.stopPropagation(); step(-1); }}
                >
                    ‹
                </button>
            )}

            {/* Stops a click on the image itself from dismissing the dialog. */}
            <figure className="lightbox__figure" onClick={(event) => event.stopPropagation()}>
                <img src={`/api/media/${encodeURIComponent(current.id)}`} alt={current.label} />
                <figcaption>{index + 1} / {total}</figcaption>
            </figure>

            {total > 1 && (
                <button
                    className="lightbox__nav lightbox__nav--next"
                    aria-label="Ảnh sau"
                    onClick={(event) => { event.stopPropagation(); step(1); }}
                >
                    ›
                </button>
            )}
        </div>
    );
}
