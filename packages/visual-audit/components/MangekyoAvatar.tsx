export function MangekyoAvatar({ size = 34, src = "/mangekyo-logo.png" }: { size?: number; src?: string }) {
  return <span className="mc-avatar" style={{ width: size, height: size, display: "inline-flex", flexShrink: 0, background: "transparent", border: 0, boxShadow: "none" }} aria-hidden="true"><img src={src} width={size} height={size} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }}/></span>;
}
