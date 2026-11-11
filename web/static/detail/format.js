// Pure formatting helpers. No DOM.

export function noun(count, one, many = `${one}s`) {
  return count === 1 ? one : many;
}

// --- filament ------------------------------------------------------------------
// Moonraker reports length. Grams come from the slicer's weight/length ratio
// when the file's metadata has one; otherwise it's an estimate for 1.75 mm
// PLA (1.24 g/cm³ ≈ 2.98 g/m), marked as such.

const GRAMS_PER_METRE_PLA_175 = 2.98;

export function filamentGrams(mm, meta) {
  if (meta?.filament_weight_total && meta?.filament_total) {
    return { grams: (mm / meta.filament_total) * meta.filament_weight_total, estimated: false };
  }
  return { grams: (mm / 1000) * GRAMS_PER_METRE_PLA_175, estimated: true };
}

export function filamentText(mm, meta, { totalMm, totalGrams } = {}) {
  const metres = (mm / 1000).toFixed(2);
  const { grams, estimated } = filamentGrams(mm, meta);
  const g = grams >= 100 ? Math.round(grams) : grams.toFixed(1);
  const length = totalMm ? `${metres}/${(totalMm / 1000).toFixed(2)} m` : `${metres} m`;
  const weight = totalGrams ? `${g}/${totalGrams.toFixed(1)} g` : `${estimated ? "~" : ""}${g} g`;
  return `${length} · ${weight}`;
}

// --- time and size ---------------------------------------------------------------

export function duration(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

export function formatWhen(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function formatDate(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function fileSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
