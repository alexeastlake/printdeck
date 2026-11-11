// Plumbing the Files and History sections share: a status line, the "Show N"
// select, the "Showing X of Y" line, and checkbox selection with bulk delete.

import { noun } from "./format.js";

export function statusLine(el, errorClass) {
  return (text, isError = false) => {
    el.textContent = text;
    el.hidden = !text;
    el.classList.toggle(errorClass, isError);
  };
}

// Per-section row cap, remembered per browser. "all" -> Infinity. Returns a getter.
export function wirePageSize(select, storageKey, onChange) {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored && [...select.options].some((o) => o.value === stored)) select.value = stored;
  } catch { /* no storage */ }
  const read = () => (select.value === "all" ? Infinity : Number(select.value));
  let value = read();
  select.addEventListener("change", () => {
    value = read();
    try { localStorage.setItem(storageKey, select.value); } catch { /* no storage */ }
    onChange(value);
  });
  return () => value;
}

export function showingText(shown, total, one, many) {
  return `Showing ${shown} of ${total} ${noun(total, one, many)}`;
}

// Checkbox selection for bulk delete. Select-all covers the rows currently
// shown (`visibleKeys()`), never ones held back by paging or a filter.
// Deletes run one at a time; printers don't take kindly to a burst.
//
//   onSelectAll()        re-render rows so their boxes match
//   confirm(n)           resolves true to go ahead
//   deleteOne(key)       throws on failure
//   afterDelete()        refresh whatever the deletes changed
//   setStatus, what      progress/failure line, and [singular, plural] nouns
export function createSelection({
  selectAll, bar, count, deleteBtn, visibleKeys, onSelectAll, confirm, deleteOne, afterDelete, setStatus, what,
}) {
  const [one, many] = what;
  const selected = new Set();

  function sync() {
    bar.hidden = selected.size === 0;
    count.textContent = `${selected.size} selected`;
    const keys = visibleKeys();
    const picked = keys.filter((key) => selected.has(key)).length;
    selectAll.checked = keys.length > 0 && picked === keys.length;
    selectAll.indeterminate = picked > 0 && picked < keys.length;
  }

  selectAll.addEventListener("change", () => {
    for (const key of visibleKeys()) {
      if (selectAll.checked) selected.add(key);
      else selected.delete(key);
    }
    onSelectAll();
    sync();
  });

  deleteBtn.addEventListener("click", async () => {
    const keys = [...selected];
    if (keys.length === 0 || !(await confirm(keys.length))) return;
    deleteBtn.disabled = true;
    setStatus(`Deleting ${keys.length} ${noun(keys.length, one, many)}…`);
    let failed = 0;
    try {
      for (const key of keys) {
        try {
          await deleteOne(key);
        } catch {
          failed++;
        }
      }
      selected.clear();
      sync();
      await afterDelete();
      setStatus(failed ? `${keys.length - failed} of ${keys.length} deleted, ${failed} failed.` : "", Boolean(failed));
    } finally {
      deleteBtn.disabled = false;
    }
  });

  return {
    sync,
    clear() { selected.clear(); sync(); },
    remove(key) { selected.delete(key); sync(); },
    // Ties a row's checkbox to the selection.
    bind(checkbox, key) {
      checkbox.checked = selected.has(key);
      checkbox.addEventListener("click", (event) => event.stopPropagation());
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(key);
        else selected.delete(key);
        sync();
      });
    },
  };
}
