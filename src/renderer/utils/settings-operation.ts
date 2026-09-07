/** Native commands may resolve with a failure envelope instead of rejecting. */
export function requireSettingsSuccess<T>(result: T): T {
  const value = result as any;
  const failure = value?.success === false ? value : value?.data?.success === false ? value.data : null;
  if (failure) throw new Error(failure.error || failure.message || failure.errorCode || 'Settings operation failed');
  return result;
}
