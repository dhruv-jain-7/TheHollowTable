/** PostgreSQL connection hardening for Supabase and local development. */

function removeUrlSslOverrides(connectionString) {
  if (!connectionString) return connectionString;
  try {
    const url = new URL(connectionString);
    // node-postgres documents that SSL query parameters in the URL can replace
    // the explicit `ssl` object. Remove them so verification cannot be weakened
    // by a copied `sslmode=require` URL.
    for (const parameter of ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert']) {
      url.searchParams.delete(parameter);
    }
    return url.toString();
  } catch {
    throw new Error('DATABASE_URL is not a valid PostgreSQL connection URL.');
  }
}

export function getDatabaseConnectionOptions(env = process.env) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) return { connectionString: undefined, ssl: false };
  if (String(env.DATABASE_SSL || '').toLowerCase() === 'disable') {
    return { connectionString: removeUrlSslOverrides(connectionString), ssl: false };
  }

  const rawCa = env.DATABASE_SSL_CA || '';
  const base64Ca = env.DATABASE_SSL_CA_BASE64 || '';
  const ca = rawCa
    ? rawCa.replace(/\\n/g, '\n')
    : base64Ca ? Buffer.from(base64Ca, 'base64').toString('utf8') : undefined;

  // With no custom CA, Node's trusted root store is used. Verification is on
  // by default; DATABASE_SSL=disable is intended only for local development.
  return {
    connectionString: removeUrlSslOverrides(connectionString),
    ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true },
  };
}
