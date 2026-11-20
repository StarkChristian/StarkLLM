// N49: the settings page that is shown and the tab marked in the list are one value. The page asked for (a click, or
// a page opened directly from elsewhere) is shown when it is in the list; else the first page of the list, which is
// then marked too. Before, a page that was not in the list (the account page after the desktop app's local user was
// known) left the panel empty and marked no tab, and the list and the panel could disagree.
export function shownSection(sectionIds, wanted) {
  const ids = sectionIds || [];
  return ids.includes(wanted) ? wanted : ids[0];
}
