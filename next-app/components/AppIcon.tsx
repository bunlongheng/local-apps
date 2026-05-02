"use client";

import { useEffect, useState } from "react";

const AVATAR_COLORS = [
  ["#3b82f6", "#fff"],
  ["#8b5cf6", "#fff"],
  ["#ec4899", "#fff"],
  ["#f59e0b", "#000"],
  ["#10b981", "#fff"],
  ["#ef4444", "#fff"],
  ["#06b6d4", "#fff"],
  ["#f97316", "#fff"],
];

function avatarColor(id: string): [string, string] {
  let h = 0;
  for (const c of id) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length] as [string, string];
}

// Global favicon cache — loaded once, shared by all AppIcon instances
let _faviconCache: Record<string, string> | null = null;
let _faviconPromise: Promise<void> | null = null;

function loadFavicons(): Promise<void> {
  if (_faviconPromise) return _faviconPromise;
  _faviconPromise = fetch("/api/favicons")
    .then((r) => r.json())
    .then((m) => { _faviconCache = m; })
    .catch(() => { _faviconCache = {}; });
  return _faviconPromise;
}

interface AppIconProps {
  id: string;
  name: string;
  icon?: string | null;
  size?: number;
}

export default function AppIcon({ id, name, icon, size = 32 }: AppIconProps) {
  const [bg, fg] = avatarColor(id);
  const letter = (name || id).charAt(0).toUpperCase();
  const [resolvedIcon, setResolvedIcon] = useState<string | null>(icon || null);

  // Resolve icon: prop → favicon cache → letter avatar
  useEffect(() => {
    if (icon) {
      setResolvedIcon(icon);
      return;
    }
    if (_faviconCache) {
      setResolvedIcon(_faviconCache[id] || null);
      return;
    }
    loadFavicons().then(() => {
      setResolvedIcon(_faviconCache?.[id] || null);
    });
  }, [id, icon]);

  if (resolvedIcon) {
    return (
      <img
        src={resolvedIcon}
        width={size}
        height={size}
        alt={name}
        style={{ borderRadius: Math.round(size / 5), objectFit: "contain", flexShrink: 0 }}
        onError={(e) => {
          e.currentTarget.style.display = "none";
          setResolvedIcon(null);
        }}
      />
    );
  }

  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 5),
        background: bg,
        color: fg,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.44),
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {letter}
    </span>
  );
}
