import { getActivityGroupLabel } from '../../frontend/src/utils/activityGroup';

describe('getActivityGroupLabel', () => {
  const groupNames = new Map([
    ['group-id', 'My Group'],
    ['other-id', 'Other Group'],
  ]);

  it('resolves group IDs to names', () => {
    expect(getActivityGroupLabel('group-id', groupNames)).toBe('My Group');
  });

  it('preserves smart routing while resolving the group ID', () => {
    expect(getActivityGroupLabel('$smart/group-id', groupNames)).toBe('$smart/My Group');
  });

  it('preserves raw names and unresolved routing values', () => {
    expect(getActivityGroupLabel('Existing Name', groupNames)).toBe('Existing Name');
    expect(getActivityGroupLabel('deleted-id', groupNames)).toBe('deleted-id');
    expect(getActivityGroupLabel('$smart/deleted-id', groupNames)).toBe('$smart/deleted-id');
    expect(getActivityGroupLabel('$smart', groupNames)).toBe('$smart');
    expect(getActivityGroupLabel('group-id', new Map())).toBe('group-id');
  });

  it('returns undefined for an absent group', () => {
    expect(getActivityGroupLabel(undefined, groupNames)).toBeUndefined();
    expect(getActivityGroupLabel('', groupNames)).toBeUndefined();
  });
});
