export function isPrivateAssetPath(filePath: string): boolean {
  return filePath.replace(/\\/g, '/').split('/').some((segment) =>
    /^\.(?:aistudio|git|env(?:\..*)?|npmrc|yarnrc\.yml)$/i.test(segment) ||
    /^aistudio$/i.test(segment) ||
    /\.(?:db|sqlite3?)(?:-(?:wal|shm|journal))?$/i.test(segment) ||
    /\.(?:key|pem|p12|pfx|map)$/i.test(segment),
  );
}
