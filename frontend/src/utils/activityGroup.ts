export const getActivityGroupLabel = (
  group: string | undefined,
  groupNames: ReadonlyMap<string, string>,
): string | undefined => {
  if (!group) return undefined;

  const smartPrefix = '$smart/';
  if (group.startsWith(smartPrefix)) {
    const groupId = group.slice(smartPrefix.length);
    return `${smartPrefix}${groupNames.get(groupId) || groupId}`;
  }

  return groupNames.get(group) || group;
};
